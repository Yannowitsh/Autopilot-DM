// Autopilot-DM — content script : constantes, état partagé, contexte, DOM, vérification de présence, boss auto.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

const TICK_MS = 500;
const ENERGY_POLL_MS = 2 * 60000;   // vérification de l'énergie pendant une pause
const WATCHDOG_MS = 2 * 60000;      // rien ne bouge depuis 2 min → retour à /aventure
const MAX_PATH_RETRIES = 5;         // aventure : nouveaux essais après une défaite avant arrêt + alerte Discord

let cfg = { ...DM.DEFAULTS };
let myTabId = null;
let busy = false;
let lastProgress = Date.now();
let lastEnergyCheck = 0;
let lastAutoClick = 0;
let endRetries = 0;   // clics de relance sur le même écran de fin
let ticker = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const humanDelay = () => (cfg.delayMin + Math.random() * Math.max(0, cfg.delayMax - cfg.delayMin)) * 1000;
// Délai avant de relancer depuis l'écran de fin : en combat rapide, juste ce qu'il faut pour respecter
// fastFightMinSec depuis le lancement précédent (+ un petit aléa) ; sinon le délai « humain » habituel.
// Combat rapide désactivé (1.63.3) : le serveur impose désormais la durée des combats, recharger ne fait rien gagner.
const FAST_FIGHT_ENABLED = false;
const fastFight = () => FAST_FIGHT_ENABLED && !!cfg.fastFight;
const relaunchDelay = () => (fastFight()
  ? Math.max(0, (+cfg.fastFightMinSec || 0) * 1000 - (Date.now() - (cfg.lastLaunchAt || 0))) + 300 + Math.random() * 700
  : humanDelay());
// ---------- Extension rechargée pendant que l'onglet reste ouvert ----------
// Ce script devient « orphelin » : tout appel chrome.* lève « Extension context invalidated ».
// On le détecte et on s'arrête proprement (plus d'erreurs, plus d'interface fantôme) ; la page rechargée repart à neuf.
let dead = false;
const contextAlive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
const isInvalidated = (e) => /Extension context invalidated/i.test(e?.message || String(e || ''));
const send = (msg) => {
  if (!contextAlive()) { shutdown(); return Promise.reject(new Error('extension rechargée : recharge la page')); }
  return chrome.runtime.sendMessage(msg);
};
const save = (o) => {
  Object.assign(cfg, o);
  if (!contextAlive()) { shutdown(); return Promise.resolve(); }
  return chrome.storage.local.set(o);
};
function shutdown() {
  if (dead) return;
  dead = true;
  const quiet = (f) => { try { f(); } catch { /* pas encore initialisé */ } };
  quiet(() => clearInterval(ticker));
  quiet(() => clearInterval(aliveTimer));
  quiet(() => clearInterval(eqTimer));
  quiet(() => clearInterval(lockTimer));
  quiet(() => eqAsk?.host.remove());
  quiet(() => domObserver.disconnect());
  quiet(() => ui?.host.remove());
  quiet(() => queueBox?.remove());
  quiet(() => toastEl?.remove());
  quiet(() => cardStack?.host.remove());
  quiet(() => document.querySelectorAll('.dm-deck-weights, .dm-fuse-all, .dm-unequip-all, .dm-cancel-all, .dm-manual-weights').forEach((el) => el.remove()));
  document.querySelectorAll('.dm-trade, .dm-lock, .dm-picker, .dm-tip, .dm-tip-style').forEach((el) => el.remove());
  console.info('[Autopilot-DM] Extension rechargée : recharge la page pour la réactiver.');
}
window.addEventListener('error', (e) => { if (isInvalidated(e.error || e.message)) { e.preventDefault(); shutdown(); } });
window.addEventListener('unhandledrejection', (e) => { if (isInvalidated(e.reason)) { e.preventDefault(); shutdown(); } });
const aliveTimer = setInterval(() => { if (!contextAlive()) shutdown(); }, 2000);
// kind : type de notification (DM.NOTIF), filtré selon les réglages par le service worker
const notify = (kind, text, embeds) => send({ type: 'discord', kind, text, embeds }).catch(() => {});
const progress = () => { lastProgress = Date.now(); };
const setStatus = (status, paused = false) => {
  if (cfg.status !== status || !!cfg.paused !== paused) save({ status, paused });
};
const isOwner = () => cfg.enabled && myTabId != null && cfg.ownerTabId === myTabId;
const modOn = (k) => DM.modOn(cfg, k);   // module activé dans la popup de l'extension
// Ascension : moteur choisi par étage (cfg.ascUseOurs, cf. ascPickEngine) ; ailleurs, réglage « Auto par poids »
const weightsOn = () => (cfg.mode === 'ascension' ? cfg.ascUseOurs === true : cfg.fightEngine === 'weights' && modOn('weights'));

// ---------- DOM ----------
const visibleButtons = () => [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
const findBtn = (re) => visibleButtons().find((b) => !b.disabled && re.test(b.textContent.trim()));
const endTitle = () => [...document.querySelectorAll('h2')].map((h) => h.textContent.trim()).find((t) => /^(Victoire|Défaite)/.test(t));
// Boutons de fin de combat propres au Chemin (aventure)
const NEXT_STAGE = /^(Étape suivante|Réessayer l.étape|Suivant en auto|Continuer en (mode )?auto|Réessayer en auto)$/i;
const AUTO_NEXT = /^(Suivant en auto|Continuer en (mode )?auto)$/i;   // étape suivante en Auto (récompenses entières)
const SEMI_AUTO = /^Auto$/;              // jamais « Auto AFK −50 % » ni « Fuir »
// Boutons de fin de combat de chasse (« Suivant en auto » y relance aussi le même groupe en Auto)
const HUNT_RETRY = /^(Refaire ce combat|Réessayer ce groupe)$/;
const isHunt = () => cfg.mode === 'chasse' && !!cfg.huntZone;
const isAsc = () => cfg.mode === 'ascension';
const maxRetries = () => (isHunt() ? (cfg.dropRun?.active ? DROP_MAX_DEFEATS - 1 : cfg.sampleRun?.active ? SAMPLE_MAX_DEFEATS - 1 : cfg.levelRun?.active ? LEVEL_MAX_DEFEATS : Math.max(0, Math.round(+cfg.huntRetries || 0))) : MAX_PATH_RETRIES);
// Fin d'un combat d'Ascension : boutons propres aux étages (« Suivant en auto » / « Réessayer en auto » existent aussi).
const ASC_END = /^(Étage suivant|Réessayer l.étage|Voir l.Ascension)$/;
const ASC_START = /^Affronter l.étage \d+$/;   // bouton de /ascension
const home = () => DM.homePath(cfg);
const onHome = () => location.pathname + location.search === home()
  || (isAsc() ? location.pathname.startsWith('/ascension') : !isHunt() && location.pathname.startsWith('/aventure'));
// Fin d'un combat de chasse : le jeu affiche le lien « Autres groupes de la zone ».
const huntEnd = () => [...document.querySelectorAll('a')].some((a) => /Autres groupes de la zone/.test(a.textContent));

const groupNumber = (panel) => +(panel?.querySelector('.title')?.textContent.trim().match(/^Groupe\s*(\d+)$/)?.[1] || 0);
// Carte d'un groupe de chasse : « .panel » avant la v2 du site, carte « pageKit…__card » (classe CSS module) depuis.
const GROUP_CARD = '.panel, [class*="__card"]';
const groupCardOf = (el) => el?.closest?.(GROUP_CARD) || null;
// Cartes « Groupe N » de la page (ou d'un document parsé), repérées par leur titre.
const groupCards = (root = document) => [...root.querySelectorAll('.title')]
  .filter((t) => /^Groupe\s*\d+$/.test(t.textContent.trim())).map(groupCardOf).filter((p) => p && groupNumber(p));

// Panneau du groupe visé sur /chasse?zone=… : celui choisi à la main (cfg.huntGroup),
// sinon le plus dur (« Groupe 3 », ou le numéro le plus élevé).
function targetGroup() {
  let best = null, bestN = -1;
  for (const p of groupCards()) {
    const n = groupNumber(p);
    if (cfg.huntGroup && n === cfg.huntGroup) return p;
    if (n > bestN) { best = p; bestN = n; }
  }
  return best;
}

// Composition d'un groupe (noms des monstres, triés) : sert à voir si les groupes ont été renouvelés (~3 min).
const groupMonsters = (panel) => [...panel?.querySelectorAll('li') || []]
  .map((li) => li.querySelector('.font-bold')?.textContent.trim()).filter(Boolean).sort();
// Mémorise le groupe attaqué (cfg.huntTarget) ; comparé avant chaque attaque (groupe renouvelé ?).
const rememberHuntTarget = (panel) => {
  const monsters = groupMonsters(panel);
  if (monsters.length) save({ huntTarget: { zone: cfg.huntZone, group: groupNumber(panel), monsters } });
};

// Choix manuel : quand TU cliques sur « Attaquer » dans une zone de chasse, ce groupe devient la cible du pilote
// (mode chasse). Les clics du pilote (.click()) ne sont pas « isTrusted » : ils ne sont pas pris en compte ici.
document.addEventListener('click', (e) => {
  if (!e.isTrusted || !location.pathname.startsWith('/chasse')) return;
  const b = e.target.closest?.('button');
  if (!b || b.disabled || !/^Attaquer$/.test(b.textContent.trim())) return;
  const zone = +new URLSearchParams(location.search).get('zone');
  const group = groupNumber(groupCardOf(b));
  if (!zone || !group) return;
  const name = document.querySelector('h1')?.textContent.trim() || cfg.huntZoneName;
  const monsters = groupMonsters(groupCardOf(b));
  const o = { mode: 'chasse', huntZone: zone, huntZoneName: name, huntGroup: group, huntTarget: { zone, group, monsters } };
  if (isOwner()) {   // le pilote prend la main : Auto puis relance en boucle
    Object.assign(o, { botFight: true, pauseReason: null });
    lastAutoClick = 0;
    markLaunch();
  }
  save(o);
}, true);

// ---------- Vérification de présence (anti-bot « Es-tu toujours là ? ») ----------
// Pendant le mode Auto, le serveur peut demander de cliquer sur un chiffre affiché.
// La modale : role="dialog" aria-label="Vérification de présence", titre « Es-tu toujours là ? »,
// le chiffre cible dans un <strong class="text-gold">, les options dans des <button> (grille).
const presenceDialog = () =>
  document.querySelector('[role="dialog"][aria-label="Vérification de présence"]') ||
  [...document.querySelectorAll('[role="dialog"]')].find((d) => /Es-tu toujours là/i.test(d.textContent));

async function solvePresence(dlg) {
  const target = dlg.querySelector('strong.text-gold, strong')?.textContent.trim();
  if (!target || !/^\d+$/.test(target)) return false;
  const btn = [...dlg.querySelectorAll('button')]
    .find((b) => !b.disabled && b.offsetParent !== null && b.textContent.trim() === target);
  if (!btn) return false;
  await sleep(700 + Math.random() * 1600);   // petit délai « humain » avant de cliquer
  if (!isOwner() || dlg !== presenceDialog()) return false;  // dialogue fermé entre-temps
  btn.click();
  progress();
  lastAutoClick = Date.now();   // laisse l'animation/combat reprendre sans re-clic Auto immédiat
  presenceAt = Date.now();      // si le combat ne repart pas, l'anti-blocage recharge la page
  return true;
}

// ---------- Boss de chasse automatique (onglet ouvert par le service worker) ----------
// Sur /chasse, la section « boss de zone » contient le bouton du boss quand il est présent (un seul essai).
const loadedAt = Date.now();
let bossClickedAt = 0;
const inBossTab = () => cfg.bossRun?.phase === 'fighting' && myTabId != null && cfg.bossRun.bossTabId === myTabId;
const bossSection = () => [...document.querySelectorAll('section')].find((s) => /boss de zone/i.test(s.textContent));

async function bossLaunch() {
  progress();
  if (location.pathname !== '/chasse' || location.search) { location.assign('/chasse'); return; }
  const waited = Date.now() - loadedAt;
  if (bossClickedAt) {   // déjà cliqué : on attend l'arrivée sur /combat, sinon le lancement a échoué
    if (Date.now() - bossClickedAt > 30000) return bossDone('lancement sans réponse');
    return;
  }
  const sec = bossSection();
  const btn = sec && [...sec.querySelectorAll('button')].find((b) => b.offsetParent !== null);
  if (!btn) {
    if (waited > 25000) return bossDone(sec && /Arrive dans/.test(sec.textContent) ? 'pas encore là / déjà parti' : 'bouton du boss introuvable');
    return setStatus('Boss de chasse : attente du bouton…');
  }
  if (btn.disabled) {
    if (/Lancement/.test(btn.textContent)) return;
    if (waited > 15000) return bossDone(`indisponible (${btn.textContent.trim()})`);
    return;
  }
  setStatus(`Boss de chasse : attaque (${btn.textContent.trim()})…`);
  await sleep(800 + Math.random() * 1200);
  if (!inBossTab() || bossClickedAt || btn.disabled) return;
  await save({ botFight: true });
  bossClickedAt = Date.now();
  lastAutoClick = 0;   // le combat démarre en manuel : le mode Auto sera activé au tick suivant
  markLaunch();
  btn.click();
}

let bossDoneSent = false;
async function bossDone(result) {
  if (bossDoneSent) return;
  bossDoneSent = true;
  setStatus(`Boss : ${result} — retour au farm…`);
  await send({ type: 'bossDone', result }).catch(() => {});
}
