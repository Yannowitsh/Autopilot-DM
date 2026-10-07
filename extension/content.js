(() => {
  if (window.__dmPilot) return;
  window.__dmPilot = true;

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
    quiet(() => eqAsk?.host.remove());
    quiet(() => domObserver.disconnect());
    quiet(() => ui?.host.remove());
    quiet(() => queueBox?.remove());
    quiet(() => toastEl?.remove());
    quiet(() => cardStack?.host.remove());
    quiet(() => document.querySelectorAll('.dm-deck-weights, .dm-fuse-all, .dm-unequip-all, .dm-manual-weights').forEach((el) => el.remove()));
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
  const weightsOn = () => cfg.fightEngine === 'weights' && modOn('weights');

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
  const maxRetries = () => (isHunt() ? (cfg.dropRun?.active ? DROP_MAX_DEFEATS - 1 : Math.max(0, Math.round(+cfg.huntRetries || 0))) : MAX_PATH_RETRIES);
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

  // ---------- Énergie ----------
  // Compteur interne : cfg.energy est lu une fois, puis décompté à chaque combat lancé (spendEnergy).
  // 1) lue directement sur la page affichée quand elle l'indique (aventure, zone de chasse) : aucune requête ;
  // 2) sinon le compteur, tant qu'il reste loin des seuils (pause / achat auto) et date de moins de ENERGY_RESYNC_MS ;
  // 3) sinon chargement de /jeu. L'énergie se régénère avec le temps : le compteur ne peut que la sous-estimer.
  // Le site (hébergement mutualisé) renvoie des 508/503 quand il sature : si le compteur est loin des seuils on
  // continue avec lui, sinon on réessaie vite (5 s, 10 s, 20 s… 1 min max).
  const ENERGY_RESYNC_MS = 30 * 60000;
  const ENERGY_MARGIN = 3;                  // relecture quelques combats avant le seuil
  const FAIL_ALERT_AFTER_MS = 10 * 60000;   // alerte Discord seulement si l'échec dure 10 min…
  const FAIL_ALERT_EVERY_MS = 60 * 60000;   // …et au plus une fois par heure
  let energyFails = 0, energyFailSince = 0, nextEnergyTry = 0, lastEnergyError = '';
  const minEnergy = () => Math.max(cfg.minEnergy, 2);   // 2 = coût max d'une étape (boss d'étape)
  // En dessous de ce niveau, le compteur ne suffit plus : on relit la vraie valeur (pause ou achat à décider).
  const energySyncBelow = () => Math.max(minEnergy(), cfg.autoBuyEnergy ? BUY_AT : 0) + ENERGY_MARGIN;
  const counterUsable = () => cfg.energy != null && cfg.energy > energySyncBelow();

  function energyFromPage() {
    const t = document.body?.textContent || '';
    let m = t.match(/Énergie\s*:\s*(\d+)\s*\/\s*(\d+)/);           // /chasse?zone=… « Énergie : 98/100 »
    if (m) return { energy: +m[1], energyMax: +m[2] };
    m = t.match(/coût\s*\d+\s*énergie\s*\(tu en as\s*(\d+)\)/i);   // /aventure « coût 1 énergie (tu en as 76) »
    if (m) return { energy: +m[1], energyMax: cfg.energyMax || 100 };
    return null;
  }

  // Renvoie l'énergie, ou { error } si elle n'a pas pu être lue.
  async function readEnergy({ fresh = false } = {}) {
    const onPage = !fresh && energyFromPage();   // en pause, la page peut être figée depuis longtemps : on relit /jeu
    if (onPage) { lastEnergyCheck = Date.now(); await save({ ...onPage, energyAt: Date.now() }); return onPage.energy; }
    if (!fresh && counterUsable() && Date.now() - (cfg.energyAt || 0) < ENERGY_RESYNC_MS) return cfg.energy;
    if (Date.now() < nextEnergyTry) return { error: lastEnergyError, wait: true };   // dernier essai trop récent
    lastEnergyCheck = Date.now();
    try {
      const r = await DM.fetchT('/jeu', { credentials: 'same-origin', cache: 'no-store' });
      if (r.redirected && /connexion/.test(r.url)) return { error: 'déconnecté', fatal: true };
      if (!r.ok) return { error: r.status === 508 || r.status === 503 ? `site saturé (HTTP ${r.status})` : `HTTP ${r.status}` };
      const html = await r.text();
      // v2 du site : compteur RegenValue, props « "regen":{"value":N,"max":M,…,"periodSec":360} » dans le payload
      // (la page en a d'autres, ex. les coffres : periodSec 1200) ; sinon le texte affiché
      const m = html.replace(/\\"/g, '"').match(/"regen":\{"value":(\d+),"max":(\d+),"nextAt":[^,]*,"periodSec":360\}/)
        || new DOMParser().parseFromString(html, 'text/html').body.textContent.match(/Énergie\s*(\d+)\s*\/\s*(\d+)/);
      if (!m) return { error: 'énergie introuvable sur /jeu' };
      await save({ energy: +m[1], energyMax: +m[2], energyAt: Date.now() });
      return +m[1];
    } catch (e) {
      return { error: 'réseau' };
    }
  }

  // ---------- Achat d'énergie automatique ----------
  // L'onglet du pilote demande l'achat au service worker, qui ouvre /jeu?dmBuy=1 dans un onglet à part (v2 du site : le widget d'achat est sur /jeu).
  // Cet onglet clique les boutons du widget « Acheter (… K le point, encore N aujourd'hui) » (+1 / +10 / +N (max)),
  // puis rend compte ; le service worker le ferme, lève la pause et recharge l'onglet du pilote sur sa page d'accueil.
  // Prix (constantes ENERGY du site) : 300 K le point jusqu'au 600e acheté dans la journée,
  // puis de plus en plus cher jusqu'à 2 000 K au 1 000e (plafond quotidien).
  const ENERGY_BUY = { max: 100, price: 300, daily: 1000, rampFrom: 600, topPrice: 2000 };
  const BUY_AT = 20;                 // achat auto : on remplit dès que l'énergie descend à ce niveau
  const BUY_RETRY_MS = 10 * 60000;   // au plus une demande toutes les 10 min (prix trop haut, kamas, échec…)
  // Prix du k-ième point acheté aujourd'hui (energyPointPrice du site).
  const pointPrice = (k) => k < ENERGY_BUY.rampFrom ? ENERGY_BUY.price
    : Math.round(ENERGY_BUY.price + (ENERGY_BUY.topPrice - ENERGY_BUY.price)
      * Math.min(1, (k - ENERGY_BUY.rampFrom) / Math.max(1, ENERGY_BUY.daily - ENERGY_BUY.rampFrom)));

  // Onglet du pilote : demande un achat (si activé et pas déjà en cours). true si un achat est en cours.
  async function requestBuy() {
    if (!cfg.autoBuyEnergy) return false;
    if (cfg.energyBuy && Date.now() - cfg.energyBuy.at < 3 * 60000) return true;
    if (Date.now() < (cfg.buyNextTry || 0)) return false;
    await save({ buyNextTry: Date.now() + BUY_RETRY_MS });
    const ok = !!(await send({ type: 'buyEnergy' }).catch((e) => DM.log('achat: message buyEnergy échoué', e.message)));
    DM.log(`achat: demande envoyée (énergie ${cfg.energy}, onglet ${myTabId}) → ${ok ? 'onglet d’achat ouvert' : 'refusée'}`);
    return ok;
  }

  // Combien acheter : jusqu'au max, quel que soit le prix (limité au plafond du jour et aux kamas disponibles).
  function planBuy({ energy, kamas, left }) {
    const max = cfg.energyMax || ENERGY_BUY.max;
    const bought = ENERGY_BUY.daily - left;
    let n = 0, cost = 0;
    while (n < Math.min(max - energy, left)) {
      const p = pointPrice(bought + n + 1);
      if (cost + p > kamas) break;
      cost += p;
      n++;
    }
    if (n) return { n, cost, max };
    return { n: 0, max, why: !left ? 'plafond quotidien atteint' : energy >= max ? 'énergie déjà au max' : 'pas assez de kamas' };
  }

  async function waitFor(fn, ms) {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(250)) {
      const v = fn();
      if (v != null && v !== false) return v;
    }
    return null;
  }

  // Onglet d'achat (/jeu?dmBuy=1) : achète puis rend compte au service worker (« buyDone »).
  async function runBuyTab() {
    if (!location.pathname.startsWith('/jeu') || !new URLSearchParams(location.search).has('dmBuy')) return;
    const done = (res) => {
      DM.log('achat[onglet]: fin', res);
      return send({ type: 'buyDone', ...res }).catch(() => {});
    };
    DM.log(`achat[onglet]: démarrage (onglet ${myTabId}, énergie max ${cfg.energyMax})`);
    const leftText = () => +(document.body.textContent.match(/encore\s+(\d+)\s+aujourd/)?.[1] ?? -1);
    const buyBtns = () => [...document.querySelectorAll('button')]
      .filter((b) => b.offsetParent !== null && !b.disabled && /^\+\d+/.test(b.textContent.trim()))
      .map((b) => ({ b, k: +b.textContent.trim().match(/^\+(\d+)/)[1] }));
    try {
      const { flight } = await fetchFlight('/jeu');
      const m = flight.match(/"energy":(\d+),"kamas":(\d+),"left":(\d+)/);
      if (!m) throw new Error('widget d’achat introuvable sur /jeu');
      const props = { energy: +m[1], kamas: +m[2], left: +m[3] };
      const plan = planBuy(props);
      DM.log('achat[onglet]: état', props, 'plan', plan);
      if (!plan.n) return done({ ok: false, soft: true, error: plan.why });
      if (!(await waitFor(() => buyBtns().length, 20000))) {
        const all = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim().slice(0, 40));
        DM.log('achat[onglet]: boutons visibles', all, 'texte widget', document.body.textContent.match(/Acheter[^:]{0,80}/)?.[0] || '(absent)');
        throw new Error('boutons d’achat introuvables');
      }

      let remaining = plan.n;
      while (remaining > 0) {
        const btns = buyBtns();
        // bouton exact (souvent « +N (max) »), sinon +10, sinon +1
        const pick = btns.find((x) => x.k === remaining) || btns.filter((x) => x.k <= remaining).sort((a, b) => b.k - a.k)[0];
        if (!pick) throw new Error('aucun bouton d’achat utilisable');
        const before = leftText();
        await sleep(400 + Math.random() * 500);
        DM.log(`achat[onglet]: clic « ${pick.b.textContent.trim()} » (reste ${remaining}, compteur ${before}) parmi`, btns.map((x) => x.k));
        pick.b.click();
        // le widget se met à jour (« encore N aujourd'hui » baisse, ou disparaît à l'énergie max)
        if (!(await waitFor(() => leftText() !== before, 20000))) {
          const msg = [...document.querySelectorAll('p')].map((p) => p.textContent.trim()).find((t) => /énergie|kamas|achat|erreur/i.test(t) && t.length < 150);
          DM.log('achat[onglet]: pas de mise à jour du compteur', { compteur: leftText(), message: msg || null });
          throw new Error(`le site n’a pas confirmé l’achat${msg ? ` (${msg})` : ''}`);
        }
        DM.log(`achat[onglet]: compteur ${before} → ${leftText()}`);
        remaining -= pick.k;
      }
      done({ ok: true, n: plan.n, cost: plan.cost, energy: props.energy + plan.n, max: plan.max, kamas: props.kamas - plan.cost });
    } catch (err) {
      done({ ok: false, error: err.message });
    }
  }

  // Un combat vient d'être lancé : on décompte le compteur interne (2 pour un boss d'étape).
  const spendEnergy = (cost = 1) => { if (cfg.energy != null) save({ energy: Math.max(0, cfg.energy - cost) }); };

  // ---------- Conditions pour lancer un combat ----------
  async function gate() {
    const now = Date.now();

    if (cfg.pauseReason === 'energy' && !energyFails && now - lastEnergyCheck < ENERGY_POLL_MS) return false;

    let e = await readEnergy({ fresh: cfg.pauseReason === 'energy' });
    const readOk = typeof e === 'number';
    if (typeof e !== 'number' && cfg.pauseReason !== 'energy' && counterUsable()) {
      // lecture impossible mais le compteur est loin des seuils : on continue avec lui (relecture plus tard)
      if (!e.wait) DM.log(`énergie : lecture impossible (${e.error}), compteur interne utilisé (${cfg.energy})`);
      if (!e.wait) nextEnergyTry = now + 60000;
      e = cfg.energy;
    }
    if (typeof e !== 'number') {
      const secs = () => Math.max(1, Math.round((nextEnergyTry - Date.now()) / 1000));
      if (e.wait) {
        setStatus(`Énergie illisible (${lastEnergyError}) — nouvel essai dans ${secs()} s`, true);
        return false;
      }
      energyFails++;
      if (!energyFailSince) energyFailSince = now;
      lastEnergyError = e.error;
      // 5 s, 10 s, 20 s, 40 s, puis 1 min entre deux essais
      nextEnergyTry = now + Math.min(60000, 5000 * 2 ** (energyFails - 1));
      setStatus(`Énergie illisible (${e.error}) — nouvel essai dans ${secs()} s`, true);
      const lasting = now - energyFailSince >= FAIL_ALERT_AFTER_MS;
      if ((e.fatal || lasting) && now - (cfg.readFailAlertAt || 0) >= FAIL_ALERT_EVERY_MS) {
        save({ readFailAlertAt: now });
        notify('errors', e.fatal
          ? '🔒 Énergie illisible : session DofusMasters expirée ? Le pilote attend.'
          : `⚠️ Énergie illisible depuis ${Math.round((now - energyFailSince) / 60000)} min (${e.error}). Le pilote réessaie tout seul.`);
      }
      return false;
    }
    if (readOk) {
      energyFails = 0;
      energyFailSince = 0;
      nextEnergyTry = 0;
    }

    // Achat auto : dès BUY_AT ou moins, on remplit au max sans attendre la pause (le farm attend juste la fin de l'achat).
    if (cfg.autoBuyEnergy && cfg.pauseReason !== 'energy' && e <= BUY_AT && e < (cfg.energyMax || ENERGY_BUY.max)
      && await requestBuy()) {
      setStatus(`Énergie ${e} — rachat au max en cours (autre onglet)…`, true);
      return false;
    }

    const minE = minEnergy();
    const resumeE = Math.max(cfg.resumeEnergy, minE);

    if (cfg.pauseReason === 'energy') {
      if (e < resumeE) {
        const buying = await requestBuy();   // achat auto (si activé) : l'onglet sera relancé une fois l'achat validé
        setStatus(buying ? `Pause énergie : ${e} — achat d’énergie en cours (autre onglet)…` : `Pause énergie : ${e} (reprise à ${resumeE})`, true);
        return false;
      }
      await save({ pauseReason: null });
      notify('energy', `▶️ Énergie remontée à ${e} : le pilote auto reprend.`);
    } else if (e < minE) {
      DM.log(`énergie basse : ${e} < ${minE} (achat auto ${cfg.autoBuyEnergy ? 'activé' : 'désactivé'})`);
      await save({ pauseReason: 'energy' });
      const buying = await requestBuy();
      setStatus(buying ? `Énergie basse (${e}) — achat d’énergie en cours (autre onglet)…` : `Pause énergie : ${e} (reprise à ${resumeE})`, true);
      if (!buying) notify('energy', `🔋 Énergie basse (**${e}**). Pilote auto en pause, reprise automatique à ${resumeE}.`);
      return false;
    }
    return true;
  }

  // ---------- Boucle ----------
  async function step() {
    const path = location.pathname;

    // Priorité absolue : répondre à la vérification de présence si elle est affichée.
    const dlg = presenceDialog();
    if (dlg) {
      const ok = await solvePresence(dlg);
      setStatus(ok ? 'Vérification de présence résolue ✔' : 'Vérification de présence — en attente…');
      return progress();
    }

    if (path.startsWith('/connexion')) {
      await save({ enabled: false, paused: false, status: 'Arrêté : déconnecté' });
      notify('errors', '🔒 Déconnecté de DofusMasters : pilote auto arrêté.');
      return;
    }

    // Boss de chasse : cet onglet est celui du boss → un seul essai, puis retour au farm.
    if (inBossTab()) {
      if (!path.startsWith('/combat')) return bossLaunch();
      const end = endTitle();
      if (end) return bossDone(/^Victoire/.test(end) ? 'victoire ✔' : 'défaite ✖');
      // combat du boss en cours : le mode Auto est activé plus bas, comme pour un combat normal
    } else if (cfg.bossRun?.phase === 'waiting' && !(path.startsWith('/combat') && !endTitle())) {
      // Boss apparu : le farm ne relance pas, on passe la main à un nouvel onglet dès qu'aucun combat n'est en cours.
      // Son dernier combat est compté maintenant : l'onglet sera rechargé sur sa page d'accueil au retour.
      const end = path.startsWith('/combat') && endTitle();
      if (end && cfg.botFight) {
        timeFightEnd();
        await save(/^Victoire/.test(end)
          ? { botFight: false, wins: (cfg.wins || 0) + 1, lossStreak: 0 }
          : { botFight: false, losses: (cfg.losses || 0) + 1 });
      }
      setStatus(`Boss de chasse apparu (${cfg.bossRun.name || 'boss'}) — ouverture d’un onglet…`);
      await send({ type: 'bossGo' }).catch(() => {});
      return progress();
    }

    if (path.startsWith('/combat')) {
      const end = endTitle();

      if (!end) endRetries = 0;
      if (end) {
        const hunt = huntEnd();
        const asc = !hunt && visibleButtons().some((b) => ASC_END.test(b.textContent.trim()));
        const pathFight = !hunt && !asc && visibleButtons().some((b) => NEXT_STAGE.test(b.textContent.trim()));
        // fin d'un combat qui n'est pas celui du mode choisi (boss de chasse, combat manuel…)
        if (isAsc() ? !asc : isHunt() ? !hunt : !pathFight) return goHome();

        if (/^Défaite/.test(end)) {
          const hint = () => document.querySelector('p.text-gold.italic')?.textContent.trim();
          if (cfg.botFight) {
            // On réessaie jusqu'à N défaites d'affilée : MAX_PATH_RETRIES (aventure, ascension), cfg.huntRetries (chasse).
            const streak = (cfg.lossStreak || 0) + 1;
            const stop = streak > maxRetries();
            timeFightEnd();
            await save({ botFight: false, losses: (cfg.losses || 0) + 1, lossStreak: stop ? 0 : streak });
            if (stop && dropOn() && isHunt()) {   // farm de drop : zone abandonnée, on passe à la suivante
              const z = cfg.huntZone;
              notify('drop', `❌ Farm de drop : ${streak} défaites d’affilée dans **${dropZoneName(z)}** — zone abandonnée, passage à la suivante.${hint() ? `\n> 💡 ${hint()}` : ''}`);
              await save({ dropRun: { ...cfg.dropRun, skipped: [...(cfg.dropRun.skipped || []), z] } });
              return dropGoZone(`${streak} défaites dans ${dropZoneName(z)}`);
            }
            if (stop) {
              await save({ enabled: false, paused: false, status: 'Arrêté : combat perdu' });
              const where = `${isHunt() ? ` en chasse (${cfg.huntZoneName || 'zone ' + cfg.huntZone})` : ` en ${isAsc() ? 'ascension' : 'aventure'}`}`
                + (streak > 1 ? ` (${streak} défaites d’affilée)` : '');
              notify('defeat', `❌ **Combat perdu**${where} sur DofusMasters. Pilote auto arrêté.${hint() ? `\n> 💡 ${hint()}` : ''}\n${DM.ORIGIN}${home()}`);
              return;
            }
          }
          if (!cfg.lossStreak) return;   // défaite d'un combat lancé à la main : on n'y touche pas

          // Réessai de l'étape / du groupe (Auto de préférence)
          if (!(await gate())) return progress();
          await autoEquipTick();
          if (eqAutoBusy) return progress();
          if (++endRetries > 2) { endRetries = 0; return goHome(); }   // bouton sans effet : on repasse par l'accueil du mode
          setStatus(`Défaite — nouvel essai ${cfg.lossStreak}/${maxRetries()}…`);
          await sleep(relaunchDelay());
          if (!isOwner()) return;
          const autoRetry = weightsOn() ? null : findBtn(/^Réessayer en auto$/i);
          const retry = autoRetry || findBtn(isHunt() ? HUNT_RETRY : isAsc() ? /^Réessayer l.étage$/i : /^Réessayer l.étape$/i);
          if (!retry) return;
          await save({ botFight: true });
          spendEnergy();
          lastAutoClick = autoRetry ? Date.now() : 0;
          markLaunch();
          retry.click();
          progress();
          await sleep(3000);
          return;
        }

        if (cfg.botFight) { timeFightEnd(); await save({ botFight: false, wins: (cfg.wins || 0) + 1, lossStreak: 0 }); }
        if (dropOn() && isHunt()) {
          if (cfg.dropRun.tried?.length) await save({ dropRun: { ...cfg.dropRun, tried: [] } });
          if (!dropTargets(cfg.huntZone).size) return dropGoZone(`${dropZoneName(cfg.huntZone)} : plus rien à y dropper`);
        }
        if (!(await gate())) return progress();
        // Auto-équipement : entre deux combats (le seul moment où le jeu l'accepte), avant la relance
        await autoEquipTick();
        if (eqAutoBusy) return progress();
        // Relance refusée (groupes renouvelés…) : on repasse par la page de la zone.
        if (++endRetries > 2) { endRetries = 0; return goHome(); }

        setStatus(isHunt() ? 'Victoire ✔ — on relance le groupe en auto…' : isAsc() ? 'Victoire ✔ — étage suivant en auto…' : 'Victoire ✔ — combat suivant en auto…');
        await sleep(relaunchDelay());
        if (!isOwner()) return;
        // Bouton « en auto » de préférence ; sinon relance simple, le mode Auto sera activé dans le combat.
        const autoNext = weightsOn() ? null : findBtn(AUTO_NEXT);
        const next = autoNext || findBtn(isHunt() ? HUNT_RETRY : isAsc() ? /^Étage suivant$/ : /^Étape suivante$/);
        if (!next) return;
        await save({ botFight: true });
        spendEnergy();
        lastAutoClick = autoNext ? Date.now() : 0;
        markLaunch();
        next.click();
        progress();
        await sleep(3000);
        return;
      }

      // Combat rapide : le serveur a déjà renvoyé le résultat ; recharger affiche directement l'écran de fin.
      const fightEnd = (document.documentElement.dataset.dmFightEnd || '').split(':');
      if (fastFight() && cfg.botFight && +fightEnd[1] >= pageLoadedAt && !presenceDialog()) {
        DM.log(`combat rapide : résultat reçu (${fightEnd[0]}) ${((Date.now() - (cfg.lastLaunchAt || Date.now())) / 1000).toFixed(1)} s après le lancement → rechargement`);
        setStatus(`Combat rapide : ${fightEnd[0] === 'won' ? 'victoire' : 'défaite'} reçue — affichage du résultat…`);
        progress();
        location.reload();
        await sleep(5000);
        return;
      }
      if (!cfg.botFight) {   // combat lancé à la main : on n'y touche pas
        setStatus('Combat manuel en cours — le pilote attend', true);
        return progress();
      }
      // Auto par poids : le pilote joue lui-même les cartes (sauf repli sur l'Auto du jeu pour cette page)
      if (weightsOn() && !useGameAuto) {
        if (isOwner() && !weightedBusy) weightedFight();
        return progress();
      }
      // combat déjà lancé en Auto (« Suivant en auto »…), animation en cours
      if (Date.now() - lastAutoClick < 30000) return;
      await sleep(300 + Math.random() * 400);
      const auto = isOwner() && !endTitle() && findBtn(SEMI_AUTO);
      if (auto) {
        lastAutoClick = Date.now();
        auto.click();
        progress();
        setStatus('Combat en mode Auto (semi-auto)…');
      }
      return;
    }

    // Sur une autre page de chasse, on laisse choisir un groupe à la main (pas de retour forcé).
    if (path.startsWith('/chasse') && !onHome()) {
      setStatus('En attente : choisis un groupe de chasse (clic sur « Attaquer »)');
      return progress();
    }

    if (isHunt()) {
      if (!onHome()) return goHome();
      if (dropOn()) {
        const g = dropPickGroup();
        if (g === null) return;   // page pas encore chargée
        if (g === false) {
          await save({ dropRun: { ...cfg.dropRun, tried: [...new Set([...(cfg.dropRun.tried || []), cfg.huntZone])] } });
          return dropGoZone(`aucun groupe utile dans ${dropZoneName(cfg.huntZone)}`);
        }
        if (cfg.huntGroup !== g) await save({ huntGroup: g });
      }
      const group = targetGroup();
      if (!group) return;   // page pas encore chargée
      // Groupe d'avis de recherche choisi à la main, renouvelé depuis (combat perdu au rechargement…) :
      // attaquer le nouveau groupe n'a pas de sens → arrêt.
      const t = cfg.huntTarget;
      if (!dropOn() && cfg.huntGroup && t?.zone === cfg.huntZone && t.group === cfg.huntGroup && t.monsters?.some(wantedMatch)) {
        const now = groupMonsters(group);
        if (now.length && now.join('|') !== t.monsters.join('|')) {
          await save({ enabled: false, paused: false, botFight: false, huntTarget: null,
            status: 'Arrêté : le groupe d’avis de recherche a été renouvelé' });
          notify('wanted', `⏹️ Le groupe d’avis de recherche (${t.monsters.filter(wantedMatch).join(', ')}) a été renouvelé dans **${cfg.huntZoneName || 'zone ' + cfg.huntZone}** : pilote auto arrêté.`);
          return;
        }
      }
      if ([...group.querySelectorAll('button')].some((b) => /Plus d.énergie/.test(b.textContent))) {
        lastEnergyCheck = 0;   // force une lecture : gate() mettra en pause
      }
      if (!(await gate())) return progress();
      const attack = () => [...targetGroup()?.querySelectorAll('button') || []]
        .find((b) => !b.disabled && b.offsetParent !== null && /^Attaquer$/.test(b.textContent.trim()));
      if (!attack()) return;
      setStatus(`${dropOn() ? `Farm de drop (${dropLeft().length} objet(s) restant(s))` : 'Chasse'} : attaque du groupe ${cfg.huntGroup || groupNumber(group)} (${cfg.huntZoneName || 'zone ' + cfg.huntZone})…`);
      await sleep(humanDelay());
      const btn = isOwner() && attack();
      if (!btn) return;
      rememberHuntTarget(groupCardOf(btn));
      await save({ botFight: true });
      spendEnergy();
      lastAutoClick = 0;   // le combat démarre en manuel : le mode Auto sera activé au tick suivant
      markLaunch();
      btn.click();
      progress();
      await sleep(3000);
      return;
    }

    if (isAsc()) {
      if (!onHome()) return goHome();
      const start = () => findBtn(ASC_START);
      if (!start()) {
        const off = visibleButtons().find((b) => b.disabled && ASC_START.test(b.textContent.trim()));
        if (off) lastEnergyCheck = 0;   // bouton grisé (« Pas assez d’énergie ») : gate() mettra en pause si besoin
        else if (Date.now() - loadedAt > 20000) setStatus('Ascension : bouton « Affronter l’étage » introuvable (niveau 200 requis)', true);
        if (!off) return progress();
      }
      if (!(await gate())) return progress();
      const label = start()?.textContent.trim();
      if (!label) return;
      setStatus(`Ascension : ${label.toLowerCase()}…`);
      await sleep(humanDelay());
      const btn = isOwner() && start();
      if (!btn) return;
      await save({ botFight: true });
      spendEnergy();
      lastAutoClick = 0;   // le combat démarre en manuel : le mode Auto sera activé au tick suivant
      markLaunch();
      btn.click();
      progress();
      await sleep(3000);
      return;
    }

    if (path.startsWith('/aventure')) {
      if (visibleButtons().some((b) => /Pas assez d.énergie/.test(b.textContent))) {
        lastEnergyCheck = 0;   // force une lecture : gate() mettra en pause
      }
      if (!(await gate())) return progress();
      if (!findBtn(/^(Combattre|Affronter le boss)$/)) return;
      setStatus('Lancement du combat…');
      await sleep(humanDelay());
      const btn = isOwner() && findBtn(/^(Combattre|Affronter le boss)$/);
      if (!btn) return;
      await save({ botFight: true });
      spendEnergy(/boss/i.test(btn.textContent) ? 2 : 1);
      lastAutoClick = 0;
      markLaunch();
      btn.click();
      progress();
      await sleep(3000);
      return;
    }

    return goHome();
  }

  // Autre page : on revient à l'aventure / à la zone de chasse, sauf pendant une pause énergie (l'utilisateur peut naviguer).
  async function goHome() {
    if (cfg.pauseReason === 'energy') return progress();
    setStatus(isHunt() ? 'Retour à la zone de chasse…' : isAsc() ? 'Retour à l’Ascension…' : 'Retour à l’aventure…');
    await sleep(humanDelay());
    if (isOwner()) location.assign(home());
  }

  // ---------- Autosell : vend tout l'inventaire non équipé ----------
  // /inventaire est une page Next.js : l'inventaire est dans le payload RSC (self.__next_f.push)
  // et la vente passe par la server action « sellItems » ([{ itemId, fusion, qty }, …]).
  // `entries` ne contient que les objets non portés ; le serveur refuse de toute façon de vendre un objet porté.
  const SELL_ACTION_FALLBACK = '606e0b152d7eeb65f891df20554b9d310fd5dfd04c';
  const NEVER_SELL_SLOTS = new Set(['familier', 'dofus']);   // jamais vendus par l'Autosell
  // Valeur de fusion du tier max « Rayonnant » (= FUSION.max du jeu : 0 = Tiers 1 … 3 = Tiers 4, 4 = Rayonnant, le « tier 5 »).
  // Jamais vendu automatiquement (comme « Tout cocher » sur le site).
  const FUSION_MAX = 4;
  const SELL_BATCH = 50;
  let sellActionId = null;

  // Résout une référence RSC « $10:props:children:1:… » vers la valeur pointée.
  function rscResolve(rows, v) {
    const m = typeof v === 'string' && v.match(/^\$([0-9a-f]+):(.+)$/);
    if (!m) return v;
    let cur = rows[m[1]];
    for (const k of m[2].split(':')) {
      if (cur == null) return undefined;
      cur = Array.isArray(cur) && cur[0] === '$' && k === 'props' ? cur[3] : cur[k];
    }
    return cur;
  }

  // Page Next.js : payload RSC concaténé (« flight ») + chunks JS (pour retrouver les server actions).
  // Simple lecture (GET) : en cas d'erreur serveur (5xx, « Resource Limit » 508…) ou réseau, on réessaie
  // FLIGHT_RETRY_WAITS fois en espaçant ; fetchFlight.onRetry(message) permet d'afficher la progression.
  const FLIGHT_RETRY_WAITS = [2000, 5000, 10000, 20000];
  async function fetchFlight(path) {
    let r;
    for (let i = 0; ; i++) {
      let why = null;
      try {
        r = await DM.fetchT(path, { credentials: 'same-origin', cache: 'no-store' });
        if (r.status >= 500) why = `HTTP ${r.status}`;
      } catch (e) {
        why = e.name === 'TimeoutError' ? 'délai dépassé' : 'erreur réseau';
      }
      if (!why) break;
      if (i >= FLIGHT_RETRY_WAITS.length) throw new Error(`${path} : ${why} (après ${i + 1} essais)`);
      fetchFlight.onRetry?.(`${path} : ${why} — nouvel essai ${i + 2}/${FLIGHT_RETRY_WAITS.length + 1} dans ${FLIGHT_RETRY_WAITS[i] / 1000} s…`);
      await sleep(FLIGHT_RETRY_WAITS[i]);
    }
    if (r.redirected && /connexion/.test(r.url)) throw new Error('Déconnecté');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    let flight = '';
    for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) flight += JSON.parse(m[1]);
    const chunks = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/[^"'\\\s]+?\.js(?:\?[^"'\\\s]*)?/g)].map((m) => m[0]))];
    return { flight, chunks, html };
  }

  // Lignes JSON du payload RSC (« id:{…} ») + premier objet (non tableau) qui satisfait `pred`.
  function rscProps(flight, pred) {
    const rows = {};
    for (const line of flight.split(/\r?\n/)) {
      const m = line.match(/^([0-9a-f]+):([[{].*)$/);
      if (!m) continue;
      try { rows[m[1]] = JSON.parse(m[2]); } catch { /* ligne texte/partielle */ }
    }
    let props = null;
    const walk = (x) => {
      if (props || x == null || typeof x !== 'object') return;
      if (!Array.isArray(x) && pred(x)) { props = x; return; }
      for (const k in x) walk(x[k]);
    };
    for (const id in rows) walk(rows[id]);
    return { rows, props };
  }

  async function fetchInventory() {
    const { flight, chunks } = await fetchFlight('/inventaire');
    const { rows, props } = rscProps(flight, (x) => Array.isArray(x.entries) && Array.isArray(x.slots));
    if (!props) throw new Error('Inventaire introuvable dans la page');

    const entries = props.entries.map((e) => {
      const item = rscResolve(rows, e.item) || {};
      return { id: item.id, name: item.n, lvl: item.lvl, slot: item.s, rarity: item.r, fusion: e.fusion, qty: e.qty };
    }).filter((e) => Number.isInteger(e.id) && e.qty > 0);
    return { entries, chunks, level: +props.level || null };
  }

  // L'ID d'une server action change à chaque déploiement : on le relit dans les chunks JS de la page.
  async function findAction(chunks, name, fallback) {
    const re = new RegExp(`createServerReference\\)\\("([0-9a-f]{20,})",[^)]*?"${name}"\\)`);
    for (const src of [...chunks].reverse()) {
      try {
        const m = (await (await DM.fetchT(src)).text()).match(re);
        if (m) return m[1];
      } catch { /* chunk suivant */ }
    }
    return fallback;
  }

  // Appelle une server action de la page /<segment> ; renvoie son résultat (ligne « 1: » de la réponse RSC).
  // Erreur renvoyée par le jeu (« Pas assez de kamas »…) : err.game = true ; sinon problème de protocole (ID périmé…).
  async function callAction(segment, actionId, args, query = '') {
    return (await postAction(segment, actionId, args, query)).res;
  }

  // Comme callAction, mais renvoie aussi le texte brut (la page re-rendue suit le résultat).
  async function postAction(segment, actionId, args, query = '') {
    const tree = encodeURIComponent(JSON.stringify(['', { children: [segment, { children: ['__PAGE__', {}, null, null, 4096] }, null, null, 4096] }, null, null, 4116]));
    const r = await DM.fetchT(`/${segment}${query}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'text/x-component',
        'Content-Type': 'text/plain;charset=UTF-8',
        'Next-Action': actionId,
        'Next-Router-State-Tree': tree,
      },
      body: JSON.stringify(args),
    });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    const text = await r.text();
    const line = text.split(/\r?\n/).find((l) => l.startsWith('1:'));
    const res = line ? JSON.parse(line.slice(2)) : null;
    if (!res) throw new Error('Réponse du serveur illisible');
    if (res.error) throw Object.assign(new Error(res.error), { game: true });
    return { res, text };
  }

  async function sellItems(actionId, items) {
    return (await callAction('inventaire', actionId, [items])).kamas || 0;
  }

  // dryRun = true : renvoie seulement ce qui serait vendu.
  async function autosell(dryRun) {
    const { entries, chunks, level } = await fetchInventory();
    const keepAbove = cfg.sellKeepAbove !== false;
    if (keepAbove && !level) throw new Error('Niveau du personnage illisible : vente annulée');
    const locked = cfg.lockedItems || {};
    const keepRar = new Set(cfg.sellKeepRarities || []);
    // Raison de garder un objet (par ordre de priorité), ou null s'il est vendable.
    const keepReason = (e) => locked[DM.lockKey(e.name, e.lvl)] ? 'locked'
      : NEVER_SELL_SLOTS.has(e.slot) ? 'slot'
      : keepRar.has(e.rarity) ? 'rarity'
      : e.fusion >= FUSION_MAX ? 'radiant'
      : keepAbove && !(e.lvl <= level) ? 'above'
      : null;
    const kept = { locked: 0, slot: 0, rarity: 0, radiant: 0, above: 0 };
    const toSell = [];
    for (const e of entries) {
      const why = keepReason(e);
      if (why) kept[why]++; else toSell.push(e);
    }
    const count = toSell.reduce((n, e) => n + e.qty, 0);
    const estimate = toSell.reduce((n, e) => n + 20 * (e.lvl || 0) * e.qty, 0);
    const info = { level, keepAbove, skipped: kept.radiant, lockedCount: kept.locked, aboveCount: kept.above, slotCount: kept.slot, rarityCount: kept.rarity };
    if (dryRun || !count) return { ok: true, count, estimate, ...info, kamas: 0 };

    if (!sellActionId) sellActionId = await findAction(chunks, 'sellItems', SELL_ACTION_FALLBACK);
    let kamas = 0, sold = 0;
    for (let i = 0; i < toSell.length; i += SELL_BATCH) {
      const batch = toSell.slice(i, i + SELL_BATCH);
      kamas += await sellItems(sellActionId, batch.map((e) => ({ itemId: e.id, fusion: e.fusion, qty: e.qty })));
      sold += batch.reduce((n, e) => n + e.qty, 0);
      if (i + SELL_BATCH < toSell.length) await sleep(800 + Math.random() * 700);
    }
    return { ok: true, count: sold, estimate, ...info, kamas };
  }

  // ---------- Verrou d'objets (interne à l'extension) ----------
  // Sur /inventaire, le panneau d'un objet contient « Vendre au marchand » : on ajoute un bouton 🔒 à côté de « Vendre ».
  // Clé = nom + niveau (le panneau n'affiche pas l'ID) : le verrou couvre tous les tiers de fusion de l'objet.
  function itemFromSellBox(box) {
    let panel = box.parentElement;
    while (panel && !panel.querySelector('.title.leading-tight')) panel = panel.parentElement;
    const title = panel?.querySelector('.title.leading-tight');
    if (!title) return null;
    const name = [...title.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
    const lvl = +([...panel.querySelectorAll('span')].map((s) => s.textContent.match(/^Niveau (\d+)$/)).find(Boolean)?.[1] || 0);
    return name ? { name, lvl } : null;
  }

  function scanLockButtons() {
    if (!location.pathname.startsWith('/inventaire')) return;
    for (const label of document.querySelectorAll('div.text-sm.text-muted')) {
      if (label.textContent.trim() !== 'Vendre au marchand') continue;
      const box = label.parentElement;
      const row = label.nextElementSibling;
      const item = row && itemFromSellBox(box);
      if (!item) continue;
      const key = DM.lockKey(item.name, item.lvl);
      let btn = row.querySelector('.dm-lock');
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dm-lock btn !py-1.5 text-sm';
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const k = btn.dataset.key;
          const lockedItems = { ...(cfg.lockedItems || {}) };
          if (lockedItems[k]) delete lockedItems[k];
          else lockedItems[k] = { name: btn.dataset.name, lvl: +btn.dataset.lvl };
          save({ lockedItems });
          paintLock(btn);
        });
        row.appendChild(btn);
      }
      Object.assign(btn.dataset, { key, name: item.name, lvl: item.lvl });
      paintLock(btn);
    }
  }

  function paintLock(btn) {
    const on = !!cfg.lockedItems?.[btn.dataset.key];
    const text = on ? '🔒 Verrouillé' : '🔓 Verrouiller';
    if (btn.textContent !== text) btn.textContent = text;
    btn.dataset.tip = on ? 'Protégé de l’Autosell (extension) — cliquer pour déverrouiller' : 'Empêcher l’Autosell de vendre cet objet';
    btn.style.cssText = on
      ? 'background:#b07400;color:#fff;border-color:#b07400;white-space:nowrap'
      : 'background:transparent;white-space:nowrap';
  }

  // ---------- Échange entre deux comptes via l'HDV ----------
  // Compte A (onglet normal) et compte B (onglet en navigation privée, extension autorisée en privé) :
  // le service worker est commun aux deux contextes, il relaie la demande à un onglet de l'autre contexte.
  // « Échanger » : A met l'objet en vente à 1 kamas (listItem), B l'achète aussitôt (buyListing).
  // Si l'achat échoue, A retire l'annonce (cancelListing) pour qu'un tiers ne l'achète pas.
  const TRADE_PRICE = 1;
  const HDV_ACTION_FALLBACK = {
    listItem: '702736ba6595110a5f795129bb67e1474296b9bbc3',      // (itemId, fusion, prix) → { ok } ou { error }
    buyListing: '4069e01f9c51baeb8173b67961698d890b954c0314',    // (listingId)
    cancelListing: '402e59a8dfed62e1ad851ba0dca9bf8630e6316b10', // (listingId)
  };
  const hdvActionIds = {};
  let tradeBusy = false, myNameCache;

  async function hdvAction(name, chunks) {
    if (!hdvActionIds[name]) hdvActionIds[name] = await findAction(chunks || (await fetchFlight('/hdv')).chunks, name, HDV_ACTION_FALLBACK[name]);
    return hdvActionIds[name];
  }

  // Server action de l'HDV. Si l'ID est périmé (nouveau déploiement : HTTP 404 ou réponse illisible), on le relit et on
  // réessaie une fois. Jamais sur une erreur serveur (5xx, 508…) ni réseau : relire l'ID prend plusieurs secondes,
  // pendant lesquelles une annonce à 1 kamas resterait en vente.
  async function hdvCall(name, args, query = '') {
    try {
      return await postAction('hdv', await hdvAction(name), args, query);
    } catch (e) {
      if (e.game || !(e.status === 404 || e.message === 'Réponse du serveur illisible')) throw e;
      delete hdvActionIds[name];
      hdvActionIds[name] = await findAction((await fetchFlight('/hdv')).chunks, name, HDV_ACTION_FALLBACK[name]);
      return postAction('hdv', hdvActionIds[name], args, query);
    }
  }

  // Nom du personnage connecté (« me » du payload RSC de la page).
  function myName() {
    if (myNameCache) return myNameCache;
    for (const s of document.scripts) {
      for (const m of s.textContent.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
        let chunk;
        try { chunk = JSON.parse(m[1]); } catch { continue; }
        const n = chunk.match(/"me":\{"id":"[^"]*","name":("(?:[^"\\]|\\.)*")/);
        if (n) return (myNameCache = JSON.parse(n[1]));
      }
    }
    return null;
  }

  // Panneau de détails d'un objet (ItemDetails : titre « Nom · Tiers N », « Niveau N ») → { name, lvl, fusion }.
  function itemFromPanel(panel) {
    const title = panel?.querySelector('.title.leading-tight');
    if (!title) return null;
    const name = [...title.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
    const tier = title.querySelector('span')?.textContent || '';
    const fusion = /Rayonnant/.test(tier) ? FUSION_MAX : +(tier.match(/Tiers\s*(\d+)/)?.[1] || 1) - 1;
    const lvl = +([...panel.querySelectorAll('span')].map((s) => s.textContent.match(/^Niveau (\d+)$/)).find(Boolean)?.[1] || 0);
    return name ? { name, lvl, fusion } : null;
  }
  const panelOf = (el) => {
    let p = el;
    while (p && !p.querySelector('.title.leading-tight')) p = p.parentElement;
    return p;
  };

  // Objets vendables (onglet « vendre » de l'HDV : sans les objets équipés, avec la date de fin de liaison).
  // `tradable` : retire aussi les exemplaires « éternels » (gardés au Prestige, liés au compte à vie) et les objets
  // verrouillés (cadenas du jeu). L'HDV les liste sans les marquer : le nombre d'éternels n'est lu que sur /inventaire.
  async function fetchSellable({ tradable = false } = {}) {
    const [{ flight, chunks }, eternal] = await Promise.all([fetchFlight('/hdv?onglet=vendre'), tradable ? fetchEternal() : null]);
    const { rows, props } = rscProps(flight, (x) => Array.isArray(x.inventory) && Array.isArray(x.mine));
    if (!props) throw new Error('Inventaire de l’HDV introuvable');
    let entries = props.inventory.map((e) => {
      const item = rscResolve(rows, e.item) || {};
      return { id: item.id, name: item.n, lvl: item.lvl, slot: item.s, rarity: item.r, icon: item.icon, fusion: e.fusion, qty: e.qty, boundUntil: e.boundUntil, locked: !!e.locked };
    }).filter((e) => Number.isInteger(e.id));
    if (tradable) {
      entries = entries.map((e) => {
        const k = `${e.id}|${e.fusion || 0}`, n = Math.min(eternal.get(k) || 0, e.qty);
        eternal.set(k, (eternal.get(k) || 0) - n);   // plusieurs lignes pour le même objet : on ne retire qu'une fois
        return { ...e, qty: e.qty - n };
      }).filter((e) => e.qty > 0 && !e.locked);
    }
    return { entries, chunks, mine: props.mine, own: ownListings(rows, props.mine), maxListings: props.maxListings };
  }

  // Mes annonces (props « mine » de l'HDV), références RSC résolues : le jeu peut y mettre « $… » à la place de l'objet
  // quand il apparaît déjà ailleurs dans la page → [{ id, price, fusion, itemId, name }].
  function ownListings(rows, mine) {
    return (rscResolve(rows, mine) || []).map((raw) => {
      const l = rscResolve(rows, raw) || {};
      const it = rscResolve(rows, l.item) || {};
      return { id: +l.id, price: +l.price, fusion: +l.fusion || 0, itemId: it.id, name: it.n };
    }).filter((l) => l.id);
  }

  // Exemplaires « éternels » (objets gardés au Prestige, invendables) par « id|fusion », lus dans /inventaire.
  async function fetchEternal() {
    const { flight } = await fetchFlight('/inventaire');
    const { rows, props } = rscProps(flight, (x) => Array.isArray(x.entries) && Array.isArray(x.slots));
    if (!props) throw new Error('Inventaire introuvable dans la page');
    const out = new Map();
    for (const e of props.entries) {
      if (!(+e.eternal > 0)) continue;
      const k = `${rscResolve(rows, e.item)?.id}|${e.fusion || 0}`;
      out.set(k, (out.get(k) || 0) + +e.eternal);
    }
    return out;
  }

  // ID de l'annonce à 1 kamas qu'on vient de créer, lu dans la page renvoyée avec le résultat de listItem
  // (annonces « mine » résolues ; sinon recherche dans le texte brut).
  function findMyListing(text, itemId, fusion) {
    const { rows, props } = rscProps(text, (x) => Array.isArray(x.mine) && Array.isArray(x.inventory));
    const own = props ? ownListings(rows, props.mine).filter((l) => l.price === TRADE_PRICE && l.fusion === fusion && l.itemId === itemId) : [];
    if (own.length) return Math.max(...own.map((l) => l.id));
    let best = null;
    for (const m of text.matchAll(/\{"id":(\d+),"price":(\d+),"fusion":(\d+),"mine":true,"seller":"(?:[^"\\]|\\.)*","item":\{"id":(\d+)/g)) {
      if (+m[2] === TRADE_PRICE && +m[3] === fusion && +m[4] === itemId) best = Math.max(best || 0, +m[1]);
    }
    return best;
  }

  // Côté acheteur, si l'ID n'a pas pu être lu : annonce la plus récente de ce vendeur pour cet objet à 1 kamas.
  async function findListingOnMarket({ itemId, fusion, seller }) {
    const { flight } = await fetchFlight('/hdv');
    const who = seller ? JSON.stringify(seller).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '"(?:[^"\\\\]|\\\\.)*"';
    const re = new RegExp(`\\{"id":(\\d+),"price":${TRADE_PRICE},"fusion":${+fusion},"mine":false,"seller":${who},"item":\\{"id":${+itemId}[,}]`, 'g');
    let best = null;
    for (const m of flight.matchAll(re)) best = Math.max(best || 0, +m[1]);
    return best;
  }

  // Vendeur, avant un ou plusieurs échanges : contact de l'autre compte + objets vendables + IDs des actions.
  async function tradePrepare(say) {
    const peer = await peerReady(say);
    const sell = await fetchSellable({ tradable: true });
    if (sell.maxListings && sell.mine.length >= sell.maxListings) throw new Error(`HDV plein (${sell.mine.length}/${sell.maxListings} ventes en cours)`);
    await Promise.all([hdvAction('listItem', sell.chunks), hdvAction('cancelListing', sell.chunks)]);
    return { to: peer.name || 'l’autre compte', entries: sell.entries, maxListings: sell.maxListings || 0, listed: sell.mine.length };
  }

  // Objet vendable correspondant à { name, lvl, fusion } (non lié, quantité restante > 0).
  function tradeResolve(ctx, it) {
    const matches = ctx.entries.filter((e) => e.name === it.name && (!it.lvl || e.lvl === it.lvl) && e.fusion === it.fusion);
    if (!matches.length) throw new Error(`${it.name} introuvable parmi les objets échangeables (équipé, éternel ou verrouillé ?)`);
    if (new Set(matches.map((e) => e.id)).size > 1) throw new Error(`Plusieurs objets s’appellent ${it.name} : échange annulé`);
    const free = matches.filter((e) => !e.boundUntil || new Date(e.boundUntil) <= Date.now());
    if (!free.length) throw new Error(`${it.name} est lié jusqu’au ${new Date(matches[0].boundUntil).toLocaleString('fr-FR')}`);
    const entry = free.find((e) => e.qty - (e.reserved || 0) > 0);
    if (!entry) throw new Error(`Plus d’exemplaire de ${it.name} à échanger`);
    return entry;
  }

  // ---------- Robustesse de l'échange ----------
  // Une annonce à 1 kamas ne doit jamais rester en vente si l'autre compte ne l'achète pas aussitôt :
  // - avant chaque mise en vente, on vérifie que l'autre compte (session + serveur) répond, sinon on attend ;
  // - l'achat doit être confirmé en BUY_WAIT_MS, sinon l'annonce est retirée sans attendre la réponse ;
  // - après un échec technique (HTTP 5xx, onglet en rechargement…), l'objet est retenté une fois l'autre compte revenu.
  const BUY_WAIT_MS = 2500;
  const BUY_WAIT_SEARCH_MS = 8000;              // l'acheteur doit chercher l'annonce lui-même (ID non lu)
  const TRADE_RETRIES = 4;                       // nouveaux essais d'un même exemplaire après un échec technique
  const PEER_WAIT_MS = 3 * 60000;                // attente max que l'autre compte redevienne joignable
  const PEER_RETRY_GAPS = [2000, 4000, 8000, 15000, 30000];
  const CANCEL_TRIES = 6;
  const TRADE_PARALLEL = 2;                      // « Tout échanger » : objets envoyés en même temps
  const tradeErr = (message, extra) => Object.assign(new Error(message), extra);
  const tradeStopped = () => !!queueRun?.stop;

  // Attend que l'autre compte réponde (onglet joignable, session valide, serveur du jeu disponible).
  // Un achat réussi il y a moins de PEER_FRESH_MS suffit : pas de nouvelle vérification avant chaque objet.
  const PEER_FRESH_MS = 15000;
  let peerOkAt = 0, peerInfo = null;
  async function peerReady(say) {
    if (peerInfo && Date.now() - peerOkAt < PEER_FRESH_MS) return peerInfo;
    const t0 = Date.now();
    for (let i = 0; ; i++) {
      const p = await send({ type: 'tradePeer' }).catch((e) => ({ ok: false, error: e.message, retry: true }));
      if (p?.ok) {
        if (p.name && p.name === myName()) throw tradeErr('L’autre onglet est connecté au même personnage');
        peerInfo = p;
        peerOkAt = Date.now();
        return p;
      }
      if (p?.retry === false || Date.now() - t0 > PEER_WAIT_MS) throw tradeErr(p?.error || 'Autre compte injoignable');
      if (tradeStopped()) throw tradeErr('Arrêté', { stopped: true });
      const gap = PEER_RETRY_GAPS[Math.min(i, PEER_RETRY_GAPS.length - 1)];
      say(`⏳ Autre compte indisponible (${p?.error || 'sans réponse'}) — nouvel essai dans ${gap / 1000} s…`);
      await sleep(gap);
    }
  }

  // Retire l'annonce (avec plusieurs essais : tant qu'elle est en ligne, n'importe qui peut l'acheter).
  // → { ok } | { gone } (déjà vendue / retirée) | { error }
  // « gone » seulement si le jeu dit que la vente n'existe plus, ou si elle n'est plus dans mes annonces ; tout autre
  // refus (« attends un peu »…) est retenté — avant, il était pris pour « achetée par un autre joueur ».
  const GONE_RE = /n.existe plus|introuvable|plus en vente|déjà (été )?vendu|déjà (été )?achet/i;
  const myTradeListing = (own, entry) => Math.max(0, ...own.filter((l) => l.price === TRADE_PRICE && l.itemId === entry.id && l.fusion === entry.fusion).map((l) => l.id)) || null;
  async function cancelTradeListing(listingId, entry) {
    let id = listingId, last = null;
    for (let i = 0; i < CANCEL_TRIES; i++) {
      try {
        if (!id) id = myTradeListing((await fetchSellable()).own, entry);
        if (!id) return { gone: true, error: 'annonce plus en vente' };
        await hdvCall('cancelListing', [id], '?onglet=vendre');
        return { ok: true };
      } catch (e) {
        last = e;
        if (e.game && GONE_RE.test(e.message)) {
          // le jeu dit qu'elle n'existe plus : on vérifie dans mes annonces avant de le croire
          try {
            const still = myTradeListing((await fetchSellable()).own, entry);
            if (!still) return { gone: true, error: e.message };
            id = still;
          } catch { return { gone: true, error: e.message }; }
        } else if (!e.game) {
          id = id || null;
        }
        await sleep(400 + i * 400);
      }
    }
    return { error: last?.message || 'retrait impossible' };
  }

  // Filet de sécurité en fin d'envoi : retire mes annonces à 1 kamas restées en vente pour les objets de cet envoi.
  async function sweepTradeListings(items, say) {
    if (!items.size) return 0;
    let n = 0;
    try {
      const { own } = await fetchSellable();
      for (const l of own.filter((x) => x.price === TRADE_PRICE && items.has(`${x.itemId}|${x.fusion}`))) {
        try {
          await hdvCall('cancelListing', [l.id], '?onglet=vendre');
          n++;
          DM.log(`échange: annonce restée en vente retirée (${l.name}, annonce ${l.id})`);
        } catch (e) {
          DM.log(`échange: annonce restée en vente ${l.name} (${l.id}) : retrait impossible (${e.message})`);
        }
      }
    } catch (e) {
      DM.log(`échange: vérification des annonces restantes impossible (${e.message})`);
    }
    if (n) say?.(`🧹 ${n} annonce(s) à 1 kamas restée(s) en vente retirée(s).`);
    return n;
  }

  // Un exemplaire : mise en vente à 1 kamas puis achat par l'autre compte. last = dernier de la série (l'acheteur recharge sa page).
  // Erreur avec retry = true : rien n'est perdu (annonce retirée ou jamais créée), on peut retenter.
  async function tradeOne(ctx, entry, say, last = true) {
    await peerReady(say);
    say(`${entry.name} : mise en vente à ${TRADE_PRICE} K…`);
    const t0 = performance.now();
    let text;
    try {
      ({ text } = await hdvCall('listItem', [entry.id, entry.fusion, TRADE_PRICE], '?onglet=vendre'));
    } catch (e) {
      if (e.game) throw e;   // refus du jeu (HDV plein…) : inutile de retenter
      // erreur technique : la vente a peut-être été créée quand même → on la retire si elle existe
      const c = await cancelTradeListing(null, entry);
      if (c.error && !c.gone) throw tradeErr(`${entry.name} : mise en vente incertaine (${e.message}) et retrait impossible (${c.error}) — vérifie tes ventes à l’HDV !`, { lost: 'maybe', why: e.message, cancel: c.error });
      throw tradeErr(`${entry.name} : mise en vente impossible (${e.message})`, { retry: true });
    }
    let listingId = findMyListing(text, entry.id, entry.fusion);
    if (!listingId) {
      // numéro d'annonce absent de la réponse : on relit mes ventes plutôt que de faire chercher l'acheteur à l'HDV (lent)
      try { listingId = myTradeListing((await fetchSellable()).own, entry); } catch { /* l'acheteur cherchera */ }
      DM.log(`échange: ${entry.name} : n° d'annonce absent de la réponse${listingId ? `, relu dans mes ventes (${listingId})` : ', introuvable dans mes ventes'}`);
    }
    say(`${entry.name} : achat par ${ctx.to}…`);
    const buyP = send({ type: 'tradeBuy', listingId, itemId: entry.id, fusion: entry.fusion, seller: myName(), last })
      .catch((e) => ({ ok: false, error: e.message, retry: true }));
    let r = await Promise.race([buyP, sleep(listingId ? BUY_WAIT_MS : BUY_WAIT_SEARCH_MS).then(() => null)]);
    const done = (res) => {
      entry.qty--;
      const ms = Math.round(performance.now() - t0);
      DM.log(`échange: ${entry.name} → ${ctx.to} (annonce ${res.listingId || listingId}, ${ms} ms)`);
      return ms;
    };
    if (r?.ok) { peerOkAt = Date.now(); return done(r); }

    // Échec, ou pas de confirmation à temps : on retire l'annonce tout de suite, sans attendre la réponse.
    peerOkAt = 0;   // l'autre compte a eu un souci : on le revérifiera avant le prochain objet
    say(`${entry.name} : achat ${r ? 'refusé' : 'trop lent'} — retrait de l’annonce…`);
    const tooSlow = !r;   // retirée avant la réponse : l'achat échouera sur « vente n'existe plus », ce n'est pas un vrai refus
    const c = await cancelTradeListing(listingId, entry);
    if (!r) r = await buyP;   // la réponse de l'acheteur finit par arriver
    if (r?.ok) return done(r);
    const why = r?.error || 'sans réponse';
    if (c.ok) {
      DM.log(`échange: ${entry.name} → ${ctx.to} raté (${why}), annonce retirée`);
      throw tradeErr(`${entry.name} : achat ${tooSlow ? 'trop lent' : `raté (${why})`} — annonce retirée`, { retry: tooSlow || r?.retry !== false });
    }
    // Annonce introuvable ou impossible à retirer : l'autre compte l'a-t-il finalement reçue ?
    const v = await send({ type: 'tradeVerify', itemId: entry.id, fusion: entry.fusion }).catch(() => null);
    if (v?.has) return done({ listingId });
    DM.log(`échange: PERTE possible ${entry.name} (achat : ${why} ; retrait : ${c.error})`);
    throw tradeErr(c.gone
      ? `⚠️ ${entry.name} a été acheté par un autre joueur avant le retrait (achat : ${why}).`
      : `⚠️ ${entry.name} : achat raté (${why}) et retrait impossible (${c.error}) — retire l’annonce à la main !`,
    { lost: c.gone ? true : 'maybe', why, cancel: c.error });
  }

  // tradeOne avec nouveaux essais après un échec technique (attend que l'autre compte soit revenu).
  async function tradeWithRetry(ctx, entry, say, last = true, runId = Date.now()) {
    for (let attempt = 1; ; attempt++) {
      try {
        const ms = await tradeOne(ctx, entry, say, last);
        await recordTrade(runId, ctx, entry, 'ok', attempt > 1 ? `après ${attempt} essais` : '', ms);
        return ms;
      } catch (e) {
        if (!e.retry || attempt > TRADE_RETRIES || tradeStopped()) {
          if (!e.stopped) {
            const status = e.lost === true ? 'lost' : e.lost ? 'unsure' : 'failed';
            const detail = e.lost === true ? `achat de l’autre compte : ${e.why}`
              : e.lost ? `achat : ${e.why} ; retrait : ${e.cancel}`
              : e.message.replace(`${entry.name} : `, '') + (attempt > 1 ? ` — ${attempt} essais` : '');
            await recordTrade(runId, ctx, entry, status, detail);
          }
          throw e;
        }
        say(`${e.message} — nouvel essai ${attempt + 1}/${TRADE_RETRIES + 1}…`);
        await sleep(1500 * attempt);
      }
    }
  }

  // Bouton « Échanger » d'un panneau d'objet.
  async function tradeItem(panel, say) {
    const it = itemFromPanel(panel);
    if (!it) throw new Error('Objet illisible');
    const ctx = await tradePrepare(say);
    const entry = tradeResolve(ctx, it);
    try {
      const ms = await tradeWithRetry(ctx, entry, say, true, Date.now());
      return `✔ ${it.name} → ${ctx.to} (${ms} ms)`;
    } catch (e) {
      await sweepTradeListings(new Set([`${entry.id}|${entry.fusion}`]));
      throw e;
    }
  }

  // Acheteur : achète l'annonce relayée par le service worker.
  // retry = false : refus du jeu (kamas, vente disparue…) ; sinon erreur technique, le vendeur pourra retenter.
  let buyReloadTimer;
  async function tradeBuy(msg) {
    clearTimeout(buyReloadTimer);
    try {
      const listingId = msg.listingId || await findListingOnMarket(msg);
      if (!listingId) throw tradeErr('annonce introuvable à l’HDV', { game: true });
      const { res } = await hdvCall('buyListing', [listingId]);
      tradeToast(`🔁 Objet reçu via l’HDV${msg.seller ? ` de ${msg.seller}` : ''}.`, 'ok');
      return { ok: true, listingId, text: res.ok };
    } catch (e) {
      tradeToast(`🔁 Échec de l’achat : ${e.message}`, 'err');
      return { ok: false, error: e.message, retry: !e.game };
    } finally {
      // Rafraîchit l'inventaire affiché, une fois la série terminée (ou 5 s sans nouvel achat).
      if (/^\/(hdv|inventaire)/.test(location.pathname) && !isOwner()) {
        buyReloadTimer = setTimeout(() => location.reload(), msg.last === false ? 5000 : 1200);
      }
    }
  }

  // Acheteur : le jeu et la session répondent-ils ? (requête légère, celle que le chat du site fait en continu)
  async function tradeHealth() {
    try {
      const r = await DM.fetchT('/api/chat?after=999999999&g=0', { credentials: 'same-origin', cache: 'no-store' }, 8000);
      if (r.redirected && /connexion/.test(r.url)) return { ok: false, error: 'autre compte déconnecté', retry: true };
      if (!r.ok) return { ok: false, error: `serveur indisponible (HTTP ${r.status})`, retry: true };
    } catch (e) {
      return { ok: false, error: `serveur injoignable (${e.message})`, retry: true };
    }
    hdvAction('buyListing').catch(() => {});   // préchauffe l'ID de buyListing (une fois par page)
    return { ok: true, name: myName() };
  }

  // Acheteur : l'objet est-il arrivé dans l'inventaire ? (acheté à l'HDV = lié pendant ~24 h)
  async function tradeVerify({ itemId, fusion }) {
    try {
      const { entries } = await fetchSellable();
      const soon = Date.now() + 23 * 3600000;
      return { has: entries.some((e) => e.id === itemId && e.fusion === fusion && e.boundUntil && new Date(e.boundUntil) > soon) };
    } catch (e) {
      return { has: false, error: e.message };
    }
  }

  let toastEl, toastTimer;
  function tradeToast(text, cls, onClick = null) {
    if (!toastEl?.isConnected) {
      toastEl = document.createElement('div');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.onclick = onClick;
    toastEl.style.cssText = `cursor:${onClick ? 'pointer' : 'default'};position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:10px 16px;border-radius:10px;font:600 14px system-ui,sans-serif;color:#fff;box-shadow:0 4px 16px #0008;background:${cls === 'err' ? '#a8322a' : '#2e7d32'}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.remove(), 6000);
  }

  // ---------- File d'échange ----------
  // Objets ajoutés depuis leur panneau (« ➕ File »), échangés ensuite d'un coup. Stockée par personnage
  // (le stockage est commun aux deux comptes) : cfg.tradeQueues = { [nom]: [{ name, lvl, fusion, qty }] }.
  let queueRun = null;   // { stop, done, total } pendant « Tout échanger »
  const queueKey = () => myName() || '?';
  const tradeQueue = () => cfg.tradeQueues?.[queueKey()] || [];
  const sameItem = (a, b) => a.name === b.name && a.lvl === b.lvl && a.fusion === b.fusion;
  const itemLabel = (it) => `${it.name}${it.fusion ? ` · ${it.fusion >= FUSION_MAX ? 'Rayonnant' : `T${it.fusion + 1}`}` : ''}`;

  function setTradeQueue(q) {
    return save({ tradeQueues: { ...(cfg.tradeQueues || {}), [queueKey()]: q.filter((it) => it.qty > 0) } });
  }

  function queueAdd(it) {
    const q = tradeQueue().map((x) => ({ ...x }));
    const cur = q.find((x) => sameItem(x, it));
    if (cur) cur.qty++; else q.push({ ...it, qty: 1 });
    setTradeQueue(q);
    return cur ? cur.qty : 1;
  }

  async function runQueue() {
    if (tradeBusy || !tradeQueue().length) return;
    tradeBusy = true;
    const runId = Date.now();
    queueRun = { stop: false, done: 0, total: tradeQueue().reduce((n, it) => n + it.qty, 0), id: runId };
    const say = (t, cls) => queueMsg(t, cls);
    let ok = false;
    const skipped = [];
    try {
      const ctx = await tradePrepare(say);
      await setLastRun({ id: runId, to: ctx.to });
      let ms = 0, fatal = null;
      const sent = new Set();   // objets mis en vente (id|tier) : filet de sécurité en fin d'envoi
      // Envoi en parallèle : un objet est mis en vente pendant que l'autre compte achète le précédent.
      // Jamais deux exemplaires du même objet en même temps : l'ID de l'annonce est retrouvé par objet + tier.
      const room = ctx.maxListings ? ctx.maxListings - ctx.listed : TRADE_PARALLEL;
      const workers = Math.max(1, Math.min(TRADE_PARALLEL, room));
      const inFlight = new Map();   // clé d'objet → exemplaires en cours
      const keyOf = (it) => `${it.name}|${it.lvl}|${it.fusion}`;
      const nextJob = () => tradeQueue().find((it) => !inFlight.has(keyOf(it)) && it.qty - (inFlight.get(keyOf(it)) || 0) > 0);
      const worker = async (w) => {
        if (w) await sleep(150 + Math.random() * 200);   // décalage du 2e envoi
        while (!queueRun.stop && !fatal) {
          const it = nextJob();
          if (!it) {
            if (!inFlight.size) return;
            await sleep(100);   // un autre objet est en cours : on attend qu'il libère sa place
            continue;
          }
          const k = keyOf(it);
          inFlight.set(k, (inFlight.get(k) || 0) + 1);   // réservé avant toute attente : l'autre envoi ne le prend pas
          let entry;
          try {
            entry = tradeResolve(ctx, it);
            sent.add(`${entry.id}|${entry.fusion}`);
          } catch (e) {
            // Objet introuvable / lié / plus assez d'exemplaires : on le sort de la file et on passe au suivant.
            skipped.push(e.message);
            await recordTrade(runId, ctx, it, 'skipped', e.message.replace(`${it.name} `, ''), null, it.qty);
            queueRun.total -= it.qty;
            await setTradeQueue(tradeQueue().filter((x) => !sameItem(x, it)));
            inFlight.delete(k);
            continue;
          }
          entry.reserved = (entry.reserved || 0) + 1;
          const n = queueRun.done + inFlight.size;
          try {
            // last = false : l'acheteur rafraîchit sa page après 5 s sans achat (un autre envoi peut être en cours)
            ms += await tradeWithRetry(ctx, entry, (t) => say(`${Math.min(n, queueRun.total)}/${queueRun.total} · ${t}`), workers === 1 && queueRun.done + 1 >= queueRun.total, runId);
            queueRun.done++;
            await setTradeQueue(tradeQueue().map((x) => (sameItem(x, it) ? { ...x, qty: x.qty - 1 } : x)));
            renderQueue();
          } catch (e) {
            fatal ||= e;   // l'autre envoi termine son objet, puis on s'arrête
          } finally {
            entry.reserved--;
            const left = inFlight.get(k) - 1;
            if (left > 0) inFlight.set(k, left); else inFlight.delete(k);
          }
          await sleep(80 + Math.random() * 170);
        }
      };
      await Promise.all(Array.from({ length: workers }, (_, w) => worker(w)));
      await sweepTradeListings(sent, (t) => skipped.push(t));
      if (fatal) throw fatal;
      ok = true;
      const avg = queueRun.done ? Math.round((Date.now() - runId) / queueRun.done) : 0;   // débit réel (envois en parallèle)
      say(queueRun.stop && tradeQueue().length
        ? `⏸ Arrêté : ${queueRun.done} objet(s) envoyé(s) à ${ctx.to} — le reste est toujours dans la file.`
        : `✔ Terminé${queueRun.done ? ` (~${avg} ms par objet)` : ''}.`, skipped.length ? '' : 'ok');
    } catch (e) {
      say(`❌ Envoi interrompu : ${e.message}${tradeQueue().length ? ' — le reste est toujours dans la file.' : ''}`, 'err');
    } finally {
      const done = queueRun.done;
      tradeBusy = false;
      queueRun = null;
      renderQueue();
      // le récap (stocké) reste affiché après le rechargement de la page
      if (ok && done && !skipped.length && /^\/(hdv|inventaire)/.test(location.pathname)) setTimeout(() => location.reload(), 2000);
    }
  }

  // ---------- Historique des échanges + récap de la dernière file ----------
  // cfg.tradeHistory : une ligne par exemplaire tenté (ou objet sauté), regroupées par envoi (run = horodatage du début).
  // cfg.tradeLastRun[personnage] : dernier envoi de la file, dont le récap reste affiché (même après rechargement) jusqu'à ✕.
  const HISTORY_MAX = 1000;
  const TRADE_STATUS = {
    ok: { icon: '✔', label: 'envoyé(s)', color: '#6cc070' },
    lost: { icon: '❌', label: 'perdu(s) — acheté(s) par un autre joueur', color: '#e0675c' },
    unsure: { icon: '⚠️', label: 'à vérifier — annonce peut-être encore en vente', color: '#e2b04a' },
    failed: { icon: '⛔', label: 'non envoyé(s) — toujours dans ton inventaire', color: '#e0975c' },
    skipped: { icon: '⏭', label: 'sauté(s)', color: '#9aa0a8' },
  };
  const STATUS_ORDER = ['lost', 'unsure', 'failed', 'skipped', 'ok'];

  function recordTrade(runId, ctx, item, status, detail = '', ms = null, qty = 1) {
    const line = { at: Date.now(), run: runId, seller: myName(), to: ctx?.to || null,
      name: item.name, lvl: item.lvl, fusion: item.fusion, qty, status, detail, ms };
    return save({ tradeHistory: [...(cfg.tradeHistory || []), line].slice(-HISTORY_MAX) });
  }
  const setLastRun = (run) => save({ tradeLastRun: { ...(cfg.tradeLastRun || {}), [queueKey()]: run } });

  // Lignes d'un envoi regroupées par statut puis par objet : { ok: [{ label, n, detail }], lost: […], … }
  function runGroups(rows) {
    const out = {};
    for (const h of rows) {
      const g = (out[h.status] ||= new Map());
      const label = itemLabel(h);
      const cur = g.get(label) || { label, n: 0, detail: h.detail };
      cur.n += h.qty || 1;
      g.set(label, cur);
    }
    for (const k in out) out[k] = [...out[k].values()];
    return out;
  }
  const countOf = (groups, st) => (groups[st] || []).reduce((n, x) => n + x.n, 0);
  const itemsText = (arr, withDetail) => arr.map((x) => `${x.label}${x.n > 1 ? ` ×${x.n}` : ''}${withDetail && x.detail ? ` (${x.detail})` : ''}`);

  // Récap HTML d'un envoi (panneau de la file et fenêtre d'historique).
  function recapHtml(rows, esc, { full = false } = {}) {
    const groups = runGroups(rows);
    return STATUS_ORDER.filter((st) => groups[st]?.length).map((st) => {
      const s = TRADE_STATUS[st];
      const n = countOf(groups, st);
      const detail = st !== 'ok';   // la raison n'est utile que pour ce qui n'est pas parti
      const items = itemsText(groups[st], detail);
      const shown = full || st !== 'ok' ? items : items.slice(0, 6).concat(items.length > 6 ? [`+ ${items.length - 6} autre(s)`] : []);
      return `<div style="color:${s.color}"><b>${s.icon} ${n} ${s.label}</b>${shown.length ? `<div style="color:#ccc;font-size:12px;margin:1px 0 3px 18px">${shown.map(esc).join('<br>')}</div>` : ''}</div>`;
    }).join('');
  }

  // Message court de fin d'envoi.
  function runShort(rows) {
    const g = runGroups(rows);
    const parts = STATUS_ORDER.slice().reverse().filter((st) => countOf(g, st)).map((st) => `${TRADE_STATUS[st].icon} ${countOf(g, st)}`);
    return parts.length ? `Terminé : ${parts.join(' · ')}` : '';
  }

  // Fenêtre « 🕘 Historique des échanges » : envois du plus récent au plus ancien, filtrables.
  function openHistory() {
    document.querySelector('.dm-history')?.remove();
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:6px 12px;color:#fff;cursor:pointer;font:600 13px system-ui,sans-serif';
    const ov = document.createElement('div');
    ov.className = 'dm-history dm-picker';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:#000a;display:grid;justify-items:center;align-items:start;padding:4vh 16px 16px;font:13px system-ui,sans-serif;color:#eee';
    ov.innerHTML = `
      <div style="width:min(680px,100%);max-height:88vh;display:flex;flex-direction:column;gap:10px;background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:14px;box-shadow:0 10px 40px #000">
        <div style="display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:15px">🕘 Historique des échanges${DM.tip('Chaque envoi (bouton « Échanger » ou file) avec ce qui est parti, ce qui a été perdu, ce qui n’a pas pu partir et pourquoi. Gardé dans Chrome (1000 dernières lignes), commun à tes deux comptes.')}</b><button data-a="x" style="${btn};background:transparent">✕</button></div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <select data-k="filter" style="background:#2a231a;border:1px solid #5a4a33;border-radius:8px;color:#eee;padding:5px 8px">
            <option value="">Tous les envois</option>
            <option value="problems">Seulement ceux avec pertes / échecs</option>
          </select>
          <span data-k="count" style="flex:1;color:#bbb"></span>
          <button data-a="clear" style="${btn};background:transparent">🗑 Vider</button>
        </div>
        <div data-k="list" style="overflow:auto;flex:1;min-height:120px;display:flex;flex-direction:column;gap:8px"></div>
      </div>`;
    document.body.appendChild(ov);
    const $ = (s) => ov.querySelector(s);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('keydown', (e) => e.stopPropagation());
    let clearArmed = false;

    function render() {
      const runs = new Map();
      for (const h of cfg.tradeHistory || []) (runs.get(h.run) || runs.set(h.run, []).get(h.run)).push(h);
      let list = [...runs.entries()].sort((a, b) => b[0] - a[0]);
      if ($('[data-k="filter"]').value === 'problems') list = list.filter(([, rows]) => rows.some((h) => h.status !== 'ok'));
      $('[data-k="count"]').textContent = `${list.length} envoi(s)`;
      $('[data-k="list"]').innerHTML = list.map(([run, rows]) => {
        const first = rows[0];
        const when = new Date(run).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        return `<details style="border:1px solid #3a3125;border-radius:10px;padding:8px 10px" ${rows.some((h) => h.status === 'lost' || h.status === 'unsure') ? 'open' : ''}>
          <summary style="cursor:pointer"><b>${esc(when)}</b> · ${esc(first.seller || '?')} → ${esc(first.to || '?')} · <span style="color:#bbb">${esc(runShort(rows).replace('Terminé : ', ''))}</span></summary>
          <div style="margin-top:6px;display:flex;flex-direction:column;gap:2px">${recapHtml(rows, esc, { full: true })}</div>
        </details>`;
      }).join('') || '<div style="padding:12px;color:#999;text-align:center">Aucun échange enregistré.</div>';
    }
    ov.addEventListener('click', async (e) => {
      if (e.target === ov) return close();
      const a = e.target.closest('button[data-a]')?.dataset.a;
      if (a === 'x') close();
      else if (a === 'clear') {
        if (!clearArmed) { clearArmed = true; e.target.textContent = '⚠️ Confirmer'; setTimeout(() => { clearArmed = false; if (ov.isConnected) e.target.textContent = '🗑 Vider'; }, 4000); return; }
        await save({ tradeHistory: [], tradeLastRun: {} });
        render();
      }
    });
    $('[data-k="filter"]').addEventListener('change', render);
    render();
  }

  // Panneau flottant (en haut à droite) sur /hdv et /inventaire tant que la file n'est pas vide.
  let queueBox = null, queueMsgText = '', queueMsgCls = '';
  let queueFolded = (() => { try { return localStorage.getItem('dmTradeQueueFolded') === '1'; } catch { return false; } })();
  function queueMsg(t, cls = '') {
    queueMsgText = t;
    queueMsgCls = cls;
    renderQueue();
  }

  function renderQueue() {
    if (dead) return;
    const q = tradeQueue();
    if (!/^\/(hdv|inventaire)/.test(location.pathname)) { queueBox?.remove(); queueBox = null; return; }
    if (!queueBox?.isConnected) {
      queueBox = document.createElement('div');
      queueBox.className = 'dm-queue';
      queueBox.style.cssText = 'position:fixed;top:72px;right:12px;z-index:2147483000;width:290px;max-width:calc(100vw - 24px);max-height:70vh;display:flex;flex-direction:column;gap:6px;padding:10px;border-radius:12px;background:#1d1812f2;border:1px solid #5a4a33;color:#eee;font:13px system-ui,sans-serif;box-shadow:0 6px 24px #000a';
      queueBox.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        e.preventDefault();
        e.stopPropagation();
        if (b.dataset.act === 'run') runQueue();
        else if (b.dataset.act === 'stop' && queueRun) { queueRun.stop = true; queueMsg('Arrêt après l’objet en cours…'); }
        else if (b.dataset.act === 'clear' && !tradeBusy) { queueMsgText = ''; setTradeQueue([]); }
        else if (b.dataset.act === 'pick' && !tradeBusy) openPicker();
        else if (b.dataset.act === 'history') openHistory();
        else if (b.dataset.act === 'recapClose') { const lr = cfg.tradeLastRun?.[queueKey()]; if (lr) setLastRun({ ...lr, dismissed: true }); }
        else if (b.dataset.act === 'fold') {
          queueFolded = !queueFolded;
          try { localStorage.setItem('dmTradeQueueFolded', queueFolded ? '1' : '0'); } catch { /* stockage indisponible */ }
          renderQueue();
        }
        else if (b.dataset.rm != null && !tradeBusy) setTradeQueue(q.filter((_, i) => i !== +b.dataset.rm));
      });
      document.body.appendChild(queueBox);
    }
    const total = q.reduce((n, it) => n + it.qty, 0);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:4px 10px;color:#fff;cursor:pointer;font:600 12px system-ui,sans-serif';
    const color = queueMsgCls === 'err' ? '#e0675c' : queueMsgCls === 'ok' ? '#6cc070' : '#bbb';
    // récap du dernier envoi de la file (jusqu'à ✕), affiché sous la file
    const lr = cfg.tradeLastRun?.[queueKey()];
    const lrRows = lr && !lr.dismissed && !queueRun ? (cfg.tradeHistory || []).filter((h) => h.run === lr.id) : [];
    const recap = lrRows.length ? `<div style="border-top:1px solid #3a3125;padding-top:6px;display:flex;flex-direction:column;gap:2px;overflow:auto">
        <div style="display:flex;align-items:center;gap:6px"><b style="flex:1">📊 Récap ${esc(new Date(lr.id).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }))} → ${esc(lr.to || '?')}</b>
          <button data-act="history" style="${btn};padding:2px 7px;background:transparent">Détails</button>
          <button data-act="recapClose" title="Masquer le récap" style="${btn};padding:2px 7px;background:transparent">✕</button></div>
        ${recapHtml(lrRows, esc)}</div>` : '';
    const head = `<div style="display:flex;align-items:center;gap:6px"><b style="flex:1">🔁 File d’échange (${total})${DM.tip("Objets à envoyer à ton autre compte (connecté en navigation privée ou normale). « Tout échanger » met chaque exemplaire en vente à 1 kamas et le fait acheter aussitôt par l’autre compte. File propre à chaque personnage.")}</b>
        <button data-act="pick" data-tip="Ouvre la liste de tous tes objets vendables, avec filtres (nom, rareté, emplacement, niveau) et cases à cocher, pour remplir la file d’un coup." style="${btn};background:#5a4a33" ${tradeBusy ? 'disabled' : ''}>📋 Sélection</button>
        <button data-act="history" data-tip="Historique de tous les échanges : objets envoyés, perdus, non envoyés et pourquoi." style="${btn};padding:4px 7px;background:transparent">🕘</button>
        <button data-act="fold" title="${queueFolded ? 'Déplier' : 'Replier'}" style="${btn};padding:4px 7px;background:transparent">${queueFolded ? '▾' : '▴'}</button></div>`;
    const html = queueFolded && !queueRun ? head : `
      ${head}
      <ul style="list-style:none;margin:0;padding:0;overflow:auto;display:flex;flex-direction:column;gap:2px">
        ${q.map((it, i) => `<li style="display:flex;align-items:center;gap:6px"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(itemLabel(it))} (niv. ${it.lvl})">${esc(itemLabel(it))}</span>${it.qty > 1 ? `<b>×${it.qty}</b>` : ''}<button data-rm="${i}" title="Retirer de la file" style="${btn};padding:0 6px;background:transparent" ${tradeBusy ? 'disabled' : ''}>✕</button></li>`).join('') || '<li style="color:#999">Vide : 📋 Sélection, ou « ➕ File » sur un objet.</li>'}
      </ul>
      <div style="display:flex;gap:6px">${queueRun
        ? `<button data-act="stop" style="${btn};flex:1;background:#8a2b2b">⏸ Arrêter (${queueRun.done}/${queueRun.total})</button>`
        : q.length ? `<button data-act="run" style="${btn};flex:1;background:#2b5d8a">🔁 Tout échanger</button><button data-act="clear" style="${btn};background:transparent">Vider</button>` : ''}</div>
      <div style="color:${color};font-size:12px;min-height:1em">${esc(queueMsgText)}</div>
      ${recap}`;
    if (queueBox.dmHtml !== html) { queueBox.dmHtml = html; queueBox.innerHTML = html; }
  }

  // ---------- Sélecteur multiple : tous les objets vendables, filtres, cases à cocher ----------
  // Le résultat remplace la file (les objets déjà en file arrivent pré-cochés avec leur quantité).
  const SLOT_NAMES = { amulette: 'Amulette', chapeau: 'Chapeau', cape: 'Cape', ceinture: 'Ceinture', bottes: 'Bottes', anneau: 'Anneau', arme: 'Arme', bouclier: 'Bouclier', familier: 'Familier', dofus: 'Dofus / Trophée' };
  const PICK_FILTERS_KEY = 'dmTradePickFilters';

  async function openPicker() {
    document.querySelector('.dm-picker')?.remove();
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const ov = document.createElement('div');
    ov.className = 'dm-picker';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:#000a;display:grid;justify-items:center;align-items:start;padding:4vh 16px 16px;font:13px system-ui,sans-serif;color:#eee';
    ov.innerHTML = '<div style="background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:16px">Chargement des objets…</div>';
    document.body.appendChild(ov);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => e.stopPropagation());   // pas de raccourcis du jeu pendant la saisie

    let entries;
    try {
      entries = (await fetchSellable({ tradable: true })).entries;
    } catch (e) {
      ov.firstElementChild.textContent = `❌ ${e.message}`;
      return;
    }
    const now = Date.now();
    const rows = entries.map((e, i) => ({
      ...e, key: i,
      bound: !!e.boundUntil && new Date(e.boundUntil) > now,
      locked: !!cfg.lockedItems?.[DM.lockKey(e.name, e.lvl)],
    })).sort((a, b) => b.rarity - a.rarity || b.lvl - a.lvl || a.name.localeCompare(b.name) || a.fusion - b.fusion);

    // sélection : key → quantité ; pré-remplie avec la file actuelle
    const sel = new Map();
    for (const it of tradeQueue()) {
      const r = rows.find((x) => !x.bound && sameItem(x, it));
      if (r) sel.set(r.key, Math.min(it.qty, r.qty));
    }

    const NO_FILTERS = { q: '', rarity: '', slot: '', tier: '', min: '', max: '', hideBound: true, hideLocked: true };
    // filtre de fusion : '' tous · radiant = Rayonnants (tier max) · fused = fusionnés (Tiers 2 et +) · base = sans fusion · notRadiant
    const TIER_FILTERS = {
      radiant: (fu) => fu >= FUSION_MAX,
      fused: (fu) => fu > 0,
      base: (fu) => !fu,
      notRadiant: (fu) => fu < FUSION_MAX,
    };
    let f = { ...NO_FILTERS };
    try { f = { ...f, ...JSON.parse(localStorage.getItem(PICK_FILTERS_KEY) || '{}'), q: '' }; } catch { /* stockage indisponible */ }
    const slots = [...new Set(rows.map((r) => r.slot))].filter(Boolean).sort();
    const inp = 'background:#2a231a;border:1px solid #5a4a33;border-radius:8px;color:#eee;padding:5px 8px;font:13px system-ui,sans-serif';
    const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:6px 12px;color:#fff;cursor:pointer;font:600 13px system-ui,sans-serif';
    ov.innerHTML = `
      <div style="width:min(760px,100%);max-height:88vh;display:flex;flex-direction:column;gap:10px;background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:14px;box-shadow:0 10px 40px #000">
        <div style="display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:15px">📋 Sélection d’objets à échanger${DM.tip("Tous tes objets échangeables : les objets équipés, éternels (gardés au Prestige, liés au compte) et verrouillés n’apparaissent pas, les objets liés (achetés il y a moins de 24 h) ne peuvent pas être cochés. Coche ceux à envoyer ; Maj + clic coche une plage ; pour un objet en plusieurs exemplaires, choisis la quantité à droite.")}</b><button data-a="x" style="${btn};background:transparent">✕</button></div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
          <input data-f="q" placeholder="Rechercher un nom…" style="${inp};flex:1;min-width:150px">
          <select data-f="rarity" style="${inp}"><option value="">Toutes raretés</option>${DM.RARITIES.map((r, i) => `<option value="${i}">${r}</option>`).join('')}</select>
          <select data-f="slot" style="${inp}"><option value="">Tous emplacements</option>${slots.map((s) => `<option value="${s}">${esc(SLOT_NAMES[s] || s)}</option>`).join('')}</select>
          <select data-f="tier" style="${inp}" data-tip="Filtrer selon le tier de fusion : Rayonnants (tier maximum ★), objets fusionnés (Tiers 2 et plus), objets sans fusion, ou tout sauf les Rayonnants.">
            <option value="">Tous tiers</option>
            <option value="radiant">★ Rayonnants (${rows.filter((r) => r.fusion >= FUSION_MAX).length})</option>
            <option value="fused">Fusionnés (Tiers 2+)</option>
            <option value="base">Sans fusion</option>
            <option value="notRadiant">Hors Rayonnants</option>
          </select>
          <input data-f="min" type="number" min="1" placeholder="Niv. min" style="${inp};width:80px">
          <input data-f="max" type="number" min="1" placeholder="Niv. max" style="${inp};width:80px">
          <label style="white-space:nowrap"><input data-f="hideBound" type="checkbox"> masquer liés${DM.tip("Cache les objets achetés à l’HDV il y a moins de 24 h : ils te sont liés et ne peuvent pas encore être revendus ni échangés.")}</label>
          <label style="white-space:nowrap"><input data-f="hideLocked" type="checkbox"> masquer 🔒${DM.tip("Cache les objets que tu as verrouillés contre l’Autosell.")}</label>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <button data-a="all" style="${btn};background:#3a3125" data-tip="Coche tous les objets visibles avec les filtres actuels (tous leurs exemplaires). Combine avec les filtres pour sélectionner en masse.">☑ Cocher les objets affichés</button>
          <button data-a="none" style="${btn};background:transparent">☐ Tout décocher</button>
          <button data-a="reset" style="${btn};background:transparent" data-tip="Remet tous les filtres à zéro (recherche, rareté, emplacement, niveaux) pour réafficher tous tes objets.">↺ Filtres</button>
          <span data-k="count" style="flex:1;text-align:right;color:#bbb"></span>
        </div>
        <ul data-k="list" style="list-style:none;margin:0;padding:0;overflow:auto;flex:1;min-height:120px;border:1px solid #3a3125;border-radius:10px"></ul>
        <div style="font-size:11px;color:#999">Astuce : Maj + clic coche/décoche toute la plage depuis la dernière case cliquée.</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button data-a="x" style="${btn};background:transparent">Annuler</button>
          <button data-a="save" style="${btn};background:#5a4a33" data-tip="Remplace la file d’échange par cette sélection, sans rien envoyer.">➕ Mettre en file</button>
          <button data-a="go" style="${btn};background:#2b5d8a" data-tip="Met la sélection en file et lance tout de suite l’envoi vers ton autre compte.">🔁 Échanger maintenant</button>
        </div>
      </div>`;
    const $ = (s) => ov.querySelector(s);
    const list = $('[data-k="list"]');
    const saveFilters = () => { try { localStorage.setItem(PICK_FILTERS_KEY, JSON.stringify(f)); } catch { /* stockage indisponible */ } };
    // Affiche `f` dans les champs, puis relit les champs : un filtre mémorisé qui n'existe plus dans la liste
    // (ex. emplacement « Dofus » alors qu'il n'y a plus de Dofus) retombe sur « Tous » au lieu de tout cacher en silence.
    const syncFilters = () => {
      for (const el of ov.querySelectorAll('[data-f]')) {
        const k = el.dataset.f;
        if (el.type === 'checkbox') el.checked = !!f[k]; else el.value = f[k] ?? '';
        f[k] = el.type === 'checkbox' ? el.checked : el.value;
      }
      saveFilters();
    };
    for (const el of ov.querySelectorAll('[data-f]')) {
      el.addEventListener('input', () => {
        f[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value;
        saveFilters();
        renderList();
      });
    }
    syncFilters();

    let visible = [], lastIdx = null;
    const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    function filtered() {
      const q = norm(f.q.trim());
      return rows.filter((r) => (!q || norm(r.name).includes(q))
        && (f.rarity === '' || r.rarity === +f.rarity)
        && (!f.slot || r.slot === f.slot)
        && (!TIER_FILTERS[f.tier] || TIER_FILTERS[f.tier](r.fusion))
        && (!f.min || r.lvl >= +f.min) && (!f.max || r.lvl <= +f.max)
        && !(f.hideBound && r.bound) && !(f.hideLocked && r.locked));
    }
    function renderCount() {
      const n = [...sel.values()].reduce((a, b) => a + b, 0);
      $('[data-k="count"]').textContent = `${sel.size} objet(s) · ${n} exemplaire(s) sélectionné(s) — ${visible.length} affiché(s) sur ${rows.length}`;
    }
    function renderList() {
      visible = filtered();
      lastIdx = null;
      list.innerHTML = visible.map((r, i) => {
        const on = sel.has(r.key);
        const tier = r.fusion >= FUSION_MAX ? ' <span style="color:#ffd76a;font-size:11px;font-weight:800">· ★ Rayonnant</span>'
          : r.fusion ? ` <span style="color:#e2b04a;font-size:11px">· Tiers ${r.fusion + 1}</span>` : '';
        const note = r.bound ? `<span style="color:#7cb7e8;font-size:11px">lié jusqu’à ${esc(new Date(r.boundUntil).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}</span>` : r.locked ? '<span style="font-size:11px">🔒</span>' : '';
        const qty = r.qty > 1 && !r.bound
          ? `<input data-qty="${i}" type="number" min="1" max="${r.qty}" value="${sel.get(r.key) || r.qty}" style="${inp};width:58px;padding:2px 4px" data-tip="Exemplaires à échanger (sur ${r.qty})"> / ${r.qty}`
          : '';
        return `<li style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-bottom:1px solid #2a231a;${r.bound ? 'opacity:.5' : ''}">
          <input data-i="${i}" type="checkbox" ${on ? 'checked' : ''} ${r.bound ? 'disabled' : ''} style="width:16px;height:16px">
          <img src="/img/items/${+r.icon}.png" alt="" width="28" height="28" loading="lazy" style="object-fit:contain">
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span class="rarity-${+r.rarity} rarity-text" style="font-weight:700">${esc(r.name)}</span>${tier}
            <span style="color:#999;font-size:11px">· niv. ${r.lvl} · ${esc(SLOT_NAMES[r.slot] || r.slot || '')}</span> ${note}</span>
          <span style="white-space:nowrap;color:#bbb">${qty}</span></li>`;
      }).join('') || `<li style="padding:12px;color:#999;text-align:center">${rows.length
        ? `Aucun objet pour ces filtres (${rows.length} objet(s) masqué(s)). <button data-a="reset" style="${btn};background:#3a3125;margin-left:6px">↺ Réinitialiser les filtres</button>`
        : 'Aucun objet vendable dans ton inventaire (les objets équipés ne peuvent pas être échangés).'}</li>`;
      renderCount();
    }

    list.addEventListener('click', (e) => {
      const cb = e.target.closest('input[data-i]');
      if (!cb) {   // clic sur la ligne (hors champ quantité) = coche la case
        const li = e.target.closest('li');
        const box = li?.querySelector('input[data-i]');
        if (box && !box.disabled && !e.target.closest('input')) { box.click(); }
        return;
      }
      const i = +cb.dataset.i;
      const set = (j, on) => {
        const r = visible[j];
        if (r.bound) return;
        if (on) sel.set(r.key, +list.querySelector(`[data-qty="${j}"]`)?.value || r.qty); else sel.delete(r.key);
        const c = list.querySelector(`input[data-i="${j}"]`);
        if (c) c.checked = on;
      };
      if (e.shiftKey && lastIdx != null) {
        for (let j = Math.min(lastIdx, i); j <= Math.max(lastIdx, i); j++) set(j, cb.checked);
      } else set(i, cb.checked);
      lastIdx = i;
      renderCount();
    });
    list.addEventListener('input', (e) => {
      const qi = e.target.closest('input[data-qty]');
      if (!qi) return;
      const r = visible[+qi.dataset.qty];
      const n = Math.max(1, Math.min(r.qty, Math.floor(+qi.value) || 1));
      if (sel.has(r.key)) sel.set(r.key, n);
      renderCount();
    });

    async function commit() {
      const q = rows.filter((r) => sel.has(r.key)).map((r) => ({ name: r.name, lvl: r.lvl, fusion: r.fusion, qty: sel.get(r.key) }));
      await setTradeQueue(q);
      queueMsg(`📋 ${q.length} objet(s) en file.`);
      return q.length;
    }
    ov.addEventListener('click', async (e) => {
      const a = e.target.closest('button[data-a]')?.dataset.a;
      if (a === 'x') close();
      else if (a === 'all') { for (const r of visible) if (!r.bound) sel.set(r.key, sel.get(r.key) || r.qty); renderList(); }
      else if (a === 'none') { sel.clear(); renderList(); }
      else if (a === 'reset') { f = { ...NO_FILTERS }; syncFilters(); renderList(); }
      else if (a === 'save') { await commit(); close(); }
      else if (a === 'go') { const n = await commit(); close(); if (n) runQueue(); }
    });
    renderList();
    $('[data-f="q"]').focus();
  }

  // Boutons « 🔁 Échanger » et « ➕ File » : sous « Vendre au marchand » (/inventaire) et sous « Mettre en vente » (/hdv?onglet=vendre).
  function tradeAnchors() {
    if (location.pathname.startsWith('/inventaire')) {
      return [...document.querySelectorAll('div.text-sm.text-muted')]
        .filter((l) => l.textContent.trim() === 'Vendre au marchand' && l.nextElementSibling)
        .map((l) => l.parentElement);
    }
    if (location.pathname.startsWith('/hdv')) {
      return [...document.querySelectorAll('button.btn-gold')].filter((b) => b.textContent.trim() === 'Mettre en vente');
    }
    return [];
  }

  function scanTradeButtons() {
    renderQueue();
    // Panneau refermé : React retire ses propres nœuds mais pas le nôtre.
    const anchors = tradeAnchors();
    for (const w of document.querySelectorAll('.dm-trade')) {
      if (!anchors.includes(w.previousElementSibling)) w.remove();
    }
    for (const anchor of anchors) {
      let wrap = anchor.nextElementSibling;
      if (!wrap?.classList.contains('dm-trade')) {
        wrap = document.createElement('div');
        wrap.className = 'dm-trade';
        wrap.style.cssText = 'margin-top:8px';
        wrap.innerHTML = '<div style="display:flex;gap:6px">'
          + '<button type="button" data-k="go" class="btn !py-1.5 text-sm" style="flex:1;background:#2b5d8a;color:#fff;border-color:#2b5d8a" data-tip="Met cet objet en vente à 1 kamas à l’HDV et le fait acheter immédiatement par ton autre compte (autre fenêtre, normale ↔ privée). Si l’achat échoue, l’annonce est retirée.">🔁 Échanger (1 K → autre compte)</button>'
          + '<button type="button" data-k="add" class="btn !py-1.5 text-sm" style="white-space:nowrap;background:transparent" data-tip="Ajouter à la file d’échange (re-cliquer = un exemplaire de plus)">➕ File</button>'
          + '</div><div class="text-xs" style="margin-top:4px;min-height:1em"></div>';
        const go = wrap.querySelector('[data-k="go"]');
        const add = wrap.querySelector('[data-k="add"]');
        const msg = wrap.lastElementChild;
        const say = (t, cls) => { msg.textContent = t; msg.style.color = cls === 'err' ? '#e0675c' : cls === 'ok' ? '#6cc070' : ''; };
        add.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const it = itemFromPanel(panelOf(wrap));
          if (!it) return say('❌ Objet illisible', 'err');
          const n = queueAdd(it);
          say(`➕ ${itemLabel(it)} dans la file${n > 1 ? ` (×${n})` : ''}`, 'ok');
        });
        go.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (tradeBusy) return;
          tradeBusy = true;
          go.disabled = true;
          try {
            say(await tradeItem(panelOf(wrap), say), 'ok');
            if (/^\/(hdv|inventaire)/.test(location.pathname)) setTimeout(() => location.reload(), 1500);
          } catch (err) {
            say(`❌ ${err.message}`, 'err');
          } finally {
            tradeBusy = false;
            go.disabled = false;
          }
        });
        anchor.after(wrap);
      }
      // Autre objet sélectionné : on efface le message du précédent.
      const key = JSON.stringify(itemFromPanel(panelOf(wrap)));
      if (wrap.dataset.key !== key && !tradeBusy) { wrap.dataset.key = key; wrap.lastElementChild.textContent = ''; }
    }
  }

  // Ajouts dans les pages du jeu, selon les modules activés (un module désactivé retire ses boutons).
  function scanModules() {
    if (modOn('autosell')) scanLockButtons(); else document.querySelectorAll('.dm-lock').forEach((el) => el.remove());
    if (modOn('trade')) scanTradeButtons(); else { document.querySelectorAll('.dm-trade').forEach((el) => el.remove()); document.querySelector('.dm-queue')?.remove(); }
    if (modOn('wanted')) highlightWanted();
    if (modOn('fusion')) scanFuseButtons(); else document.querySelectorAll('.dm-fuse-all').forEach((el) => el.remove());
    scanUnequipAllButton();
    scanManualWeightsButton();
    scanDeckButton();
  }

  let lockScanQueued = false;
  const domObserver = new MutationObserver(() => {
    if (dead || lockScanQueued) return;
    lockScanQueued = true;
    requestAnimationFrame(() => {
      lockScanQueued = false;
      scanModules();
      if (isOwner() && !busy && location.pathname.startsWith('/combat') && endTitle()) tick();   // écran de fin affiché : relance sans attendre
    });
  }).observe(document.documentElement, { childList: true, subtree: true });

  async function runAutosell(dryRun) {
    try {
      const r = await autosell(dryRun);
      if (!dryRun && r.count && location.pathname.startsWith('/inventaire')) setTimeout(() => location.reload(), 1500);
      return r;
    } catch (e) {
      sellActionId = null;   // l'ID a peut-être changé (nouveau déploiement) : on le relira
      return { ok: false, error: e.message || String(e) };
    }
  }

  // ---------- Fusion : 3 exemplaires d'un même tiers → 1 du tiers suivant (+10 % de stats), jusqu’au tier 5 « Rayonnant » (fusion 4) ----------
  // Server action « fuseItem(itemId, fusion) » → { newFusion } ou { error }. Les objets portés ne sont pas dans `entries`.
  const FUSE_ACTION_FALLBACK = '60e1cb4d715df40bfc2d5e6af8032e5ae119fd0915';
  const FUSE_COPIES = 3;
  let fuseActionId = null, fuseChunks = null;
  const tierLabel = (f) => (f >= FUSION_MAX ? 'Rayonnant ★' : f ? `T${f + 1}` : 'base');   // comme le jeu : fusion 1 = « Tiers 2 »

  // Objets fusionnables, regroupés par objet : fusions en cascade simulées (3 base → 1 T1 ; 3 T1 → 1 T2…).
  async function fusePlan() {
    const { entries, chunks } = await fetchInventory();
    fuseChunks = chunks;
    const byId = new Map();
    for (const e of entries) {
      if (e.fusion >= FUSION_MAX) continue;
      const g = byId.get(e.id) || { id: e.id, name: e.name, lvl: e.lvl, rarity: e.rarity, tiers: {} };
      g.tiers[e.fusion] = (g.tiers[e.fusion] || 0) + e.qty;
      byId.set(e.id, g);
    }
    const plan = [];
    for (const g of byId.values()) {
      const t = { ...g.tiers };
      const steps = [];
      for (let f = 0; f < FUSION_MAX; f++) {
        while ((t[f] || 0) >= FUSE_COPIES) {
          steps.push(f);
          t[f] -= FUSE_COPIES;
          t[f + 1] = (t[f + 1] || 0) + 1;
        }
      }
      if (!steps.length) continue;
      const best = Math.max(...Object.keys(t).filter((f) => t[f] > 0).map(Number));
      plan.push({ ...g, steps, best, after: t });
    }
    return plan.sort((a, b) => b.best - a.best || b.lvl - a.lvl || a.name.localeCompare(b.name));
  }

  // Exécute les fusions de `items` (sous-ensemble de fusePlan) ; s'arrête à la première erreur.
  async function fuseItems(items, onProgress) {
    if (!fuseActionId) fuseActionId = await findAction(fuseChunks || (await fetchFlight('/inventaire')).chunks, 'fuseItem', FUSE_ACTION_FALLBACK);
    let done = 0;
    const total = items.reduce((n, it) => n + it.steps.length, 0);
    for (const it of items) {
      for (const f of it.steps) {
        const r = await callAction('inventaire', fuseActionId, [it.id, f]);
        if (r.newFusion !== f + 1) throw new Error(`${it.name} : réponse inattendue (${JSON.stringify(r)})`);
        done++;
        onProgress?.(done, total, it);
        if (done < total) await sleep(400 + Math.random() * 400);
      }
    }
    DM.log(`fusion: ${done} fusion(s) sur ${items.length} objet(s)`);
    return done;
  }

  // Bouton « ⚡ Tout fusionner » sous le bouton du jeu « Fusionner 3 → Tiers 2 (130/3) » (fiche d'objet de /inventaire) :
  // enchaîne toutes les fusions possibles à ce tier (130/3 → 43), sans cascade vers les tiers suivants. 2e clic = confirmation.
  // Le jeu désactive son bouton (objet verrouillé, pas assez d'exemplaires) : le nôtre suit.
  // Bouton « Tout retirer » à gauche de « Vendre (ou briser) plusieurs objets » (/inventaire) : retire tous les objets
  // portés, emplacement par emplacement (server action « unequipItem(emplacement) »). 2e clic = confirmation.
  const UNEQUIP_ACTION_FALLBACK = '405fdd8f47dcc7595578823c1750c0209b9a25b227';
  function scanUnequipAllButton() {
    if (!location.pathname.startsWith('/inventaire')) return;
    const anchor = [...document.querySelectorAll('button')].find((b) => /^(Vendre ou briser plusieurs objets|Vendre plusieurs objets|Quitter la sélection)$/.test(b.textContent.trim()));
    if (!anchor || anchor.previousElementSibling?.classList.contains('dm-unequip-all')) return;
    document.querySelector('.dm-unequip-all')?.remove();
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-ghost !py-1.5 text-sm ml-auto min-h-9 dm-unequip-all';
    b.textContent = '🧺 Tout retirer';
    b.title = 'Autopilot-DM : retire tous les objets portés (2e clic pour confirmer). La page se recharge à la fin.';
    b.addEventListener('click', onUnequipAll);
    anchor.before(b);
  }

  async function onUnequipAll(e) {
    const btn = e.currentTarget;
    if (btn.dataset.busy) return;
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = '⚠️ Confirmer : tout retirer';
      setTimeout(() => { if (!btn.dataset.busy) { delete btn.dataset.armed; btn.textContent = '🧺 Tout retirer'; } }, 6000);
      return;
    }
    delete btn.dataset.armed;
    btn.dataset.busy = '1';
    btn.disabled = true;
    let done = 0, failed = 0;
    try {
      btn.textContent = 'Lecture de l’équipement…';
      const { slots, chunks } = await fetchEquipState();
      const worn = slots.filter((s) => s.cur);
      const id = await findAction(chunks, 'unequipItem', UNEQUIP_ACTION_FALLBACK);
      for (const s of worn) {
        btn.textContent = `Retrait ${done + failed + 1}/${worn.length}…`;
        try {
          await callAction('inventaire', id, [s.slot]);
          done++;
        } catch (err) {
          failed++;
          DM.log(`tout retirer : ${s.label || s.slot} (${s.cur.name}) : ${err.message}`);
        }
        await sleep(150);
      }
      DM.log(`tout retirer : ${done} objet(s) retiré(s)${failed ? `, ${failed} échec(s)` : ''}`);
      tradeToast(worn.length ? `🧺 ${done} objet(s) retiré(s)${failed ? ` · ${failed} échec(s) (voir le journal)` : ''}` : '🧺 Aucun objet porté.', failed ? 'err' : 'ok');
    } catch (err) {
      tradeToast(`🧺 Échec : ${err.message}`, 'err');
    } finally {
      delete btn.dataset.busy;
      btn.disabled = false;
      btn.textContent = '🧺 Tout retirer';
      if (done) setTimeout(() => location.reload(), 1200);
    }
  }

  function scanFuseButtons() {
    if (!location.pathname.startsWith('/inventaire')) return;
    for (const b of document.querySelectorAll('aside button.btn-gold')) {
      const m = b.textContent.match(/Fusionner\s*\d+\s*→\s*(.+?)\s*\((\d+)\s*\/\s*(\d+)\)/);
      let extra = b.nextElementSibling?.classList.contains('dm-fuse-all') ? b.nextElementSibling : null;
      const n = m ? Math.floor(+m[2] / +m[3]) : 0;
      const target = !m ? 0 : /Rayonnant/.test(m[1]) ? FUSION_MAX : +(m[1].match(/T(?:iers\s*)?(\d)/)?.[1] || 0) - 1;
      if (n < 2 || target < 1) { if (!extra?.dataset.busy) extra?.remove(); continue; }
      if (!extra) {
        extra = document.createElement('button');
        extra.type = 'button';
        extra.className = 'btn btn-ghost w-full dm-fuse-all';
        extra.title = 'Autopilot-DM : enchaîne toutes les fusions possibles à ce tier (2e clic pour confirmer). La page se recharge à la fin.';
        extra.addEventListener('click', onFuseAll);
        b.after(extra);
      }
      const key = `${target}|${m[2]}`;
      if (extra.dataset.key !== key && !extra.dataset.busy && !extra.dataset.armed) {
        Object.assign(extra.dataset, { key, n, from: target - 1 });
        extra.textContent = `⚡ Tout fusionner : ${n} fusions → ${n} × ${tierLabel(target)}`;
      }
      extra.disabled = b.disabled || !!extra.dataset.busy;
    }
  }

  async function onFuseAll(e) {
    const btn = e.currentTarget;
    if (btn.dataset.busy) return;
    const n = +btn.dataset.n, from = +btn.dataset.from;
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = `⚠️ Confirmer : ${n} fusions (${n * FUSE_COPIES} exemplaires)`;
      setTimeout(() => {
        if (!btn.dataset.armed || btn.dataset.busy) return;
        delete btn.dataset.armed;
        btn.dataset.key = '';
        scanFuseButtons();
      }, 6000);
      return;
    }
    delete btn.dataset.armed;
    btn.dataset.busy = '1';
    btn.disabled = true;
    try {
      btn.textContent = 'Lecture de l’inventaire…';
      const { entries, chunks } = await fetchInventory();
      fuseChunks = chunks;
      // l'objet affiché : nom présent dans la fiche, au bon tier (le plus long si plusieurs noms correspondent)
      const text = btn.closest('aside')?.textContent || '';
      const it = entries.filter((x) => x.fusion === from && x.qty >= FUSE_COPIES && text.includes(x.name))
        .sort((a, b) => b.name.length - a.name.length)[0];
      if (!it) throw new Error('objet introuvable dans l’inventaire');
      const steps = new Array(Math.min(n, Math.floor(it.qty / FUSE_COPIES))).fill(from);
      await fuseItems([{ id: it.id, name: it.name, steps }], (k, total) => { btn.textContent = `Fusion ${k}/${total} : ${it.name}…`; });
      btn.textContent = `✔ ${steps.length} fusions faites — rechargement…`;
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      fuseActionId = null;   // l'ID a peut-être changé (nouveau déploiement)
      delete btn.dataset.busy;
      btn.disabled = false;
      btn.textContent = `❌ ${err.message || err} — recliquer pour réessayer`;
    }
  }


  // ---------- Auto-équipement : meilleurs objets pour 5 caractéristiques (dont 2 facultatives) par ordre de priorité ----------
  // Server action « equipItem(itemId, fusion, emplacement) » sur /inventaire → {} ou { error }.
  // Emplacements (props.slots de /inventaire) : chapeau, cape, amulette, anneau1-2, ceinture, bottes, arme, bouclier,
  // familier, dofus1-6 ; chacun « accepte » un type d'objet (champ s de l'objet). Les objets portés ne sont pas dans entries.
  const EQUIP_ACTION_FALLBACK = '706383ea472542e23da3f7d81239188959e316dda0';
  // Poids des stats choisies, par position : la 1re décide, les suivantes départagent / ajoutent un peu de valeur.
  // Les 4e et 5e sont facultatives (poids faibles) : non choisies, elles ne changent rien.
  const EQUIP_WEIGHTS = [1, 0.35, 0.15, 0.08, 0.04];
  const EQUIP_N = EQUIP_WEIGHTS.length;
  // Constantes du jeu (FUSION et libellés), pour calculer les stats réelles d'un objet fusionné comme le site.
  const FUSION_RULES = { stepPct: 10, excluded: ['pa', 'pm', 'po', 'invocations'], dofusRadiantPct: 100, radiantPa: 2 };
  const STAT_LABELS = { pv: 'Points de vie', pa: 'PA', pm: 'PM', po: 'Portée', invocations: 'Invocations', vitalite: 'Vitalité', sagesse: 'Sagesse', force: 'Force', intelligence: 'Intelligence', chance: 'Chance', agilite: 'Agilité', critique: '% Critique', prospection: 'Prospection', initiative: 'Initiative', puissance: 'Puissance', soins: 'Soins', dommages: 'Dommages', dommagesTerre: 'Dommages Terre', dommagesFeu: 'Dommages Feu', dommagesEau: 'Dommages Eau', dommagesAir: 'Dommages Air', dommagesNeutre: 'Dommages Neutre', dommagesCritiques: 'Dommages Critiques', resCritiques: 'Résistance Critiques', dommagesPoussee: 'Dommages Poussée', resPoussee: 'Résistance Poussée', resPctTerre: '% Résistance Terre', resPctFeu: '% Résistance Feu', resPctEau: '% Résistance Eau', resPctAir: '% Résistance Air', resPctNeutre: '% Résistance Neutre', resTerre: 'Résistance Terre', resFeu: 'Résistance Feu', resEau: 'Résistance Eau', resAir: 'Résistance Air', resNeutre: 'Résistance Neutre', fuite: 'Fuite', tacle: 'Tacle', esquivePA: 'Esquive PA', esquivePM: 'Esquive PM', retraitPA: 'Retrait PA', retraitPM: 'Retrait PM', renvoi: 'Renvoi de dommages', pods: 'Pods', dmgPctDistance: '% Dommages distance', dmgPctMelee: '% Dommages mêlée', dmgPctArmes: '% Dommages d’armes', dmgPctSorts: '% Dommages aux sorts', resPctDistance: '% Résistance distance', resPctMelee: '% Résistance mêlée', resPctAll: '% Résistance (tous éléments)', resAll: 'Réduction de dommages' };
  const STAT_ORDER = ['pa', 'pm', 'po', 'invocations', 'vitalite', 'sagesse', 'force', 'intelligence', 'chance', 'agilite', 'puissance', 'critique', 'dommages', 'dommagesNeutre', 'dommagesTerre', 'dommagesFeu', 'dommagesEau', 'dommagesAir', 'dommagesCritiques', 'dommagesPoussee', 'soins', 'prospection', 'initiative', 'resPctNeutre', 'resPctTerre', 'resPctFeu', 'resPctEau', 'resPctAir', 'resNeutre', 'resTerre', 'resFeu', 'resEau', 'resAir', 'resCritiques', 'resPoussee', 'tacle', 'fuite', 'retraitPA', 'retraitPM', 'esquivePA', 'esquivePM', 'renvoi', 'dmgPctSorts', 'dmgPctArmes', 'dmgPctMelee', 'dmgPctDistance', 'resPctMelee', 'resPctDistance', 'pods'];
  // Emplacements dans l'ordre de la grille du menu (emoji affiché tant qu'on ne connaît pas l'objet porté).
  const EQUIP_SLOTS = [
    { slot: 'chapeau', label: 'Chapeau', em: '🎩' }, { slot: 'amulette', label: 'Amulette', em: '📿' },
    { slot: 'cape', label: 'Cape', em: '🧥' }, { slot: 'familier', label: 'Familier', em: '🐾' },
    { slot: 'anneau1', label: 'Anneau 1', em: '💍' }, { slot: 'anneau2', label: 'Anneau 2', em: '💍' },
    { slot: 'ceinture', label: 'Ceinture', em: '🎗️' }, { slot: 'bottes', label: 'Bottes', em: '👢' },
    { slot: 'arme', label: 'Arme', em: '⚔️' }, { slot: 'bouclier', label: 'Bouclier', em: '🛡️' },
    ...[1, 2, 3, 4, 5, 6].map((n) => ({ slot: `dofus${n}`, label: `Dofus ${n}`, em: '🥚', dofus: true })),
  ];
  let equipActionId = null;
  const eqItemKey = (it) => `${it.id}|${it.fusion || 0}`;

  // Stats réelles d'un objet au tier de fusion donné (même calcul que itemStats du site).
  function fusedStats(st, type, fusion) {
    if (!fusion) return st || {};
    const out = {};
    if (type === 'dofus' && fusion >= FUSION_MAX) {
      for (const [k, v] of Object.entries(st || {})) out[k] = v > 0 ? Math.round(v * (1 + FUSION_RULES.dofusRadiantPct / 100)) : v;
      return out;
    }
    const mult = 1 + fusion * FUSION_RULES.stepPct / 100;
    for (const [k, v] of Object.entries(st || {})) out[k] = v > 0 && !FUSION_RULES.excluded.includes(k) ? Math.round(v * mult) : v;
    if (fusion >= FUSION_MAX && (out.pa ?? 0) > 0) out.pa = Math.max(out.pa, FUSION_RULES.radiantPa);
    return out;
  }

  // Inventaire + objets portés, lus dans le payload RSC de /inventaire.
  async function fetchEquipState() {
    const { flight, chunks } = await fetchFlight('/inventaire');
    const { rows, props } = rscProps(flight, (x) => Array.isArray(x.entries) && Array.isArray(x.slots));
    if (!props) throw new Error('Inventaire introuvable dans la page');
    const res = (v) => rscResolve(rows, v);
    const norm = (raw, fusion) => {
      const it = res(raw) || {};
      const type = it.s;
      return { id: it.id, name: it.n, lvl: it.lvl, type, rarity: it.r, icon: it.icon, fusion: fusion || 0, setName: it.setName || null,
        two: !!res(it.w)?.twoHanded, eff: fusedStats(res(it.st), type, fusion || 0) };
    };
    const entries = props.entries.map((e) => ({ ...norm(e.item, e.fusion), qty: e.qty })).filter((e) => Number.isInteger(e.id) && e.qty > 0);
    const slots = props.slots.map((s) => ({ slot: s.slot, label: s.label, accepts: s.accepts, cur: s.item ? norm(s.item, s.fusion) : null }));
    return { entries, slots, level: +props.level || 0, chunks, scrolls: res(props.scrollValues) || {} };
  }

  // Plan d'équipement : pour chaque type d'emplacement activé, les meilleurs objets (distincts) selon les stats choisies.
  // Un objet déjà porté et retenu reste à sa place ; seuls les emplacements qui gagnent au change sont modifiés.
  // `exclude` : clés « id|fusion » d'objets de l'inventaire à ignorer (refusés dans la proposition automatique).
  function equipPlan(state, statKeys, enabled, exclude = null) {
    const weighted = statKeys.slice(0, EQUIP_N).map((k, i) => [k, EQUIP_WEIGHTS[i]]).filter(([k]) => k);
    const stats = weighted.map(([k]) => k);
    if (!stats.length) throw new Error('Choisis au moins une caractéristique');
    const on = (slot) => enabled[slot] !== false;
    const ok = (c) => c && !(c.lvl > state.level);   // niveau requis
    const pool = [
      ...state.entries.filter((e) => ok(e) && !exclude?.has(eqItemKey(e))).map((e) => ({ ...e, from: null })),
      ...state.slots.filter((s) => on(s.slot) && ok(s.cur)).map((s) => ({ ...s.cur, qty: 1, from: s.slot })),
    ];
    // normalisation par type d'objet : valeur / meilleure valeur du type (une cape à 400 Vita ≠ un anneau à 400 Vita)
    const best = {};
    for (const c of [...pool, ...state.slots.map((s) => s.cur).filter(Boolean)]) {
      for (const k of stats) best[`${c.type}|${k}`] = Math.max(best[`${c.type}|${k}`] || 0, c.eff[k] || 0);
    }
    const score = (c) => (c ? weighted.reduce((n, [k, w]) => n + w * (c.eff[k] || 0) / (best[`${c.type}|${k}`] || 1), 0) : -Infinity);
    // à égalité, l'objet déjà porté passe avant un exemplaire identique de l'inventaire : sinon ce 2e exemplaire
    // serait retenu, le porté écarté (même id), et le même objet finirait dans deux emplacements (anneaux, dofus)
    const rank = (a, b) => score(b) - score(a) || !!b.from - !!a.from || b.lvl - a.lvl || b.rarity - a.rarity || b.fusion - a.fusion;
    const EPS = 1e-9;

    // Arme à deux mains : retire le bouclier → on la compare à (meilleure arme à une main + meilleur bouclier).
    const shieldSlot = state.slots.find((s) => s.slot === 'bouclier');
    const shields = pool.filter((c) => c.type === 'bouclier').sort(rank);
    const shieldScore = on('bouclier') ? Math.max(0, score(shields[0]) || 0, score(shieldSlot?.cur) || 0) : Math.max(0, score(shieldSlot?.cur) || 0);
    const weapons = pool.filter((c) => c.type === 'arme').sort(rank);
    const bestOne = weapons.find((c) => !c.two), bestTwo = weapons.find((c) => c.two);
    let allowTwo = !!bestTwo && (on('bouclier') || !shieldSlot?.cur)
      && score(bestTwo) > Math.max(0, score(bestOne) || 0) + shieldScore + EPS;
    if (!on('arme')) allowTwo = !!state.slots.find((s) => s.slot === 'arme')?.cur?.two;   // arme non touchée : on garde sa règle
    const usable = (c) => c.type !== 'arme' || (allowTwo ? c === bestTwo : !c.two);

    const changes = [];
    let unchanged = 0;
    const types = [...new Set(state.slots.filter((s) => on(s.slot)).map((s) => s.accepts))];
    for (const type of types) {
      if (type === 'bouclier' && allowTwo) { unchanged += 1; continue; }   // l'arme à deux mains retirera le bouclier
      const group = state.slots.filter((s) => s.accepts === type && on(s.slot));
      // objets portés dans un emplacement désactivé du même type : ils restent, pas de doublon
      const locked = new Set(state.slots.filter((s) => s.accepts === type && !on(s.slot) && s.cur).map((s) => s.cur.id));
      const picks = [];
      const seen = new Set(locked);
      for (const c of pool.filter((x) => x.type === type && usable(x)).sort(rank)) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        picks.push(c);
        if (picks.length === group.length) break;
      }
      // déjà porté dans un emplacement du groupe : il ne bouge pas
      const free = group.filter((s) => !picks.some((p) => p.from === s.slot));
      const toPlace = picks.filter((p) => !p.from || !group.some((s) => s.slot === p.from));
      free.sort((a, b) => score(a.cur) - score(b.cur));   // vides d'abord, puis les moins bons
      unchanged += group.length - free.length;
      free.forEach((s, i) => {
        const p = toPlace[i];
        // emplacement vide : rempli même par un objet sans aucune des stats choisies (mieux que rien),
        // le classement (niveau, rareté, fusion) départage ; sinon il faut faire mieux que l'objet porté
        if (p && (s.cur ? score(p) > Math.max(score(s.cur), 0) + EPS : score(p) >= 0)) {
          const delta = stats.map((k) => [k, (p.eff[k] || 0) - (s.cur?.eff[k] || 0)]).filter(([, d]) => d);
          changes.push({ slot: s.slot, label: s.label, from: s.cur, to: p, delta });
        } else unchanged++;
      });
    }
    // l'arme avant le bouclier (une arme à deux mains retire le bouclier, un bouclier retire une arme à deux mains)
    changes.sort((a, b) => (a.slot === 'arme' ? -1 : b.slot === 'arme' ? 1 : 0));
    return { changes, unchanged, stats };
  }

  async function runEquip(plan, chunks, onProgress) {
    if (!equipActionId) equipActionId = await findAction(chunks || (await fetchFlight('/inventaire')).chunks, 'equipItem', EQUIP_ACTION_FALLBACK);
    let done = 0;
    for (const c of plan.changes) {
      // erreur technique (5xx, réseau, ID d'action périmé) : 2 nouveaux essais ; refus du jeu : arrêt immédiat
      for (let attempt = 0; ; attempt++) {
        try {
          if (!equipActionId) equipActionId = await findAction(chunks || (await fetchFlight('/inventaire')).chunks, 'equipItem', EQUIP_ACTION_FALLBACK);
          await callAction('inventaire', equipActionId, [c.to.id, c.to.fusion, c.slot]);
          break;
        } catch (e) {
          if (!e.game) equipActionId = null;   // ID peut-être périmé : relu au prochain essai
          if (e.game || attempt >= 2) throw Object.assign(new Error(`${c.label} (${c.to.name}) : ${e.message}`), { done });
          await sleep(attempt ? 5000 : 2000);
        }
      }
      done++;
      onProgress?.(done, plan.changes.length, c);
      if (done < plan.changes.length) await sleep(350 + Math.random() * 350);
    }
    DM.log(`équipement auto : ${done} objet(s) équipé(s) (${plan.stats.join(', ')})`);
    return done;
  }

  // ---------- Anti-blocage : requête du jeu qui n'aboutit jamais ----------
  // Après un clic qui lance un combat (Attaquer, Combattre, Suivant en auto…), on doit voir un combat en cours.
  // Si rien ne se passe au bout de LAUNCH_TIMEOUT_MS, ou si une étape du pilote reste bloquée, on recharge la page.
  // Autres cas rattrapés : combat du pilote qui ne se termine jamais (page figée alors que le serveur a répondu),
  // combat qui ne repart pas après la vérification de présence, page vide ou page d'erreur serveur (5xx),
  // requête du jeu sans réponse (netwatch.js publie les requêtes en cours dans <html data-dm-pending>).
  // Recharger /combat est en général sans risque : le combat en cours est rechargé tel quel et le pilote relance l'Auto.
  // Mais le serveur peut l'avoir perdu (chasse : groupes renouvelés entre-temps) : /combat ne lance alors plus
  // aucune requête → combat perdu, retour à la page d'accueil du mode ; en chasse d’avis de recherche, le pilote s’y arrête si le groupe a été renouvelé.
  const LAUNCH_TIMEOUT_MS = 45 * 1000;
  const BUSY_TIMEOUT_MS = 90 * 1000;
  const FIGHT_STALL_MS = 40 * 1000;      // un combat en Auto se joue en ~10 s
  const PRESENCE_STALL_MS = 15 * 1000;   // combat toujours figé après avoir répondu à « Es-tu toujours là ? »
  const BLANK_STALL_MS = 20 * 1000;      // page vide
  const PENDING_MAX_MS = 15 * 1000;      // requête du jeu sans réponse (normalement < 1 s)
  const LOST_FIGHT_MS = 25 * 1000;       // /combat sans fin de combat ni aucune requête depuis le chargement
  // Réglables dans la popup : délai avant de recharger une page d'erreur, écart minimal entre deux rechargements.
  const errorStallMs = () => Math.max(1, +cfg.errorReloadSec || 5) * 1000;
  const reloadGapMs = () => Math.max(5, +cfg.reloadGapSec || 30) * 1000;
  const MAX_STUCK_RELOADS = 3;           // au-delà : retour à la page d'accueil du mode
  const ERROR_PAGE = /Application error|client-side exception|Internal Server Error|Bad Gateway|Service (Temporarily )?Unavailable|Gateway Time-?out|Web server is down|Connection timed out|This page couldn.t load|Resource Limit|Erreur serveur|\b(erreur|error)\s*5\d\d\b/i;
  const ERROR_TITLE = /^\s*((erreur|error)\s*)?5\d\d\b|\b(erreur|error)\s*5\d\d\b/i;   // titre « Erreur 508 », « 503 Service… »
  let launchAt = 0, busySince = 0, fightSince = 0, presenceAt = 0, oddSince = 0, oddCheckedAt = 0, oddKind = '';
  const pageLoadedAt = Date.now();
  const markLaunch = () => {
    if (!launchAt) launchAt = Date.now();
    const now = Date.now(), key = timeKey();
    // boucle = écart entre deux lancements du même mode / moteur (pauses de plus de 5 min ignorées)
    if (cfg.lastLaunchAt && cfg.lastLaunchKey === key && now - cfg.lastLaunchAt < TIME_GAP_MAX) addTime(key, 'loop', now - cfg.lastLaunchAt);
    save({ lastLaunchAt: now, lastLaunchKey: key, lastFightTimed: false });
  };

  // ---------- Chronomètre des combats (comparer l'Auto du jeu et l'Auto par poids) ----------
  // cfg.fightTimes[« mode|moteur »] = { n, fight (ms cumulées, lancement → écran de fin), loopN, loop (ms entre deux lancements) }
  const TIME_GAP_MAX = 5 * 60000;
  const timeKey = () => `${cfg.mode || 'aventure'}|${weightsOn() ? 'weights' : 'game'}`;
  function addTime(key, kind, ms) {
    const all = { ...(cfg.fightTimes || {}) };
    const t = { n: 0, fight: 0, loopN: 0, loop: 0, ...all[key] };
    if (kind === 'loop') { t.loopN++; t.loop += ms; } else { t.n++; t.fight += ms; }
    all[key] = t;
    save({ fightTimes: all });
  }
  // Fin d'un combat du pilote : durée depuis son lancement (une seule fois par combat).
  function timeFightEnd() {
    const d = Date.now() - (cfg.lastLaunchAt || 0);
    if (cfg.lastFightTimed || !cfg.lastLaunchAt || cfg.lastLaunchKey !== timeKey() || d > TIME_GAP_MAX) return;
    cfg.lastFightTimed = true;
    addTime(cfg.lastLaunchKey, 'fight', d);
    save({ lastFightTimed: true });
  }
  const TIME_LABELS = { aventure: 'Aventure', chasse: 'Chasse', ascension: 'Ascension', game: 'Auto du jeu', weights: 'Auto par poids' };
  const fmtSec = (ms) => `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  function timeLines() {
    return Object.entries(cfg.fightTimes || {}).filter(([, t]) => t.n || t.loopN).map(([k, t]) => {
      const [mode, eng] = k.split('|');
      const loop = t.loopN ? t.loop / t.loopN : 0;
      return `<div><b>${TIME_LABELS[mode] || mode} · ${TIME_LABELS[eng] || eng}</b> : ${t.n} combat(s)${t.n ? `, ${fmtSec(t.fight / t.n)} / combat` : ''}${loop ? `, boucle ${fmtSec(loop)} (≈ ${Math.round(3600000 / loop)} / h)` : ''}</div>`;
    }).join('');
  }

  // Page vide ou page d'erreur (vérifié toutes les 2 s : innerText force un calcul de mise en page)
  function oddPage(now) {
    if (now - oddCheckedAt < 2000) return;
    oddCheckedAt = now;
    const text = document.body?.innerText.trim() || '';
    const titles = [document.title, ...[...document.querySelectorAll('h1, h2')].map((h) => h.textContent)];
    const kind = document.getElementById('__next_error__') || titles.some((t) => ERROR_TITLE.test(t))
      || (text.length < 3000 && ERROR_PAGE.test(`${document.title} ${text}`)) ? 'error'
      : text.length < 40 ? 'blank' : '';
    if (kind !== oddKind) { oddKind = kind; oddSince = kind ? now : 0; }
  }
  // Plus ancienne requête du jeu en attente (ms), 0 si aucune.
  const pendingFor = (now) => {
    const t = +(document.documentElement.dataset.dmPending || '').split(':')[1];
    return t ? now - t : 0;
  };
  const pageActions = () => +(document.documentElement.dataset.dmActions || 0);

  function stuckCheck() {
    const now = Date.now();
    const end = location.pathname.startsWith('/combat') && endTitle();
    const inFight = location.pathname.startsWith('/combat') && !end;
    if (launchAt && inFight) launchAt = 0;   // le combat a démarré
    if (!inFight) { fightSince = 0; presenceAt = 0; } else if (!fightSince) fightSince = now;
    if (end && cfg.stuckReloads) save({ stuckReloads: 0 });   // un combat s'est terminé : compteur remis à zéro
    oddPage(now);
    const waitingPresence = !!presenceDialog();
    let why = null;
    if (launchAt && now - launchAt > LAUNCH_TIMEOUT_MS) why = 'lancement du combat sans réponse';
    else if (busy && now - busySince > BUSY_TIMEOUT_MS + cfg.delayMax * 1000) why = 'pilote bloqué';
    else if (oddKind === 'error' && now - oddSince > errorStallMs()) why = 'erreur serveur';
    else if (oddKind === 'blank' && now - oddSince > BLANK_STALL_MS) why = 'page vide';
    else if (pendingFor(now) > PENDING_MAX_MS) why = `requête sans réponse depuis ${Math.round(pendingFor(now) / 1000)} s`;
    else if (!waitingPresence && presenceAt && inFight && now - presenceAt > PRESENCE_STALL_MS) why = 'combat figé après la vérification de présence';
    else if (!waitingPresence && inFight && cfg.botFight && now - fightSince > FIGHT_STALL_MS) why = 'combat figé';
    // Combat disparu côté serveur : la page /combat ne lance plus rien → inutile de recharger, on repart de l'accueil.
    // (seulement si netwatch.js tourne dans la page, sinon le compteur de requêtes reste à 0)
    if (!why && !waitingPresence && inFight && cfg.botFight && document.documentElement.dataset.dmNetwatch
        && !pageActions() && !pendingFor(now) && now - pageLoadedAt > LOST_FIGHT_MS) why = 'combat introuvable (perdu par le serveur)';
    if (!why || now - (cfg.lastStuckReload || 0) < reloadGapMs()) return false;
    launchAt = 0;
    progress();
    const n = (cfg.stuckReloads || 0) + 1;
    // recharger ne suffit pas, ou combat perdu : on repart de la page d'accueil du mode
    const giveUp = n > MAX_STUCK_RELOADS || why.startsWith('combat introuvable');
    DM.log(`anti-blocage : ${why} sur ${location.pathname} → ${giveUp ? `retour à ${home()}` : 'rechargement'}`);
    save({ lastStuckReload: now, stuckReloads: giveUp ? 0 : n,
      status: giveUp ? `Toujours bloqué (${why}) — retour à ${home()}…` : `Page bloquée (${why}) — rechargement…` });
    setTimeout(() => (giveUp ? location.assign(home()) : location.reload()), 300);
    return true;
  }

  async function tick() {
    if (!contextAlive()) { shutdown(); return; }
    if (!isOwner()) return;
    if (stuckCheck() || busy) return;
    busy = true;
    busySince = Date.now();
    try {
      if (Date.now() - lastProgress > WATCHDOG_MS && !inBossTab()) {   // onglet boss : sécurité gérée par le service worker
        progress();
        setStatus(`Bloqué depuis 2 min — rechargement de ${home()}`);
        if (onHome()) location.reload();   // page d'accueil figée (relance qui ne part pas…)
        else location.assign(home());
        return;
      }
      await step();
    } catch (e) {
      console.warn('[Pilote auto]', e);
    } finally {
      busy = false;
    }
  }

  // ---------- Avis de recherche : scan des zones de chasse ----------
  // Chaque /chasse?zone=… liste ses groupes (panneaux « Groupe N ») et leurs monstres. On compare les noms
  // à la liste locale DM.WANTED (wanted.js). Les zones en échec (site saturé…) sont réessayées par passes successives.
  const normName = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const WANTED_KEYS = (DM.WANTED || []).map((name) => ({ name, key: normName(name) }));
  function wantedMatch(monster) {
    const k = normName(monster);
    if (!k) return null;
    // nom identique, ou l'un contient l'autre (seulement pour les noms assez longs, pour éviter « Hin » ⊂ « Chinchin »)
    return WANTED_KEYS.find((w) => w.key === k
      || (Math.min(w.key.length, k.length) >= 6 && (k.includes(w.key) || w.key.includes(k))))?.name || null;
  }

  // Les groupes se renouvellent toutes les ~3 min : le scan doit tenir dans ce délai.
  // → requêtes en parallèle (SCAN_CONC_START, jusqu'à SCAN_CONC_MAX), ralenties automatiquement si le site sature.
  const SCAN_CONC_START = 4, SCAN_CONC_MAX = 6;
  const SCAN_GAP_MS = 250;                            // pause de chaque « ouvrier » entre deux zones
  const SCAN_RETRY_WAITS = [0, 5000, 15000, 30000];   // pause avant chaque passe sur les zones en échec
  const ZONE_LIST_TTL_MS = 30 * 60000;                // la liste des ~220 zones change rarement
  let scanRunning = false, scanStop = false, scanMsg = '';
  let allZonesCache = null;
  const notified = new Set();   // avis déjà signalés sur Discord (zone|groupe|monstre|renouvellement)

  async function scanZone(id) {
    const r = await DM.fetchT(`/chasse?zone=${id}`, { credentials: 'same-origin', cache: 'no-store' });
    if (r.redirected && /connexion/.test(r.url)) throw Object.assign(new Error('déconnecté'), { fatal: true });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const groups = [];
    for (const p of groupCards(doc)) {
      const n = groupNumber(p);
      const monsters = [...p.querySelectorAll('li')].map((li) => ({
        name: li.querySelector('.font-bold')?.textContent.trim() || li.querySelector('img')?.alt || '',
        lvl: +(li.textContent.match(/Niveau\s*(\d+)/)?.[1] || 0) || null,
        img: li.querySelector('img')?.getAttribute('src') || null,
      })).filter((m) => m.name);
      const total = +(p.textContent.match(/Niveau total\s*(\d+)/)?.[1] || 0) || null;
      const diff = p.querySelector('.title')?.nextElementSibling?.textContent.trim() || null;   // « Facile », « Très difficile »…
      groups.push({ n, monsters, total, diff });
    }
    if (!groups.length) throw Object.assign(new Error('aucun groupe'), { empty: true });   // zone sans groupe : inutile de réessayer
    const rot = html.replace(/\\"/g, '"').match(/"to"\s*:\s*(\d{12,14})\s*,\s*"prefix"\s*:\s*"Nouveaux groupes/);
    return { groups, rotateAt: rot ? +rot[1] : null };
  }

  // Avis de recherche d'une zone, groupe par groupe ; seuls les groupes contenant au moins
  // cfg.wantedMinPerGroup monstres recherchés sont retenus (plusieurs avis dans le même combat).
  function zoneMatches(z) {
    const out = [];
    const min = Math.max(1, cfg.wantedMinPerGroup || 1);
    for (const g of z.groups || []) {
      const hits = [];
      for (const raw of g.monsters) {
        const m = typeof raw === 'string' ? { name: raw } : raw;   // anciens scans : simples noms
        const w = wantedMatch(m.name);
        if (w) hits.push({ raw, m, w });
      }
      if (hits.length < min) continue;
      for (const { raw, m, w } of hits) {
        out.push({
          zoneId: z.id, zoneName: z.name, group: g.n, monster: m.name, lvl: m.lvl, img: m.img, wanted: w,
          rotateAt: z.rotateAt, total: g.total, diff: g.diff, count: hits.length,
          others: g.monsters.filter((x) => x !== raw).map((x) => (typeof x === 'string' ? { name: x } : x)),
        });
      }
    }
    return out;
  }
  const scanMatches = (st = cfg.wantedScan) => (st?.zones || []).flatMap(zoneMatches);

  // Lien « attaque directe » : ouvert dans le navigateur, l'extension clique « Attaquer » sur ce groupe (voir attackFromLink).
  const attackLink = (f) => `${DM.ORIGIN}/chasse?zone=${f.zoneId}&dmAttack=${f.group}${f.rotateAt ? `&dmUntil=${f.rotateAt}` : ''}`;

  function notifyFound(f) {
    const key = `${f.zoneId}|${f.group}|${normName(f.monster)}|${f.rotateAt || ''}`;
    if (notified.has(key)) return;
    notified.add(key);
    const others = f.others.map((o) => `${o.name}${o.lvl ? ` (${o.lvl})` : ''}`).join(', ');
    notify('wanted', `🎯 **Avis de recherche : ${f.monster}**`, [{
      title: `${f.monster}${f.lvl ? ` — niveau ${f.lvl}` : ''}`,
      url: attackLink(f),
      color: 0xe0b040,
      thumbnail: f.img ? { url: new URL(f.img, DM.ORIGIN).href } : undefined,
      description: `**${f.zoneName}** — groupe ${f.group}${f.diff ? ` (${f.diff})` : ''}`
        + `${f.count > 1 ? `\n🎯 **${f.count} avis de recherche** dans ce combat` : ''}`
        + `${f.total ? `\nNiveau total du groupe : **${f.total}**` : ''}`
        + `${others ? `\nAvec : ${others}` : ''}`
        + `${f.rotateAt ? `\nDisponible jusqu’à **${DM.hhmm(f.rotateAt)}**` : ''}`
        + `\n\n⚔️ [Attaquer direct (extension)](${attackLink(f)}) · 🗺️ [Voir la zone](${DM.ORIGIN}/chasse?zone=${f.zoneId})`,
    }]);
    showWantedCard(f);
  }

  // ---------- Carte « avis trouvé » sur la page (au-dessus de la bulle) ----------
  const CARD_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, sans-serif; }
    .stack { position: fixed; left: 12px; bottom: 64px; z-index: 2147483646; display: flex; flex-direction: column-reverse; gap: 8px;
      width: 300px; max-width: calc(100vw - 24px); }
    .card { background: #1b1d22; color: #e8e6e1; border: 1px solid #e0b040; border-radius: 10px; padding: 10px;
      box-shadow: 0 0 18px rgba(224,176,64,.35), 0 6px 24px rgba(0,0,0,.55); font-size: 12px; animation: pop .25s ease-out; }
    @keyframes pop { from { transform: translateY(12px); opacity: 0; } }
    .top { display: flex; gap: 10px; align-items: center; }
    .icon { width: 64px; height: 64px; flex: none; border-radius: 10px; background: radial-gradient(#3a3220, #1b1d22);
      display: grid; place-items: center; border: 1px solid #5a4a20; }
    .icon img { max-width: 58px; max-height: 58px; object-fit: contain; filter: drop-shadow(0 2px 3px rgba(0,0,0,.6)); }
    .kicker { color: #e0b040; font-weight: 800; font-size: 11px; letter-spacing: .03em; }
    .name { font-size: 15px; font-weight: 800; }
    .muted { color: #9aa0a8; }
    .x { margin-left: auto; align-self: flex-start; background: none; border: 0; color: #9aa0a8; cursor: pointer; font-size: 15px; }
    .grp { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px; }
    .grp span { display: inline-flex; align-items: center; gap: 3px; background: #262a31; border-radius: 6px; padding: 2px 6px 2px 2px; }
    .grp img { width: 22px; height: 22px; object-fit: contain; }
    .btns { margin-top: 9px; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .btns a { text-align: center; text-decoration: none; color: #fff; font-weight: 700; border-radius: 6px; padding: 7px; background: #3a3f48; }
    .btns a.go { background: #b07400; }
    .btns a:hover { filter: brightness(1.15); }
  `;
  let cardStack = null;
  function showWantedCard(f) {
    if (!document.body) return;
    if (!cardStack?.host.isConnected) {
      const host = document.createElement('div');
      host.id = 'dm-wanted-cards';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${CARD_CSS}</style><div class="stack"></div>`;
      document.body.appendChild(host);
      cardStack = { host, stack: root.querySelector('.stack') };
    }
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const img = (src, alt) => { const i = document.createElement('img'); i.src = src; i.alt = alt; return i; };

    const card = el('div', 'card');
    const top = el('div', 'top');
    const icon = el('div', 'icon');
    if (f.img) icon.append(img(f.img, f.monster)); else icon.textContent = '🎯';
    const info = el('div');
    info.append(el('div', 'kicker', '🎯 AVIS DE RECHERCHE'), el('div', 'name', f.monster),
      el('div', 'muted', `${f.lvl ? `Niveau ${f.lvl} · ` : ''}groupe ${f.group}${f.diff ? ` (${f.diff})` : ''}`),
      el('div', 'muted', f.zoneName));
    const x = el('button', 'x', '✕');
    x.title = 'Fermer';
    x.addEventListener('click', () => card.remove());
    top.append(icon, info, x);
    card.append(top);

    if (f.others.length) {
      const grp = el('div', 'grp');
      for (const o of f.others) {
        const chip = el('span');
        if (o.img) chip.append(img(o.img, o.name));
        chip.append(`${o.name}${o.lvl ? ` ${o.lvl}` : ''}`);
        grp.append(chip);
      }
      card.append(grp);
    }
    const foot = el('div', 'muted', [f.total && `Niveau total ${f.total}`, f.rotateAt && `jusqu’à ${DM.hhmm(f.rotateAt)}`].filter(Boolean).join(' · '));
    foot.style.marginTop = '6px';
    card.append(foot);

    const btns = el('div', 'btns');
    const go = el('a', 'go', '⚔️ Attaquer');
    go.href = attackLink(f);
    const see = el('a', '', '🗺️ Voir la zone');
    see.href = `/chasse?zone=${f.zoneId}`;
    btns.append(go, see);
    card.append(btns);

    cardStack.stack.append(card);
    // la carte disparaît d'elle-même au renouvellement des groupes (l'avis n'est plus garanti)
    const ttl = f.rotateAt ? f.rotateAt - Date.now() : 3 * 60000;
    setTimeout(() => card.remove(), Math.max(15000, ttl));
  }

  // resume = true : ne rescanne que les zones pas encore lues avec succès.
  async function runScan(resume) {
    if (scanRunning) return;
    scanRunning = true;
    scanStop = false;
    let lastSave = 0;
    const saveScan = (st, force) => {
      if (!force && Date.now() - lastSave < 1500) return;   // en parallèle : on n'écrit pas le stockage à chaque zone
      lastSave = Date.now();
      return save({ wantedScan: st });
    };
    try {
      do {
        let st = resume && cfg.wantedScan?.zones?.length ? JSON.parse(JSON.stringify(cfg.wantedScan)) : null;
        resume = false;
        if (!st) {
          if (!allZonesCache || Date.now() - allZonesCache.at > ZONE_LIST_TTL_MS) {
            scanMsg = 'Lecture de la liste des zones…';
            renderUi();
            // toutes les zones (/chasse?toutes=1), pas seulement celles à ton niveau
            allZonesCache = { at: Date.now(), zones: await DM.fetchZones({ all: true }) };
          }
          // Filtre de niveau (0 = pas de limite) : on garde les zones dont la plage de niveaux croise [min, max].
          // Tri : zones les plus hautes d'abord (les ouvriers prennent la file dans l'ordre).
          const lo = cfg.wantedLvlMin || 0, hi = cfg.wantedLvlMax || Infinity;
          const zones = allZonesCache.zones
            .filter((z) => z.lvlMin == null || ((z.lvlMax ?? z.lvlMin) >= lo && z.lvlMin <= hi))
            .sort((a, b) => (b.lvlMax ?? b.lvlMin ?? 0) - (a.lvlMax ?? a.lvlMin ?? 0) || (b.lvlMin ?? 0) - (a.lvlMin ?? 0));
          if (!zones.length) throw new Error(`aucune zone entre les niveaux ${lo} et ${hi === Infinity ? '∞' : hi}`);
          st = {
            at: Date.now(),
            range: [lo, hi === Infinity ? 0 : hi],
            zones: zones.map((z) => ({
              id: z.id,
              name: (z.region ? `${z.name} (${z.region})` : z.name) + (z.lvlMin != null ? ` [${z.lvlMin}–${z.lvlMax}]` : ''),
              status: 'pending',
            })),
          };
        }
        st.done = false;
        await saveScan(st, true);
        const t0 = Date.now();

        for (let pass = 0; pass < SCAN_RETRY_WAITS.length && !scanStop; pass++) {
          const queue = st.zones.filter((z) => !['ok', 'empty'].includes(z.status));
          if (!queue.length) break;
          if (SCAN_RETRY_WAITS[pass]) {
            scanMsg = `${queue.length} zone(s) en échec — nouvel essai dans ${SCAN_RETRY_WAITS[pass] / 1000} s`;
            renderUi();
            await sleep(SCAN_RETRY_WAITS[pass]);
            if (scanStop) break;
          }
          let conc = pass ? 2 : SCAN_CONC_START;   // les passes de rattrapage partent plus doucement
          let gap = SCAN_GAP_MS, streak = 0;
          const worker = async (i) => {
            while (queue.length && !scanStop) {
              if (i >= conc) { await sleep(500); continue; }   // ouvrier mis en veille tant que le site sature
              const z = queue.shift();
              const done = st.zones.filter((x) => ['ok', 'empty'].includes(x.status)).length;
              scanMsg = `Scan ${done}/${st.zones.length} · ${conc} en parallèle…`;
              renderUi();
              try {
                Object.assign(z, await scanZone(z.id), { status: 'ok', error: null, at: Date.now() });
                zoneMatches(z).forEach(notifyFound);   // notification Discord immédiate
                if (++streak >= 8 && conc < SCAN_CONC_MAX) { conc++; streak = 0; }
                gap = Math.max(SCAN_GAP_MS, gap * 0.8);
              } catch (e) {
                Object.assign(z, { status: e.empty ? 'empty' : 'error', error: e.message });
                if (!e.empty) { conc = Math.max(1, conc - 1); gap = Math.min(5000, gap * 2); streak = 0; }
                if (e.fatal) scanStop = true;
              }
              saveScan(st);
              await sleep(gap + Math.random() * 300);
            }
          };
          await Promise.all(Array.from({ length: SCAN_CONC_MAX }, (_, i) => worker(i)));
        }

        st.done = st.zones.every((z) => ['ok', 'empty'].includes(z.status));
        st.finishedAt = Date.now();
        await saveScan(st, true);
        const found = scanMatches(st);
        const missing = st.zones.filter((z) => !['ok', 'empty'].includes(z.status)).length;
        scanMsg = `${found.length} avis trouvé(s) en ${Math.round((Date.now() - t0) / 1000)} s`
          + (missing ? ` · ${missing} zone(s) non scannée(s)` : '');
        renderUi();

        // Scan en continu : on repart juste après le prochain renouvellement des groupes.
        if (cfg.wantedLoop && !scanStop) {
          const next = Math.min(...st.zones.map((z) => z.rotateAt).filter((t) => t > Date.now()), Date.now() + 3 * 60000);
          const until = Math.max(Date.now() + 5000, next + 3000);
          scanMsg += ` — prochain scan à ${new Date(until).toLocaleTimeString('fr-FR')}`;
          renderUi();
          while (Date.now() < until && !scanStop && cfg.wantedLoop) await sleep(1000);
        }
      } while (cfg.wantedLoop && !scanStop && modOn('wanted'));
    } catch (e) {
      scanMsg = `❌ ${e.message}`;
    } finally {
      scanRunning = false;
      renderUi();
    }
  }

  // Lien « ⚔️ Attaquer direct » reçu sur Discord : /chasse?zone=Z&dmAttack=N[&dmUntil=t].
  // Le groupe N devient la cible de chasse ; si le pilote tourne, cet onglet le prend en main (Auto + relance en boucle),
  // Le pilote est démarré au besoin : il lance le combat en Auto puis le relance en boucle (comme en mode chasse),
  // jusqu'au renouvellement du groupe. Si les groupes ont été renouvelés depuis (dmUntil dépassé), on n'attaque pas.
  async function attackFromLink() {
    const q = new URLSearchParams(location.search);
    const group = +q.get('dmAttack'), zone = +q.get('zone'), until = +q.get('dmUntil') || 0;
    if (!location.pathname.startsWith('/chasse') || !group || !zone) return;
    history.replaceState(null, '', `/chasse?zone=${zone}`);   // retire les paramètres de l'extension de l'URL
    if (until && Date.now() > until) {
      save({ status: 'Lien d’avis expiré : les groupes ont été renouvelés' });
      return;
    }
    for (let i = 0; i < 40 && !targetGroupByNumber(group); i++) await sleep(250);   // attend l'affichage des groupes
    const name = document.querySelector('h1')?.textContent.trim() || '';
    // composition actuelle du groupe : le pilote s'arrêtera quand il sera renouvelé (voir step, mode chasse)
    const monsters = groupMonsters(targetGroupByNumber(group));
    await save({ mode: 'chasse', huntZone: zone, huntZoneName: name, huntGroup: group, pauseReason: null,
      huntTarget: monsters.length ? { zone, group, monsters } : null });
    // Le pilote (démarré s'il était arrêté) passe sur cet onglet : il attaque, active l'Auto puis relance en boucle.
    await send({ type: 'claim', start: true }).catch(() => {});
  }
  const targetGroupByNumber = (n) => groupCards().find((p) => groupNumber(p) === n);

  // Sur une page de zone, on met en évidence les monstres d'avis de recherche.
  function highlightWanted() {
    if (!location.pathname.startsWith('/chasse')) return;
    for (const li of groupCards().flatMap((p) => [...p.querySelectorAll('li')])) {
      if (li.dataset.dmWanted) continue;
      const name = li.querySelector('.font-bold')?.textContent.trim();
      if (!name) continue;
      const w = wantedMatch(name);
      li.dataset.dmWanted = w ? '1' : '0';
      if (!w) continue;
      li.style.outline = '2px solid #e0b040';
      li.style.boxShadow = '0 0 10px rgba(224,176,64,.5)';
      li.title = `🎯 Avis de recherche : ${w}`;
      const tag = document.createElement('span');
      tag.textContent = '🎯 Avis';
      tag.style.cssText = 'margin-left:auto;font-size:11px;font-weight:700;color:#e0b040;white-space:nowrap';
      li.appendChild(tag);
    }
  }

  // ---------- Tierlist des sorts : dégâts des cartes de la collection (/deck) ----------
  // /deck contient toute la collection (DeckBuilder : collection[{ key, card:{ id, n, ap, icon, r, eff[] } }],
  // initialFavorites[ids]). Effets de dégâts = liste du site : dmg, steal, bomb, trap, detonate, poison ;
  // dmgCasterHp / dmgLostHp dépendent de la vie (« variables », non classés).
  // Toutes les lignes d'un sort sont appliquées (vérifié dans les journaux de combat : Drain Élémentaire, Tromperie…
  // frappent une fois par élément) → on les additionne. Exception : les lignes avec « chance » (x % de chance,
  // ex. Topkaj) sont des tirages au sort exclusifs : moyenne pondérée par la chance, min 0, max = la plus forte.
  // Favori natif : server action « setFavoriteCard(idCarte, bool) » sur /deck.
  const FAV_ACTION_FALLBACK = '60105c931c92cff568c1e6ff395e809d4eb30addf9';
  const ELEMENTS = [
    { name: 'Neutre', color: '#a8a29e' }, { name: 'Terre', color: '#a16207' }, { name: 'Feu', color: '#ef4444' },
    { name: 'Eau', color: '#3b82f6' }, { name: 'Air', color: '#22c55e' },
  ];
  const DMG_FIXED = new Set(['dmg', 'steal', 'bomb', 'trap', 'detonate', 'poison']);
  const DMG_VARIABLE = new Set(['dmgCasterHp', 'dmgLostHp']);
  const SPELL_FILTERS_KEY = 'dmSpellFilters';
  // Dégâts réels (option « Avec mes stats ») — formule des infobulles du jeu, vérifiée sur les journaux de combat :
  // par ligne : (base × (1 + (stat de l'élément + Puissance) / 100) + Dommages + Dommages <élément>) × (1 + % Dommages aux sorts).
  // Neutre et Terre = Force, Feu = Intelligence, Eau = Chance, Air = Agilité. Critique : chance de la carte + % Critique
  // (seulement si la carte peut critiquer), coup ×1,25 (estimé sur les journaux) + Dommages Critiques.
  // Vision spectrale : 0,4 % par point de PO qu'un sort de dégâts frappe deux fois (compté en moyenne).
  // Les résistances / le niveau du monstre réduisent ensuite tous les sorts pareil : le classement n'en dépend pas.
  const EL_STAT = ['force', 'force', 'intelligence', 'chance', 'agilite'];
  const EL_DMG = ['dommagesNeutre', 'dommagesTerre', 'dommagesFeu', 'dommagesEau', 'dommagesAir'];
  const CRIT_MULT = 1.25;
  const SPECTRAL_PER_PO = 0.4;
  const PA_VALUE_PCT = 3;   // optimiseur : 1 PA = +3 % de l'objectif (voir score)
  const CHAR_STATS_KEY = 'dmCharStats';
  const LAST_FIGHT_KEY = 'dmLastFight';   // dernier état de combat reçu, par personnage (localStorage de la page)
  const fightAcct = () => myName() || (chrome.extension?.inIncognitoContext ? 'privé' : 'normal');
  // netwatch.js transmet chaque état de combat reçu : on garde le dernier qui contient des coups du joueur.
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.type !== 'dm-fight' || typeof e.data.line !== 'string') return;
    try {
      const obj = JSON.parse(e.data.line);
      const st = obj.state;
      if (obj.rewards && st?.status && st.status !== 'ongoing') dropOnRewards(obj.rewards, `${st.kind}|${st.logCount}`);
      if (!st?.fighters?.p?.stats || !st.log?.some((L) => L.t === 'play' && L.who === 'p')) return;
      const fighters = Object.fromEntries(Object.entries(st.fighters).map(([id, f]) => [id,
        { id, name: f.name, kind: f.kind, team: f.team, level: f.level, stats: f.stats, resCap: f.resCap, buffs: f.buffs }]));
      const all = JSON.parse(localStorage.getItem(LAST_FIGHT_KEY) || '{}');
      all[fightAcct()] = { at: Date.now(), kind: st.kind, status: st.status, fighters, log: st.log };
      localStorage.setItem(LAST_FIGHT_KEY, JSON.stringify(all));
    } catch { /* état illisible ou stockage plein */ }
  });
  const lastFight = () => { try { return JSON.parse(localStorage.getItem(LAST_FIGHT_KEY) || '{}')[fightAcct()] || null; } catch { return null; } };
  let favActionId = null;

  // Dégâts d'une carte : total min / max / moyen, détail par élément, zone ou cible unique.
  // `stats` (caractéristiques du personnage) : dégâts estimés avec ses bonus, critique et vision spectrale compris.
  function spellDamage(card, stats = null) {
    const S = (k) => +stats?.[k] || 0;
    const pct = (1 + S('dmgPctSorts') / 100);
    const critP = stats && +card.cc > 0 ? Math.min(1, Math.max(0, (+card.cc + S('critique')) / 100)) : 0;
    // valeur d'un coup de base `v` dans l'élément `el` : [normal, critique]
    const hitVal = (v, el) => {
      if (!stats) return [v, v];
      const mult = 1 + (S(EL_STAT[el]) + S('puissance')) / 100, fixed = S('dommages') + S(EL_DMG[el]);
      return [(v * mult + fixed) * pct, (v * CRIT_MULT * mult + fixed + S('dommagesCritiques')) * pct];
    };
    let min = 0, max = 0, zone = false, variable = false, delayed = false, fixed = false, random = false;
    let rndAvg = 0, rndMax = 0, sure = 0;
    const byEl = {};
    for (const e of card.eff || []) {
      if (DMG_VARIABLE.has(e.k)) { variable = true; continue; }
      if (!DMG_FIXED.has(e.k)) continue;
      fixed = true;
      const n = e.k === 'poison' ? Math.max(1, +(e.turns || e.dur) || 1) : 1;   // poison : dégâts à chaque tour
      const el = Number.isInteger(e.el) ? e.el : 0;
      const [loN, loC] = hitVal(+e.min || 0, el), [hiN, hiC] = hitVal(+(e.max ?? e.min) || 0, el);
      // min = sans critique, max = critique ; moyenne pondérée par la chance de critique
      const lo = loN * n, hi = (critP ? hiC : hiN) * n;
      const mid = ((1 - critP) * (loN + hiN) / 2 + critP * (loC + hiC) / 2) * n;
      const p = e.chance != null && +e.chance < 100 ? Math.max(0, +e.chance) / 100 : 1;
      if (p < 1) {   // ligne à x % de chance
        random = true;
        rndAvg += p * mid;
        rndMax = Math.max(rndMax, hi);
        byEl[el] = (byEl[el] || 0) + p * mid;
      } else {
        min += lo; max += hi; sure += mid;
        byEl[el] = (byEl[el] || 0) + mid;
      }
      if (e.zone || e.k === 'bomb' || e.k === 'detonate') zone = true;   // bombes : explosion en zone
      if (e.k === 'bomb' || e.k === 'trap' || e.k === 'poison') delayed = true;
    }
    if (!fixed) return null;
    const spectral = stats ? 1 + S('po') * SPECTRAL_PER_PO / 100 : 1;   // 2e frappe possible (moyenne seulement)
    const avg = (sure + rndAvg) * spectral;
    const r = (v) => Math.round(v);
    for (const k in byEl) byEl[k] *= spectral;
    return { min: r(min), max: r(max + rndMax), avg: Math.round(avg * 10) / 10, byEl, zone, variable, delayed, random, critP };
  }

  async function fetchSpells() {
    const { flight, chunks } = await fetchFlight('/deck');
    const { rows, props } = rscProps(flight, (x) => Array.isArray(x.collection) && 'initialDecks' in x);
    if (!props) throw new Error('Collection de sorts introuvable sur /deck');
    const res = (v) => rscResolve(rows, v);
    const spells = [], variableOnly = [];
    for (const raw of props.collection) {
      const ent = res(raw) || {};
      const card = res(ent.card);
      if (!card?.id) continue;
      const eff = (res(card.eff) || []).map(res);
      const dmg = spellDamage({ ...card, eff });
      if (!dmg) {
        if (eff.some((e) => DMG_VARIABLE.has(e?.k))) variableOnly.push(card.n);
        continue;
      }
      const ap = +card.ap || 0;
      spells.push({ id: card.id, key: ent.key, usable: ent.usable !== false, name: card.n, desc: card.d || '', icon: card.icon, ap, rarity: card.r,
        fusion: +card.f || 0, card: { ...card, eff }, ...dmg, perAp: ap ? dmg.avg / ap : Infinity });
    }
    const favs = new Set((res(props.initialFavorites) || []).map(Number));
    const decks = res(props.initialDecks) || [];
    const deckIds = (i) => (res(decks[i]) || []).map((k) => +String(k).split(':')[0]);
    const activeDeck = new Set(deckIds(+res(props.initialActive) || 0));
    return { spells, favs, variableOnly, chunks, activeDeck, deckIds };
  }

  // Caractéristiques du personnage : l'état de combat (/combat, combattant « p ») contient ses stats totales
  // (équipement, points, prestige). Mémorisées par personnage pour quand aucun combat n'est disponible.
  async function fetchCharStats() {
    const lf = lastFight();
    if (lf?.fighters?.p?.stats) return { stats: lf.fighters.p.stats, at: lf.at, level: lf.fighters.p.level };
    const acct = fightAcct();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(CHAR_STATS_KEY) || '{}')[acct] || null; } catch { /* stockage indisponible */ }
    try {
      const { flight } = await fetchFlight('/combat');
      const { rows, props } = rscProps(flight, (x) => x.id === 'p' && x.kind === 'player' && x.stats && typeof x.stats === 'object');
      const stats = props && rscResolve(rows, props.stats);
      if (stats && typeof stats === 'object') {
        const out = { stats, at: Date.now(), level: props.level };
        try {
          const all = JSON.parse(localStorage.getItem(CHAR_STATS_KEY) || '{}');
          all[acct] = out;
          localStorage.setItem(CHAR_STATS_KEY, JSON.stringify(all));
        } catch { /* idem */ }
        return out;
      }
    } catch { /* pas de combat lisible : dernière lecture */ }
    return saved;
  }

  async function setFavorite(id, on, chunks) {
    if (!favActionId) favActionId = await findAction(chunks || (await fetchFlight('/deck')).chunks, 'setFavoriteCard', FAV_ACTION_FALLBACK);
    try {
      await callAction('deck', favActionId, [id, on]);
    } catch (e) {
      if (!e.game) favActionId = null;   // ID peut-être périmé : relu au prochain essai
      throw e;
    }
  }

  // ---------- Test du calcul : coups réels du dernier combat vs estimation ----------
  // Pour chaque carte jouée : les lignes de dégâts qui suivent dans le journal (jusqu'à la carte / au tour suivant),
  // appariées dans l'ordre aux lignes de la carte du même élément. Observé = v + absorbé (bouclier).
  // Estimation « sans rés. » = formule de la tierlist ; « avec rés. » = (x − rés. fixe) × (1 − % rés.) de la cible.
  // Zone : seule la cible visée prend 100 % ; les autres cibles touchées prennent ~60 % (vérifié sur un récap de combat).
  const ZONE_FALLOFF = 0.6;
  const EL_RES_PCT = ['resPctNeutre', 'resPctTerre', 'resPctFeu', 'resPctEau', 'resPctAir'];
  const EL_RES = ['resNeutre', 'resTerre', 'resFeu', 'resEau', 'resAir'];
  function damageTest(fight, spells) {
    const stats = fight.fighters.p.stats;
    const S = (k) => +stats[k] || 0;
    const pct = 1 + S('dmgPctSorts') / 100;
    const byName = new Map(spells.map((sp) => [sp.name, sp.card]));
    const rows = [];
    let buffed = false;
    const log = fight.log;
    for (let i = 0; i < log.length; i++) {
      const L = log[i];
      if (L.t === 'buff' && L.who === 'p') buffed = true;
      if (L.t !== 'play' || L.who !== 'p') continue;
      const card = byName.get(L.card);
      const lines = (card?.eff || []).filter((e) => DMG_FIXED.has(e.k) && !(e.chance != null && +e.chance < 100));
      const used = new Set();
      for (let j = i + 1; j < log.length && !['play', 'turn', 'round'].includes(log[j].t); j++) {
        const D = log[j];
        if (D.t !== 'dmg') continue;
        const tg = fight.fighters[D.who];
        if (!tg || tg.team === fight.fighters.p.team) continue;   // coups sur soi / les alliés (zones) ignorés
        const li = lines.findIndex((e, k) => !used.has(k) && (Number.isInteger(e.el) ? e.el : 0) === D.el);
        if (li >= 0 && !lines[li].zone) used.add(li);
        const e = lines[li];
        const crit = !!(D.crit ?? L.crit);
        const fatal = log[j + 1]?.t === 'death' && log[j + 1].who === D.who;
        const secondary = !!L.target && D.who !== L.target;   // autre cible touchée par la zone
        const row = { card: L.card, ap: card?.ap, target: tg.name, el: D.el, v: (+D.v || 0) + (+D.absorbed || 0), crit, fatal, buffed,
          secondary };
        if (e) {
          const n = e.k === 'poison' ? Math.max(1, +(e.turns || e.dur) || 1) : 1;
          const mult = 1 + (S(EL_STAT[D.el]) + S('puissance')) / 100, fixed = S('dommages') + S(EL_DMG[D.el]);
          const val = (b) => (crit ? b * CRIT_MULT * mult + fixed + S('dommagesCritiques') : b * mult + fixed) * pct;
          const zf = secondary ? ZONE_FALLOFF : 1;
          row.lo = val(+e.min || 0) * n * zf; row.hi = val(+(e.max ?? e.min) || 0) * n * zf;
          const rp = Math.min(+tg.resCap || 100, (+tg.stats?.[EL_RES_PCT[D.el]] || 0) + (+tg.stats?.resPctAll || 0));
          const rf = +tg.stats?.[EL_RES[D.el]] || 0;
          const adj = (x) => Math.max(0, (x - rf) * (1 - rp / 100));
          row.rp = rp; row.rf = rf; row.loR = adj(row.lo); row.hiR = adj(row.hi);
          row.ratio = row.v / ((row.loR + row.hiR) / 2 || 1);
        }
        rows.push(row);
      }
    }
    return { rows, stats };
  }

  function openDamageTest(spells) {
    document.querySelector('.dm-dtest')?.remove();
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const ov = document.createElement('div');
    ov.className = 'dm-dtest dm-picker';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483601;background:#000c;display:grid;justify-items:center;align-items:start;padding:4vh 16px 16px;font:13px system-ui,sans-serif;color:#eee';
    const close = () => ov.remove();
    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-a="close"]')) close(); });
    ov.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
    const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:5px 10px;color:#fff;cursor:pointer;font:600 12px system-ui,sans-serif;background:#2a231a';
    const fight = lastFight();
    const box = (html) => `<div style="width:min(900px,100%);max-height:90vh;display:flex;flex-direction:column;gap:8px;background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:14px;box-shadow:0 10px 40px #000">${html}</div>`;
    if (!fight) {
      ov.innerHTML = box(`<div style="display:flex;gap:8px;align-items:center"><b style="flex:1">🧪 Test du calcul</b><button data-a="close" style="${btn}">✕</button></div>
        <div>Aucun combat capturé pour ce personnage. Fais un combat (Auto ou manuel) dans un onglet du jeu avec l’extension active, puis rouvre ce test.</div>`);
      document.body.appendChild(ov);
      return;
    }
    const { rows, stats } = damageTest(fight, spells);
    const EL = (el) => ELEMENTS[el]?.name || '?';
    const r1 = (x) => Math.round(x);
    const statLine = Object.entries(stats).filter(([, v]) => +v).map(([k, v]) => `${k} ${v}`).join(', ');
    const text = [
      `Test calcul dégâts — combat ${fight.kind || ''} du ${new Date(fight.at).toLocaleString('fr-FR')} (${fight.status || ''})`,
      `Stats : ${statLine}`,
      ...rows.map((r) => `${r.card} (${r.ap ?? '?'} PA) → ${r.target} : ${r.v} ${EL(r.el)}${r.crit ? ' CRIT' : ''}${r.secondary ? ' [zone ×0,6]' : ''}${r.fatal ? ' (coup fatal)' : ''}${r.buffed ? ' [buff]' : ''}`
        + (r.lo != null ? ` | estimé ${r1(r.lo)}-${r1(r.hi)} sans rés. | ${r1(r.loR)}-${r1(r.hiR)} avec rés. (${r.rp} %, ${r.rf} fixe) | ratio ${r.ratio.toFixed(2)}` : ` | ${card(r)}`)),
    ].join('\n');
    const okRows = rows.filter((r) => r.lo != null && !r.fatal && !r.buffed);
    function card(r) { return r.ap == null ? 'arme ou carte hors collection : non gérée' : 'ligne de la carte introuvable'; }
    const inRange = okRows.filter((r) => r.v >= Math.floor(r.loR) - 1 && r.v <= Math.ceil(r.hiR) + 1).length;
    ov.innerHTML = box(`
      <div style="display:flex;gap:8px;align-items:center"><b style="flex:1;font-size:15px">🧪 Test du calcul — dernier combat (${esc(new Date(fight.at).toLocaleString('fr-FR'))})</b>
        <button data-a="copy" style="${btn};background:#2e6fbf">📋 Copier le récap</button><button data-a="close" style="${btn}">✕</button></div>
      <div style="color:#b9a98c;font-size:12px">Stats du combat : ${esc(statLine) || 'aucun bonus'}</div>
      <div style="font-size:12px">${okRows.length ? `<b>${inRange} / ${okRows.length}</b> coups dans la fourchette estimée (hors coups fatals, plafonnés par la vie restante, et coups sous buff).` : 'Aucun coup comparable.'}</div>
      <div style="overflow:auto">
        <table style="border-collapse:collapse;width:100%;font-size:12px">
          <tr style="color:#b9a98c;text-align:left"><th>Sort</th><th>Cible</th><th>Élément</th><th style="text-align:right">Observé</th><th style="text-align:right">Estimé sans rés.</th><th style="text-align:right">Avec rés. cible</th><th style="text-align:right">Ratio</th></tr>
          ${rows.map((r) => {
            const ok = r.lo != null && r.v >= Math.floor(r.loR) - 1 && r.v <= Math.ceil(r.hiR) + 1;
            const col = r.lo == null || r.fatal || r.buffed ? '#b9a98c' : ok ? '#6fcf7a' : '#ff7b6b';
            return `<tr style="border-top:1px solid #3a3024">
              <td>${esc(r.card)}${r.crit ? ' <b style="color:#f0c04a">CRIT</b>' : ''}${r.secondary ? ' <span title="Autre cible touchée par la zone : estimation ×0,6">[zone ×0,6]</span>' : ''}${r.buffed ? ' <span title="Un buff était actif : les stats ont pu changer">[buff]</span>' : ''}${r.lo == null ? ` <span style="color:#8a7d66">(${esc(card(r))})</span>` : ''}</td>
              <td>${esc(r.target)}${r.fatal ? ' ☠' : ''}</td>
              <td style="color:${ELEMENTS[r.el]?.color || '#888'}">${EL(r.el)}</td>
              <td style="text-align:right;font-weight:700;color:${col}">${r.v}</td>
              <td style="text-align:right">${r.lo != null ? `${r1(r.lo)} – ${r1(r.hi)}` : '—'}</td>
              <td style="text-align:right">${r.lo != null ? `${r1(r.loR)} – ${r1(r.hiR)} <span style="color:#8a7d66">(${r.rp} %)</span>` : '—'}</td>
              <td style="text-align:right">${r.ratio != null ? r.ratio.toFixed(2) : '—'}</td></tr>`;
          }).join('') || '<tr><td colspan="7" style="padding:10px;color:#b9a98c">Aucun coup de sort dans ce combat.</td></tr>'}
        </table>
      </div>
      <div style="color:#8a7d66;font-size:11px">Vert = dans la fourchette, rouge = hors fourchette, gris = non comparable (coup fatal ☠ plafonné par la vie, buff actif, ligne inconnue). « Copier le récap » puis colle-le moi.</div>`);
    ov.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-a="copy"]');
      if (!b) return;
      try { await navigator.clipboard.writeText(text); b.textContent = '✔ Copié'; } catch { b.textContent = '❌ Copie impossible'; }
    });
    document.body.appendChild(ov);
  }

  // ---------- Optimiseur de build : équipement qui maximise les dégâts d'un tour ----------
  // Stats d'un build = points de base (fiche perso) + objets (fusion, puis prestige +25 %/niveau + Bouclier de forge, hors PA/PM/PO/invoc.)
  // + bonus de panoplie (dofusdb, palier d'indice = nombre d'objets portés − 1, plafonné ; rien sous 2 objets — calé sur
  // le panneau « Panoplies » de la fiche). Dégâts d'un tour = meilleure combinaison de K sorts tenant dans les PA
  // (formule de la tierlist, cible sans résistances). Recherche locale (emplacement par emplacement + panoplies
  // complètes) avec plusieurs départs.
  const CHAR_KEYS = { 0: 'pv', 1: 'pa', 10: 'force', 11: 'vitalite', 12: 'sagesse', 13: 'chance', 14: 'agilite', 15: 'intelligence',
    16: 'dommages', 18: 'critique', 19: 'po', 23: 'pm', 25: 'puissance', 26: 'invocations', 27: 'esquivePA', 28: 'esquivePM',
    33: 'resPctTerre', 34: 'resPctFeu', 35: 'resPctEau', 36: 'resPctAir', 37: 'resPctNeutre', 40: 'pods', 44: 'initiative',
    48: 'prospection', 49: 'soins', 50: 'renvoi', 54: 'resTerre', 55: 'resFeu', 56: 'resEau', 57: 'resAir', 58: 'resNeutre',
    78: 'fuite', 79: 'tacle', 82: 'retraitPA', 83: 'retraitPM', 84: 'dommagesPoussee', 85: 'resPoussee', 86: 'dommagesCritiques',
    87: 'resCritiques', 88: 'dommagesTerre', 89: 'dommagesFeu', 90: 'dommagesEau', 91: 'dommagesAir', 92: 'dommagesNeutre',
    120: 'dmgPctDistance', 121: 'resPctDistance', 122: 'dmgPctArmes', 123: 'dmgPctSorts', 124: 'resPctMelee', 125: 'dmgPctMelee' };
  const PRESTIGE_GEAR_PCT = 25;
  // Cibles particulières (option de l'optimiseur) : % de résistance par élément [Neutre, Terre, Feu, Eau, Air], relevés
  // sur l'état de combat (aucune résistance fixe). Kralamoure Géant = boss de guilde (10 tours, on vise le total de dégâts).
  const BUILD_TARGETS = { krala: { name: 'Kralamoure Géant', resPct: [20, 20, 20, 30, 20] } };
  // Objectifs de l'optimiseur (menu « Objectif ») : dégâts par tour (éventuellement contre une cible à résistances),
  // ou une stat à maximiser (stat, valeur value(S), points de caractéristiques à y mettre : points) — les dégâts ne
  // servent alors qu'à départager deux builds. Prospection : 100 de base, +1 par 10 de Chance (objets et points), vérifié en jeu.
  const BUILD_GOALS = {
    dps: { label: '⚔️ Dégâts par tour' },
    krala: { label: '🐙 Dégâts sur Kralamoure', target: BUILD_TARGETS.krala },
    prospection: { label: '💰 Prospection', stat: 'prospection', points: 'chance', also: ['chance'],
      value: (S) => 100 + (S.prospection || 0) + Math.floor((S.chance || 0) / 10) },
    sagesse: { label: '📚 Sagesse', stat: 'sagesse', points: 'sagesse', value: (S) => S.sagesse || 0 },
  };
  const PRESTIGE_EXCLUDED = new Set(['pa', 'pm', 'po', 'invocations']);
  const SET_CACHE_KEY = 'dmSetBonuses';
  const SET_CACHE_MS = 7 * 24 * 3600 * 1000;
  const OFFENSE_KEYS = ['force', 'intelligence', 'chance', 'agilite', 'puissance', 'dommages', 'dommagesNeutre', 'dommagesTerre',
    'dommagesFeu', 'dommagesEau', 'dommagesAir', 'critique', 'dommagesCritiques', 'dmgPctSorts', 'pa', 'po'];
  const BUILD_OPTS_KEY = 'dmBuildOpts';
  const SAVE_DECK_FALLBACK = '60aca5c0a9a6852940d3385c5d3ad45fe51092e4ed';   // saveDeck([{ id, f }], indice du deck : 0 = deck 1)
  const DECK_TARGET = 2;                                                        // deck 3
  const DECK_CARDS = 10;
  let saveDeckId = null;
  // Liste noire de l'optimiseur : objets (par id, toutes fusions) à ne jamais proposer. cfg.buildBlacklist = { id: nom }
  const buildBlacklist = () => cfg.buildBlacklist || {};
  // PA de base 6 + PA du Prestige (P1, P4, P7 : +1 chacun) + PA des objets et panoplies (vérifié sur la fiche : P3 → 7, P4 → 8).
  // Prestige : P1 +1 PA, P2 +2 PO, P3 +2 PM, P4 +1 PA, P5 +3 PO, P6 +3 PM, P7 +1 PA (cumulés).
  const prestigePa = (p) => [1, 4, 7].filter((n) => (p || 0) >= n).length;
  const prestigePo = (p) => ((p || 0) >= 2 ? 2 : 0) + ((p || 0) >= 5 ? 3 : 0);
  const buildPaOf = (level, prestige = 0) => (S) => Math.min(12, 6 + prestigePa(prestige) + (S.pa || 0));
  const buildPvOf = (level) => (S) => 50 + 5 * level + (S.vitalite || 0) + (S.pv || 0);

  // Builds enregistrés (💾 dans l'optimiseur, aussi listés dans la bulle ❤️) : cfg.buildSaves = [{ id, name, who, at, data }].
  // data = résultat de l'optimiseur sans fonctions ni bestiaire complet ; c'est une photo : stocks HDV et inventaire ont pu changer.
  const BUILD_SAVES_MAX = 20;
  const buildSaves = () => cfg.buildSaves || [];
  function packBuild(r) {
    const zones = {};
    for (const c of Object.values(r.final)) for (const [, , , , zs] of c?.sources || []) for (const z of zs) if (r.bestiary?.zones[z]) zones[z] = r.bestiary.zones[z];
    const goalKey = Object.keys(BUILD_GOALS).find((k) => BUILD_GOALS[k] === r.goal) || 'dps';
    const { pvOf, paOf, goal, setFx, equipped, ...rest } = r;
    return JSON.parse(JSON.stringify({ ...rest, goalKey, bestiary: r.bestiary ? { count: r.bestiary.count, at: r.bestiary.at, zones } : null }));
  }
  // Dernière recherche de l'optimiseur (par personnage), réaffichée à la réouverture : localStorage, photo comme un build enregistré.
  const LAST_BUILD_KEY = 'dmLastBuild';
  const lastBuildAll = () => { try { return JSON.parse(localStorage.getItem(LAST_BUILD_KEY) || '{}'); } catch { return {}; } };
  const lastBuild = () => lastBuildAll()[myName() || '?'] || null;
  function rememberBuild(r) {
    try {
      const all = lastBuildAll();
      all[myName() || '?'] = { at: Date.now(), data: packBuild(r) };
      localStorage.setItem(LAST_BUILD_KEY, JSON.stringify(all));
    } catch (e) { DM.log(`optimiseur : dernière recherche non gardée (${e.message})`); }
  }
  function unpackBuild(d) {
    const r = { ...d, goal: BUILD_GOALS[d.goalKey] || BUILD_GOALS.dps, pvOf: buildPvOf(d.statLevel || d.sheet.level), paOf: buildPaOf(d.statLevel || d.sheet.level, d.sheet.prestige) };
    r.target = r.goal.target || null;
    // même objet des deux côtés (rien à changer sur l'emplacement) : identité rétablie après le passage en JSON
    for (const s of r.slots) if (r.final[s.slot] && r.final[s.slot].uid === r.current[s.slot]?.uid) r.final[s.slot] = r.current[s.slot];
    return r;
  }

  // Objets favoris (cœur dans l'optimiseur, bulle ❤️) : cfg.buildFavs = { id: { name, icon, lvl, type, setName } }
  const buildFavs = () => cfg.buildFavs || {};
  const toggleFav = (c) => {
    const favs = { ...buildFavs() };
    if (favs[c.id]) delete favs[c.id];
    else favs[c.id] = { name: c.name, icon: c.icon || null, lvl: c.lvl ?? null, type: c.type || null, setName: c.setName || null };
    return save({ buildFavs: favs });
  };

  // Bonus de panoplie par nom (dofusdb, en cache 7 jours) : { nom: [[{k, v}], …] | null }
  async function fetchSetBonuses(names) {
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem(SET_CACHE_KEY) || '{}'); } catch { /* stockage indisponible */ }
    const now = Date.now();
    const missing = names.filter((n) => !cache[n] || now - cache[n].at > SET_CACHE_MS);
    for (let i = 0; i < missing.length; i += 25) {
      const batch = missing.slice(i, i + 25);
      const q = batch.map((n) => `name.fr[$in][]=${encodeURIComponent(n)}`).join('&');
      const url = `https://api.dofusdb.fr/item-sets?${q}&$limit=50&$select[]=name&$select[]=effects&lang=fr`;
      let r = null;
      for (const wait of [0, 2000, 5000, 10000]) {
        if (wait) await sleep(wait);
        r = await DM.fetchT(url, {}, 20000).catch(() => null);
        if (r?.ok) break;
      }
      if (!r?.ok) throw new Error(`dofusdb : ${r ? `HTTP ${r.status}` : 'injoignable'} (après 4 essais)`);
      const found = {};
      for (const set of (await r.json()).data || []) {
        found[set.name?.fr] = (set.effects || []).map((lvl) => (lvl || []).map((e) => ({ k: CHAR_KEYS[e.characteristic], v: +e.from || 0 })).filter((e) => e.k && e.v));
      }
      for (const n of batch) cache[n] = { at: now, fx: found[n] || null };
    }
    try { localStorage.setItem(SET_CACHE_KEY, JSON.stringify(cache)); } catch { /* idem */ }
    return Object.fromEntries(names.map((n) => [n, cache[n]?.fx || null]));
  }
  // Points de caractéristiques : coût d'un point selon la valeur déjà investie (paliers de la fiche, ex. Force
  // 1 point jusqu'à 100, puis 2, 3, 4 ; Sagesse 3 ; Vitalité 1). Capital = points dépensés + points libres (= 5 × (niveau − 1)).
  const POINT_STATS = ['vitalite', 'sagesse', 'force', 'intelligence', 'chance', 'agilite'];
  const OFF_POINT_STATS = ['force', 'intelligence', 'chance', 'agilite'];
  const DEFAULT_POINT_TIERS = { vitalite: [[0, 1]], sagesse: [[0, 3]] };
  const ELEM_POINT_TIERS = [[0, 1], [100, 2], [200, 3], [300, 4]];
  const pointCost = (tiers, v) => { let c = tiers[0]?.[1] || 1; for (const [th, k] of tiers) if (v >= th) c = k; return c; };
  const spentPoints = (tiers, base) => { let n = 0; for (let v = 0; v < base; v++) n += pointCost(tiers, v); return n; };
  // Répartition des points sur la fiche : server actions de /personnage « resetPoints() » (tout remet en libre)
  // et « allocatePoints(stat, n) » (n points de stat, coût selon les paliers). Elles renvoient la page re-rendue
  // (pas de ligne « 1: »), on y relit pointsFree et la base de chaque stat pour vérifier.
  const POINTS_ACTION_FALLBACK = { resetPoints: '004944f9b01c999a6788b5755bcc24bf192bac43ce', allocatePoints: '60dbf9f72590dfc5c79366a0bed9bbbc123e6de0e4' };
  const pointsActionIds = {};
  async function pointsCall(name, args) {
    for (let attempt = 0; ; attempt++) {
      try {
        if (!pointsActionIds[name]) pointsActionIds[name] = await findAction((await fetchFlight('/personnage')).chunks, name, POINTS_ACTION_FALLBACK[name]);
        const tree = encodeURIComponent(JSON.stringify(['', { children: ['personnage', { children: ['__PAGE__', {}, null, null, 4096] }, null, null, 4096] }, null, null, 4116]));
        const r = await DM.fetchT('/personnage', {
          method: 'POST', credentials: 'same-origin',
          headers: { Accept: 'text/x-component', 'Content-Type': 'text/plain;charset=UTF-8', 'Next-Action': pointsActionIds[name], 'Next-Router-State-Tree': tree },
          body: JSON.stringify(args),
        });
        if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
        const text = await r.text();
        const line = text.split(/\r?\n/).find((l) => l.startsWith('1:'));
        const res = line ? JSON.parse(line.slice(2)) : null;
        if (res?.error) throw Object.assign(new Error(res.error), { game: true });
        const free = text.match(/"pointsFree":(\d+)/);
        const rows = text.match(/"rows":(\[.*?\]),"pointsFree"/);
        if (!free || !rows) throw new Error('Réponse du serveur illisible');
        return { free: +free[1], base: Object.fromEntries(JSON.parse(rows[1]).map((x) => [x.key, +x.base || 0])) };
      } catch (e) {
        if (!e.game) delete pointsActionIds[name];
        if (e.game || attempt >= 2) throw e;
        await sleep(attempt ? 5000 : 2000);
      }
    }
  }
  // Applique la répartition `target` ({ stat: points }) : réinitialise seulement si une stat doit baisser.
  async function applyPoints(target, current, say) {
    let base = { ...current };
    try { base = (await fetchCharSheet()).base; } catch { /* fiche illisible : on part des points connus */ }   // état réel (reprise après erreur)
    if (POINT_STATS.some((k) => (base[k] || 0) > (target[k] || 0))) {
      say('Réinitialisation des points…');
      ({ base } = await pointsCall('resetPoints', []));
    }
    for (const k of POINT_STATS) {
      const n = (target[k] || 0) - (base[k] || 0);
      if (n <= 0) continue;
      say(`${STAT_LABELS[k] || k} : +${n}…`);
      const r = await pointsCall('allocatePoints', [k, n]);
      if ((r.base[k] || 0) !== (target[k] || 0)) throw new Error(`${STAT_LABELS[k] || k} : ${r.base[k] || 0} au lieu de ${target[k]} (points libres : ${r.free})`);
      base = r.base;
      await sleep(300 + Math.random() * 300);
    }
    DM.log(`optimiseur : points répartis ${JSON.stringify(base)}`);
    return base;
  }

  // Bestiaire (/bestiaire) : tous les objets lootables (stats complètes) et, pour chacun, les monstres qui le lâchent, leurs
  // zones et tes chances (prospection comprise, calculées par le jeu ; 0 = « objet bonus de victoire », pas un drop normal),
  // plus les Boss du Chemin (onglet boss, HTML rendu seulement : objets lâchés à ~90 %). Copie locale d'un jour.
  const BESTIARY_KEY = 'dmBestiary';
  const BESTIARY_MS = 24 * 3600 * 1000;
  async function fetchBestiary(say) {
    try {
      const c = JSON.parse(localStorage.getItem(BESTIARY_KEY) || 'null');
      if (c?.v === 2 && Date.now() - c.at < BESTIARY_MS) return c;
    } catch { /* copie absente ou illisible */ }
    say?.('Import du bestiaire (copie locale absente ou de plus d’un jour)…');
    const { flight } = await fetchFlight('/bestiaire');
    const { props } = rscProps(flight, (x) => Array.isArray(x.monsters) && Array.isArray(x.items));
    if (!props) throw new Error('Bestiaire illisible');
    // zones : id (le même que /chasse?zone=) → [nom (région), niveau min, niveau max]
    const zones = Object.fromEntries((props.zones || []).map((z) => [z.id, [z.area && z.area !== z.n ? `${z.n} (${z.area})` : z.n, z.min, z.max]]));
    const items = props.items.filter((it) => it?.id).map((it) => ({ id: it.id, n: it.n, lvl: it.lvl, s: it.s, icon: it.icon, r: it.r,
      st: it.st || {}, setName: it.setName || null, two: !!it.w?.twoHanded }));
    const drops = {};   // id objet → [[monstre, niveau min, niveau max, ta chance %, ids de zones]], meilleure chance d'abord
    for (const m of props.monsters) {
      for (const [id, , mine] of Array.isArray(m.d) ? m.d : []) {
        (drops[id] ||= []).push([m.n, m.lo, m.hi, +mine || 0, m.z || []]);
      }
    }
    for (const id in drops) drops[id].sort((a, b) => b[3] - a[3]);
    // Boss du Chemin : objets (stats lues dans le payload, par nom) et boss qui les lâchent (lus dans le HTML rendu)
    say?.('Import des Boss du Chemin…');
    const bp = await fetchFlight('/bestiaire?onglet=boss');
    const known = new Map(items.map((it) => [it.n, it]));
    const { rows } = rscProps(bp.flight, () => false);
    const walk = (x) => {
      if (x == null || typeof x !== 'object') return;
      if (!Array.isArray(x) && Number.isInteger(x.id) && x.n && x.s && x.st && typeof x.st === 'object' && !known.has(x.n)) {
        const it = { id: x.id, n: x.n, lvl: x.lvl, s: x.s, icon: x.icon, r: x.r, st: x.st, setName: x.setName || null, two: !!x.w?.twoHanded };
        known.set(x.n, it);
        items.push(it);
      }
      for (const k in x) walk(x[k]);
    };
    for (const id in rows) walk(rows[id]);
    const boss = {};   // id objet → [[boss, niveau, étape du Chemin, chance %, zone, vaincu, id de zone de chasse ou null]]
    const zoneByName = new Map((props.zones || []).map((z) => [z.n, z.id]));
    const doc = new DOMParser().parseFromString(bp.html, 'text/html');
    for (const panel of doc.querySelectorAll('main .panel, main [class*="__card"]')) {
      // v2 du site : l'image du boss est dans un <span> (sprite), le bloc nom / zone / étape est le voisin de ce span
      const img = panel.querySelector('img[src*="/img/monsters/"]');
      const head = img?.nextElementSibling || img?.parentElement?.nextElementSibling;
      const lis = panel.querySelectorAll('li');
      if (!head || head.children.length < 3 || !lis.length) continue;
      const [nameEl, zoneEl, stepEl] = head.children;
      const zt = zoneEl.textContent, st = stepEl.textContent;
      const src = [nameEl.textContent.trim(), +(zt.match(/niveau\s*(\d+)/) || [])[1] || 0, +(st.match(/étape\s*(\d+)/) || [])[1] || 0,
        0, zt.replace(/\s*·\s*niveau.*$/, '').trim(), /vaincu/.test(st)];
      src[6] = zoneByName.get(src[4]) ?? null;
      for (const li of lis) {
        const it = known.get(li.querySelector('[title]')?.getAttribute('title'));
        const pct = li.textContent.match(/([\d,.]+)\s*%/);
        if (it) (boss[it.id] ||= []).push(Object.assign([...src], { 3: pct ? +pct[1].replace(',', '.') : 0 }));
      }
    }
    const out = { v: 2, at: Date.now(), items, drops, boss, zones };
    try { localStorage.setItem(BESTIARY_KEY, JSON.stringify(out)); } catch (e) { DM.log(`bestiaire : copie locale impossible (${e.message})`); }
    DM.log(`bestiaire : ${items.length} objets, ${props.monsters.length} monstres importés`);
    return out;
  }

  // Multiplicateur de l'équipement = 1 + Prestige (+25 % par niveau) + Bouclier de forge (forgeBonusPct du jeu), appliqué
  // aux objets ET aux bonus de panoplie, arrondi objet par objet, hors PA/PM/PO/invocations (ex. P3 + forge niv. 98 :
  // 1 + 0,75 + 0,132 = ×1,882, relevé au point près sur la fiche). Contrôlé sur la fiche (bonus des points de
  // caractéristiques = Σ arrondi(stat × m) des objets portés et des panoplies actives) ; recalé seulement s'il ne colle pas.
  const FORGE = { maxLevel: 200 };
  const forgeBonusPct = (lvl) => {   // même calcul que le site : 200^((niv − 1) / 199) %, arrondi
    if (!(lvl > 0)) return 0;
    const v = 200 ** ((Math.min(FORGE.maxLevel, lvl) - 1) / (FORGE.maxLevel - 1));
    return v < 10 ? Math.round(100 * v) / 100 : Math.round(10 * v) / 10;
  };
  // Niveau du Bouclier de forge (/forgemagie, props du ForgeView), relu à chaque recherche ; 0 = pas encore de bouclier.
  // Page illisible (site saturé…) : dernier niveau connu (cfg.forgeLevel), signalé dans le journal.
  async function fetchForgeLevel() {
    try {
      const { flight } = await fetchFlight('/forgemagie');
      const props = rscProps(flight, (x) => 'orbs' in x && 'leftToday' in x && 'level' in x).props;
      if (!props) throw new Error('niveau introuvable sur /forgemagie');
      const lvl = +props.level || 0;
      if (lvl !== cfg.forgeLevel) save({ forgeLevel: lvl });
      return lvl;
    } catch (e) {
      DM.log(`forgemagie : ${e.message} — dernier niveau connu utilisé (${cfg.forgeLevel ?? 0})`);
      return +cfg.forgeLevel || 0;
    }
  }
  function fitGearMult(worn, setFx, sheet, guess) {
    const vals = Object.fromEntries(POINT_STATS.map((k) => [k, []]));
    const sets = {};
    for (const c of worn) {
      for (const k of POINT_STATS) if ((c.eff?.[k] || 0) > 0) vals[k].push(c.eff[k]);
      if (c.setName) sets[c.setName] = (sets[c.setName] || 0) + 1;
    }
    for (const [n, cnt] of Object.entries(sets)) for (const { k, v } of setTier(setFx[n], cnt) || []) if (vals[k] && v > 0) vals[k].push(v);
    const err = (m) => POINT_STATS.reduce((e, k) => e + Math.abs(vals[k].reduce((n, v) => n + Math.round(v * m), 0) - (sheet.bonus[k] || 0)), 0);
    let best = guess, bestErr = err(guess);
    const tol = POINT_STATS.length * 2;
    // la valeur du jeu (prestige + forge) colle : on la garde ; sinon on cherche autour
    if (bestErr > tol) for (let m = 1; m <= guess + 0.5 + 1e-9; m += 0.0005) { const e = err(m); if (e < bestErr) { best = m; bestErr = e; } }
    // écart restant important (parchemins d'arène, objet illisible…) : on garde la valeur du jeu
    const ok = bestErr <= tol;
    DM.log(`optimiseur : multiplicateur d'équipement ${best.toFixed(4)} (jeu ${guess.toFixed(4)}, écart ${bestErr}${ok ? '' : ', rejeté'})`);
    return ok ? best : guess;
  }

  // dofusdb : effects[i] = bonus avec i + 1 objets portés (effects[0] vide) ; vérifié sur la fiche du jeu
  // (Frimanoplie 2/4 → effects[1], sans le +1 PA de effects[2]).
  const setTier = (fx, count) => (!fx?.length || count < 2 ? null : fx[Math.min(count - 1, fx.length - 1)]);

  // Panoplies de la fiche (/personnage) : le jeu affiche, pour chaque panoplie portée, tous ses paliers (« 2 objets : +1 PA ·
  // +30 Force… », « 3 objets… »). Ses tables ne suivent pas toujours dofusdb (palier décalé selon la panoplie) : ce qui est
  // lu ici fait foi et est retenu (cfg.setTiers) pour les recherches suivantes.
  // → { nom: { count, max, tiers: { n: [{ k, v }] } } } ; libellés inconnus ignorés.
  const STAT_BY_LABEL = Object.fromEntries(Object.entries(STAT_LABELS).map(([k, l]) => [l.toLowerCase(), k]));
  function parseBonusText(text) {
    const out = [];
    for (const part of String(text).split('·')) {
      const m = part.trim().match(/^([+-]?\d+)\s*(%?)\s*(.+)$/);
      if (!m) continue;
      const k = STAT_BY_LABEL[`${m[2] ? '% ' : ''}${m[3].trim()}`.toLowerCase()];
      if (k) out.push({ k, v: +m[1] });
    }
    return out;
  }
  function parseSheetSets(flight) {
    const rows = {};
    for (const line of flight.split(/\r?\n/)) {
      const m = line.match(/^([0-9a-f]+):([[{].*)$/);
      if (m) { try { rows[m[1]] = JSON.parse(m[2]); } catch { /* ligne partielle */ } }
    }
    const res = (v) => { const m = typeof v === 'string' && v.match(/^\$L?([0-9a-f]+)$/); return m && rows[m[1]] !== undefined ? rows[m[1]] : v; };
    const kids = (el) => { const c = res(Array.isArray(el) && el[0] === '$' ? el[3]?.children : el); return Array.isArray(c) ? c.map(res) : c == null ? [] : [res(c)]; };
    const text = (el) => { el = res(el); if (el == null || typeof el === 'boolean') return ''; if (typeof el !== 'object') return String(el); if (el[0] === '$') return kids(el).map(text).join(''); return Array.isArray(el) ? el.map(text).join('') : ''; };
    const out = {};
    const seen = new Set();
    const walk = (el, depth = 0) => {
      el = res(el);
      if (!el || typeof el !== 'object' || depth > 60 || seen.has(el)) return;
      seen.add(el);
      if (el[0] === '$') {
        const ch = kids(el);
        // en-tête « Nom (n/max) » suivi de la liste des paliers
        const head = ch.find((c) => Array.isArray(c) && c[0] === '$' && /\(\d+\/\d+\)$/.test(text(c).trim()));
        if (head) {
          const m = text(head).trim().match(/^(.+?)\s*\((\d+)\/(\d+)\)$/);
          const tiers = {};
          const lis = [];
          const collect = (x, d = 0) => { x = res(x); if (!x || typeof x !== 'object' || d > 20) return; if (x[0] === '$' && x[1] === 'li') lis.push(x); for (const c of (x[0] === '$' ? kids(x) : Array.isArray(x) ? x : [])) collect(c, d + 1); };
          for (const c of ch) if (c !== head) collect(c);
          for (const li of lis) {
            const t = text(li).trim().match(/^(\d+)\s*objets?[^:]*:\s*(.+)$/);
            if (t) tiers[+t[1]] = parseBonusText(t[2]);
          }
          if (m && Object.keys(tiers).length) out[m[1].trim()] = { count: +m[2], max: +m[3], tiers };
        }
        for (const c of ch) walk(c, depth + 1);
      } else if (Array.isArray(el)) for (const c of el) walk(c, depth + 1);
      else for (const k in el) walk(el[k], depth + 1);
    };
    for (const id in rows) walk(rows[id]);
    return out;
  }

  // Fiche perso : niveau, prestige, points de base, PV/PA affichés, panoplies actives (texte du jeu).
  async function fetchCharSheet() {
    const { flight } = await fetchFlight('/personnage');
    const { rows } = rscProps(flight, () => false);
    const res = (v) => rscResolve(rows, v);
    const alloc = rscProps(flight, (x) => Array.isArray(x.rows) && x.rows[0]?.key && 'pointsFree' in x).props;
    const info = rscProps(flight, (x) => 'prestige' in x && 'level' in x && 'equipped' in x).props;
    if (!alloc || !info) throw new Error('Fiche personnage illisible');
    const base = {}, bonus = {}, tiers = {};
    for (const r of res(alloc.rows).map(res)) {
      base[r.key] = +r.base || 0; bonus[r.key] = +r.bonus || 0;
      const t = res(r.tiers);
      tiers[r.key] = Array.isArray(t) && t.length ? t.map(res) : DEFAULT_POINT_TIERS[r.key] || ELEM_POINT_TIERS;
    }
    const pointsFree = +alloc.pointsFree || 0;
    const capital = pointsFree + Object.keys(base).reduce((n, k) => n + spentPoints(tiers[k], base[k]), 0);
    // tuiles de la fiche : valeur, puis libellé (« PV », « PA », « % Critique »…)
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tile = (label) => +(flight.match(new RegExp(`"children":"?(-?[\\d.,]+)"?\\}\\],\\["\\$","div",null,\\{"className":"[^"]*","children":"${esc(label)}"\\}`))?.[1]?.replace(',', '.') ?? NaN);
    // panoplies portées : « Nom (n/max) » puis le palier actif (v2 : liste « N objets : … » ; avant : une ligne de texte)
    const sets = [
      ...flight.matchAll(/"children":\["([^"]+)"," \(",(\d+),"\/",(\d+),"\)"\]\}\],\["\$","div",null,\{"className":"text-muted","children":"([^"]*)"\}/g),
      ...flight.matchAll(/"children":\["([^"]+)"," \(",(\d+),"\/",(\d+),"\)"\]\}\],\["\$","ul",null,\{[^{]*"children":\[\["\$","li","\d+",\{"className":"text-parchment","children":\[\["\$","span",null,\{"className":"font-bold","children":"\d+ objets[^"]*"\}\]," :"," ","([^"]*)"/g),
    ].map((m) => ({ name: m[1], count: +m[2], max: +m[3], text: m[4] }));
    const forge = await fetchForgeLevel();
    // paliers des panoplies portées, tels que le jeu les affiche : retenus pour les recherches suivantes
    try {
      const game = parseSheetSets(flight);
      if (Object.keys(game).length) {
        const known = { ...(cfg.setTiers || {}) };
        for (const [n, s] of Object.entries(game)) known[n] = { max: s.max, tiers: { ...(known[n]?.tiers || {}), ...s.tiers }, at: Date.now() };
        save({ setTiers: known });
      }
    } catch (e) { DM.log(`fiche : panoplies illisibles (${e.message})`); }
    return { level: +info.level || 1, prestige: +info.prestige || 0, forge, forgePct: forgeBonusPct(forge), base, bonus, tiers, pointsFree, capital,
      pv: tile('PV'), pa: tile('PA'), crit: tile('% Critique'), sets };
  }

  // Signature de dégâts d'une carte : par élément, base moyenne cumulée (B) et nombre de coups (N, pour les dommages fixes).
  function spellProfile(card) {
    const B = [0, 0, 0, 0, 0], N = [0, 0, 0, 0, 0];
    let any = false;
    for (const e of card.eff || []) {
      if (!DMG_FIXED.has(e.k)) continue;
      any = true;
      const n = e.k === 'poison' ? Math.max(1, +(e.turns || e.dur) || 1) : 1;
      const w = e.chance != null && +e.chance < 100 ? Math.max(0, +e.chance) / 100 : 1;
      const el = Number.isInteger(e.el) ? e.el : 0;
      B[el] += w * n * ((+e.min || 0) + (+(e.max ?? e.min) || 0)) / 2;
      N[el] += w * n;
    }
    return any ? { B, N, cc: +card.cc || 0 } : null;
  }
  // Dégâts moyens d'un sort avec ces stats (même formule que spellDamage, en version rapide).
  function profileAvg(pf, S) {
    const pct = (1 + (S.dmgPctSorts || 0) / 100) * (1 + (S.po || 0) * SPECTRAL_PER_PO / 100);
    const p = pf.cc > 0 ? Math.min(1, Math.max(0, (pf.cc + (S.critique || 0)) / 100)) : 0;
    let tot = 0;
    for (let el = 0; el < 5; el++) {
      if (!pf.N[el]) continue;
      const m = 1 + ((S[EL_STAT[el]] || 0) + (S.puissance || 0)) / 100;
      const fixed = (S.dommages || 0) + (S[EL_DMG[el]] || 0);
      tot += pf.B[el] * m * (1 + p * (CRIT_MULT - 1)) + pf.N[el] * (fixed + p * (S.dommagesCritiques || 0));
    }
    return tot * pct;
  }
  // Meilleur tour sans limite de nombre de sorts (cartes distinctes) dont la somme des PA ≤ pa : sac à dos 0/1.
  function bestTurnPA(spells, S, pa) {
    const dp = new Array(pa + 1).fill(0), sel = Array.from({ length: pa + 1 }, () => []);
    for (const sp of spells) {
      const v = profileAvg(sp.pf, S);
      if (v <= 0 || sp.ap > pa) continue;
      for (let a = pa; a >= sp.ap; a--) {
        const nv = dp[a - sp.ap] + v;
        if (nv > dp[a]) { dp[a] = nv; sel[a] = [...sel[a - sp.ap], { sp, v }]; }
      }
    }
    return { dmg: dp[pa], used: sel[pa], pa };
  }

  async function fetchHdvGear(types, level, failed = []) {
    const out = [];
    for (const type of types) {
      let flight;
      try {
        ({ flight } = await fetchFlight(`/hdv?emplacement=${encodeURIComponent(type)}`));
      } catch (e) {
        failed.push(type);   // déjà réessayé plusieurs fois : on continue sans cet emplacement
        DM.log(`optimiseur : HDV ${type} illisible (${e.message})`);
        continue;
      }
      const { rows, props } = rscProps(flight, (x) => Array.isArray(x.listings));
      for (const raw of props ? rscResolve(rows, props.listings) || [] : []) {
        const l = rscResolve(rows, raw), it = rscResolve(rows, l?.item);
        if (!it?.id || l.mine || (it.lvl || 0) > level) continue;
        out.push({ id: it.id, name: it.n, lvl: it.lvl, type: it.s, rarity: it.r, icon: it.icon, fusion: +l.fusion || 0,
          setName: it.setName || null, two: !!rscResolve(rows, it.w)?.twoHanded, eff: fusedStats(rscResolve(rows, it.st), it.s, +l.fusion || 0),
          src: 'hdv', price: +l.price || 0, listingId: l.id, seller: l.seller });
      }
      await sleep(250);
    }
    // une seule annonce par objet (id + fusion) : la moins chère
    const best = new Map();
    for (const c of out) { const k = `${c.id}|${c.fusion}`; if (!best.has(k) || best.get(k).price > c.price) best.set(k, c); }
    return [...best.values()];
  }

  // Compte « banque » (onglet de l'autre contexte) : ses objets non portés, avec stats (fusion comprise, sans prestige :
  // celui du personnage qui les portera s'applique), en excluant les exemplaires liés (achetés / reçus il y a < 24 h).
  async function peerGear() {
    try {
      const [state, sell] = await Promise.all([fetchEquipState(), fetchSellable({ tradable: true })]);
      const now = Date.now();
      const free = new Map();   // id|fusion → exemplaires échangeables
      for (const e of sell.entries) {
        if (e.boundUntil && new Date(e.boundUntil) > now) continue;
        const k = `${e.id}|${e.fusion || 0}`;
        free.set(k, (free.get(k) || 0) + (+e.qty || 0));
      }
      const entries = state.entries.filter((e) => free.get(`${e.id}|${e.fusion || 0}`) > 0)
        .map((e) => ({ id: e.id, name: e.name, lvl: e.lvl, type: e.type, rarity: e.rarity, icon: e.icon, fusion: e.fusion,
          setName: e.setName, two: e.two, eff: e.eff }));
      return { ok: true, name: myName(), entries, bound: state.entries.length - entries.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Lecture de toutes les données + recherche. say(msg) : progression.
  async function optimizeBuild(opts, say) {
    say('Lecture de la fiche personnage…');
    const sheet = await fetchCharSheet();
    say('Lecture de l’inventaire…');
    const state = await fetchEquipState();
    say('Lecture des sorts…');
    const sp = await fetchSpells();
    const level = sheet.level;
    // Niveau max (option) : objets jusqu'à ce niveau. Au-dessus du niveau actuel, prévision : PV, PA de base et points
    // de caractéristiques de ce niveau (5 points par niveau). Vide = niveau actuel.
    const lvlOpt = Math.round(+opts.lvlMax || 0);
    const planLevel = lvlOpt > 0 ? Math.min(200, lvlOpt) : level;
    const statLevel = Math.max(level, planLevel);
    const planCapital = sheet.capital + 5 * (statLevel - level);
    let gearMult = 1 + sheet.prestige * PRESTIGE_GEAR_PCT / 100 + (sheet.forgePct || 0) / 100;   // contrôlé plus bas sur la fiche (fitGearMult)
    const withPrestige = (eff) => {
      if (gearMult === 1) return eff;
      const o = {};
      for (const [k, v] of Object.entries(eff || {})) o[k] = v > 0 && !PRESTIGE_EXCLUDED.has(k) ? Math.round(v * gearMult) : v;
      return o;
    };
    let pool = [
      ...state.entries.filter((e) => !(e.lvl > planLevel)).map((e) => ({ ...e, src: 'inv' })),
      ...state.slots.filter((s) => s.cur).map((s) => ({ ...s.cur, src: 'worn', wornSlot: s.slot })),
    ];
    let bank = null;
    if (opts.bank) {
      say('Lecture de l’inventaire de la banque (autre compte)…');
      const r = await send({ type: 'peerGear' }).catch((e) => ({ ok: false, error: e.message }));
      if (!r?.ok) throw new Error(`Banque : ${r?.error || 'onglet de l’autre compte injoignable'}`);
      bank = { name: r.name || 'banque', count: r.entries.length, bound: r.bound || 0 };
      pool.push(...r.entries.filter((e) => !(e.lvl > planLevel)).map((e) => ({ ...e, src: 'bank', bankName: bank.name })));
    }
    const hdvFailed = [];
    if (opts.hdv) {
      say('Lecture de l’HDV…');
      pool.push(...await fetchHdvGear([...new Set(state.slots.map((s) => s.accepts))], planLevel, hdvFailed));
    }
    // bestiaire : objets lootables que tu n'as pas (ni porté, ni inventaire, ni banque, ni en vente à l'HDV fouillé)
    let bestiary = null;
    if (opts.bestiary) {
      const b = await fetchBestiary(say);
      // seulement ce que tu possèdes : un objet aussi en vente à l'HDV reste lootable (sinon, au-dessus du budget, il disparaissait)
      const have = new Set(pool.filter((c) => c.src !== 'hdv').map((c) => c.id));
      // option « drops de monstres uniquement » : seulement les objets qu'on obtient en chasse, sur les monstres d'une zone
      // (drop avec chance, ou « objet bonus de victoire » propre à la zone, chance non publiée) — pas ceux des seuls boss
      const realDrop = (id) => (b.drops[id] || []).some(([, , , , zs]) => zs?.length);
      const add = b.items.filter((it) => !have.has(it.id) && !(it.lvl > planLevel) && (opts.dropsOnly === false || realDrop(it.id)));
      pool.push(...add.map((it) => ({ id: it.id, name: it.n, lvl: it.lvl, type: it.s, rarity: it.r, icon: it.icon, fusion: 0,
        setName: it.setName, two: it.two, eff: fusedStats(it.st, it.s, 0), src: 'drop' })));
      bestiary = { drops: b.drops, boss: b.boss, zones: b.zones, count: add.length, at: b.at };
    }
    say('Bonus de panoplie (dofusdb)…');
    const setFx = await fetchSetBonuses([...new Set(pool.map((c) => c.setName).filter(Boolean))]);
    // Panoplies déjà vues sur ta fiche : paliers du jeu (exacts ; dofusdb est parfois décalé d'un palier selon la
    // panoplie). fx[n − 1] = bonus à n objets ; un nombre d'objets sans palier affiché garde le palier inférieur.
    let setsFromGame = 0;
    for (const [n, g] of Object.entries(cfg.setTiers || {})) {
      const counts = Object.keys(g.tiers || {}).map(Number).filter((c) => c >= 2).sort((a, b) => a - b);
      if (!counts.length) continue;
      const fx = [[]];
      for (let c = 2; c <= Math.max(g.max || 0, counts.at(-1)); c++) fx[c - 1] = g.tiers[counts.filter((x) => x <= c).at(-1)] || [];
      setFx[n] = fx;
      setsFromGame++;
    }
    // parchemins d'arène (stats fixes, sans prestige) et PO du Prestige (Vision spectrale) : ajoutés à chaque build
    const fixedStats = { ...Object.fromEntries(Object.entries(state.scrolls || {}).filter(([, v]) => +v)) };
    if (prestigePo(sheet.prestige)) fixedStats.po = (fixedStats.po || 0) + prestigePo(sheet.prestige);
    const fitSheet = { ...sheet, bonus: Object.fromEntries(Object.entries(sheet.bonus).map(([k, v]) => [k, v - (+state.scrolls?.[k] || 0)])) };
    gearMult = fitGearMult(pool.filter((c) => c.src === 'worn'), setFx, fitSheet, gearMult);
    DM.log(`optimiseur : panoplies — ${setsFromGame} connue(s) par la fiche du jeu, le reste via dofusdb ; parchemins ${JSON.stringify(fixedStats)}`);
    pool = pool.map((c, i) => ({ ...c, uid: i, eff: withPrestige(c.eff) }));
    const banned = new Set(Object.keys(buildBlacklist()).map(Number));
    const budget = opts.hdv && +opts.budget > 0 ? +opts.budget : 0;   // 0 = pas de limite

    // cible à résistances : chaque élément pèse (1 − % rés.) — les dégâts d'un élément étant linéaires en B et N,
    // réduire le profil du sort revient à appliquer la résistance à chaque coup
    const goal = BUILD_GOALS[opts.goal] || (opts.krala ? BUILD_GOALS.krala : BUILD_GOALS.dps);   // opts.krala : ancienne case à cocher
    const target = goal.target || null;
    const goalStat = goal.stat || null;
    const goalKeys = goalStat ? [goalStat, ...(goal.also || [])] : [];
    const vsTarget = (pf) => (!pf || !target ? pf
      : { ...pf, B: pf.B.map((b, el) => b * (1 - target.resPct[el] / 100)), N: pf.N.map((n, el) => n * (1 - target.resPct[el] / 100)) });
    const spells = sp.spells.filter((x) => !opts.deckOnly || sp.activeDeck.has(x.id))
      .map((x) => ({ ...x, pf: vsTarget(spellProfile(x.card)) })).filter((x) => x.pf);
    if (!spells.length) throw new Error(opts.deckOnly ? 'Aucun sort de dégâts dans ton deck actif' : 'Aucun sort de dégâts');
    // PA offensifs (option) : les PA du tour qui servent à taper, le reste allant aux buffs/shield. Vide = tous les PA.
    // Sorts conseillés (deckN) : affichage seulement, ne change pas les objets choisis.
    const paOff = Math.max(0, Math.min(12, Math.round(+opts.paOff || 0)));
    const deckN = Math.max(1, Math.min(8, +opts.deckN || 4));
    const pvMin = +opts.pvMin || 0;
    const paMin = +opts.paMin || 0;
    const slots = state.slots;

    // utile = stats offensives, PA/PO, vitalité si PV minimum, ou panoplie
    const useful = (c) => c.src === 'worn' || c.setName || OFFENSE_KEYS.some((k) => (c.eff[k] || 0) > 0)
      || (pvMin && ((c.eff.vitalite || 0) > 0 || (c.eff.pv || 0) > 0)) || goalKeys.some((k) => (c.eff[k] || 0) > 0);
    const cands = {};
    for (const s of slots) cands[s.accepts] ||= pool.filter((c) => c.type === s.accepts && useful(c) && !banned.has(c.id) && !(budget && c.price > budget));

    const statsOf = (build, base = sheet.base) => {
      const S = { ...base };
      for (const k in fixedStats) S[k] = (S[k] || 0) + fixedStats[k];
      const sets = {};
      for (const c of Object.values(build)) {
        if (!c) continue;
        for (const k in c.eff) S[k] = (S[k] || 0) + c.eff[k];
        if (c.setName) sets[c.setName] = (sets[c.setName] || 0) + 1;
      }
      const active = [];
      for (const [n, cnt] of Object.entries(sets)) {
        const tier = setTier(setFx[n], cnt);
        if (!tier?.length) continue;
        active.push({ name: n, count: cnt, tier });
        for (const { k, v } of tier) S[k] = (S[k] || 0) + (v > 0 && !PRESTIGE_EXCLUDED.has(k) ? Math.round(v * gearMult) : v);
      }
      return { S, active };
    };
    const paOf = buildPaOf(statLevel, sheet.prestige), pvOf = buildPvOf(statLevel);
    const turnOf = (S) => bestTurnPA(spells, S, paOff ? Math.min(paOff, paOf(S)) : paOf(S));
    // Gain de dégâts d'un point dans chaque stat d'élément, pour les sorts du tour `used` (formule linéaire par stat).
    const pointWeights = (used, S) => {
      const w = { force: 0, intelligence: 0, chance: 0, agilite: 0 };
      const pct = (1 + (S.dmgPctSorts || 0) / 100) * (1 + (S.po || 0) * SPECTRAL_PER_PO / 100);
      for (const { sp: x } of used) {
        const p = x.pf.cc > 0 ? Math.min(1, Math.max(0, (x.pf.cc + (S.critique || 0)) / 100)) : 0;
        for (let el = 0; el < 5; el++) w[EL_STAT[el]] += x.pf.B[el] * (1 + p * (CRIT_MULT - 1)) * pct / 100;
      }
      return w;
    };
    // Répartition des points (option « redistribuer ») : Vitalité pour le PV minimum, puis chaque point là où il rapporte
    // le plus de dégâts par point dépensé (paliers de coût compris) ; recalcul des sorts du tour jusqu'à stabilité.
    const allocate = (gear) => {
      const alloc = Object.fromEntries(POINT_STATS.map((k) => [k, 0]));
      const S0 = { ...gear };
      let R0 = planCapital;
      const buy = (S, al, k, R) => { const c = pointCost(sheet.tiers[k] || ELEM_POINT_TIERS, al[k]); if (c > R) return R; al[k]++; S[k] = (S[k] || 0) + 1; return R - c; };
      if (pvMin) while (pvOf(S0) < pvMin) { const r = buy(S0, alloc, 'vitalite', R0); if (r === R0) break; R0 = r; }
      if (goal.points) {   // objectif Sagesse, Prospection : tout le reste du capital dans la stat qui la donne
        let R = R0;
        for (;;) { const r = buy(S0, alloc, goal.points, R); if (r === R) break; R = r; }
        while (R > 0) { const r = buy(S0, alloc, 'vitalite', R); if (r === R) break; R = r; }
        return { S: S0, alloc, turn: turnOf(S0) };
      }
      let refS = S0, refTurn = turnOf(S0), best = null;
      for (let it = 0; it < 3; it++) {
        const w = pointWeights(refTurn.used, refS);
        const S = { ...S0 }, al = { ...alloc };
        let R = R0;
        if (OFF_POINT_STATS.some((k) => w[k] > 0)) {
          for (;;) {
            let pick = null, ratio = 0;
            for (const k of OFF_POINT_STATS) {
              const c = pointCost(sheet.tiers[k] || ELEM_POINT_TIERS, al[k]);
              if (w[k] > 0 && c <= R && w[k] / c > ratio) { ratio = w[k] / c; pick = k; }
            }
            if (!pick) break;
            R = buy(S, al, pick, R);
          }
        }
        while (R > 0) { const r = buy(S, al, 'vitalite', R); if (r === R) break; R = r; }   // reste → Vitalité
        const turn = turnOf(S);
        if (!best || turn.dmg > best.turn.dmg) best = { S, alloc: al, turn };
        const same = turn.used.map((u) => u.sp.id).sort().join() === refTurn.used.map((u) => u.sp.id).sort().join();
        if (same && it) break;
        refS = S; refTurn = turn;
      }
      return best;
    };
    // Évaluation d'un build : stats (avec points actuels ou redistribués) et meilleur tour.
    const evalBuild = (build, realloc = opts.realloc !== false) => {
      if (!realloc) {
        const st = statsOf(build);
        return { S: st.S, active: st.active, alloc: { ...sheet.base }, turn: turnOf(st.S) };
      }
      const st = statsOf(build, {});
      const a = allocate(st.S);
      return { S: a.S, active: st.active, alloc: a.alloc, turn: a.turn };
    };
    let evals = 0;
    const score = (build) => {
      evals++;
      const ev = evalBuild(build);
      const pv = pvOf(ev.S), pa = paOf(ev.S);
      // seuils non atteints : on remonte d'abord ce qui manque (1 PA manquant compte comme 1000 PV)
      const short = (pvMin ? Math.max(0, pvMin - pv) : 0) + (paMin ? 1000 * Math.max(0, paMin - pa) : 0);
      if (short) return -1e9 - short;
      // chaque PA vaut PA_VALUE_PCT % de l'objectif, même au-delà des PA offensifs (buffs, soins, cartes de classe…) :
      // un PA n'est plus échangé contre une broutille (ex. trophée PO = +0,4 % de dégâts par PO)
      // (objectif Dégâts sans PA offensifs fixés : chaque PA sert déjà à taper, pas de bonus en plus)
      const paMult = paOff ? (1 + PA_VALUE_PCT / 100) ** pa : 1;
      if (goalStat) {
        // Prospection / Sagesse : seule la stat visée compte (ni dégâts, ni PV, ni PA au-delà des minimums) ;
        // à stat égale, on garde ce que tu portes : un objet n'est changé que s'il en apporte plus
        const kept = slots.reduce((n, s) => n + (build[s.slot] === current[s.slot] ? 1 : 0), 0);
        return goal.value(ev.S) + kept * 1e-6;
      }
      return ev.turn.dmg * paMult + pv * 1e-4;   // à dégâts égaux, le plus de PV
    };
    // contraintes : un même objet (id) une seule fois ; arme à deux mains → pas de bouclier ; un exemplaire possédé par objet
    const costOf = (build) => Object.values(build).reduce((n, c) => n + (c?.src === 'hdv' ? c.price : 0), 0);
    const valid = (build) => {
      const ids = new Set();
      for (const c of Object.values(build)) { if (!c) continue; if (ids.has(c.id)) return false; ids.add(c.id); }
      if (budget && costOf(build) > budget) return false;   // achats HDV dans le budget
      return !(build.arme?.two && build.bouclier);
    };
    const current = Object.fromEntries(slots.map((s) => [s.slot, s.cur ? pool.find((c) => c.src === 'worn' && c.wornSlot === s.slot) : null]));
    // objet porté mis en liste noire : l'emplacement peut être vidé, et on part sans lui
    const canEmpty = (slot) => !current[slot] || slot === 'bouclier' || banned.has(current[slot].id);
    const startBuild = Object.fromEntries(Object.entries(current).map(([k, c]) => [k, c && banned.has(c.id) ? null : c]));

    // tirages pseudo-aléatoires à graine fixe : mêmes données (fiche, inventaire, HDV, bestiaire) → même build proposé
    let seed = 0x5eed1234;
    const rng = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const shuffled = (arr) => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      return a;
    };

    async function climb(start) {
      let build = { ...start }, best = score(build);
      for (let pass = 0; pass < 12; pass++) {
        let improved = false;
        for (const s of shuffled(slots)) {
          let pick = build[s.slot], pickScore = best;
          for (const c of [...cands[s.accepts], ...(canEmpty(s.slot) ? [null] : [])]) {
            if (c === build[s.slot]) continue;
            const b = { ...build, [s.slot]: c };
            if (c?.two && s.slot === 'arme') b.bouclier = null;
            if (!valid(b)) continue;
            const v = score(b);
            if (v > pickScore + 1e-6) { pick = c; pickScore = v; }
          }
          if (pick !== build[s.slot]) {
            build = { ...build, [s.slot]: pick };
            if (pick?.two && s.slot === 'arme') build.bouclier = null;
            best = pickScore; improved = true;
          }
          if (evals % 400 < 40) await sleep(0);
        }
        // panoplies : poser d'un coup 2, 3… objets d'une panoplie (le palier ne vient qu'à plusieurs, et passer de 2 à 3
        // ou 4 objets demande souvent de changer plusieurs emplacements à la fois). Objets ajoutés du plus utile seul
        // au moins utile ; chaque taille est essayée, la meilleure est gardée.
        for (const name of Object.keys(setFx)) {
          if (!setFx[name]) continue;
          const items = pool.filter((c) => c.setName === name && cands[c.type]?.includes(c));
          if (items.length < 2) continue;
          const place = (b, c) => {
            const free = slots.filter((s) => s.accepts === c.type && b[s.slot]?.setName !== name);
            if (!free.length) return false;
            // emplacement le moins utile du type (vide d'abord)
            const target = free.find((s) => !b[s.slot]) || free[0];
            b[target.slot] = c;
            if (c.two && target.slot === 'arme') b.bouclier = null;
            return true;
          };
          const solo = items.map((c) => { const b = { ...build }; return { c, v: place(b, c) && valid(b) ? score(b) : -Infinity }; })
            .sort((x, y) => y.v - x.v).map((x) => x.c);
          const b = { ...build };
          let n = 0;
          for (const c of solo) {
            if (!place(b, c)) continue;
            if (++n < 2 || !valid(b)) continue;
            const v = score(b);
            if (v > best + 1e-6) { build = { ...b }; best = v; improved = true; }
          }
        }
        if (!improved) break;
      }
      return { build, best };
    }

    say('Recherche du meilleur build…');
    let top = await climb(startBuild);
    const RESTARTS = 40;
    for (let r = 0; r < RESTARTS; r++) {
      say(`Recherche du meilleur build… (essai ${r + 2}/${RESTARTS + 1}, ${evals} builds testés)`);
      const start = { ...top.build };
      // perturbation : 2 à 5 emplacements tirés au sort
      for (const s of shuffled(slots).slice(0, 2 + (r % 4))) {
        const list = cands[s.accepts];
        if (list.length) start[s.slot] = list[Math.floor(rng() * list.length)];
      }
      if (!valid(start)) continue;
      const res = await climb(start);
      if (res.best > top.best + 1e-6) top = res;
    }

    // Finition : les PAIR_TOP meilleurs objets de chaque emplacement, essayés deux emplacements à la fois. Sort des
    // optimums qu'un changement à la fois ne quitte pas (2 objets d'une panoplie, PA déplacé d'un emplacement à l'autre…).
    const PAIR_TOP = 6;
    async function pairPolish(start) {
      let build = { ...start }, best = score(build), improved = false;
      const topOf = {};
      for (const s of slots) {
        topOf[s.slot] = [...cands[s.accepts], ...(canEmpty(s.slot) ? [null] : [])]
          .map((c) => { const b = { ...build, [s.slot]: c }; return { c, v: valid(b) ? score(b) : -Infinity }; })
          .sort((a, b) => b.v - a.v).slice(0, PAIR_TOP).map((x) => x.c);
        await sleep(0);
      }
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          const sa = slots[i].slot, sb = slots[j].slot;
          for (const ca of topOf[sa]) {
            for (const cb of topOf[sb]) {
              if (ca === build[sa] && cb === build[sb]) continue;
              const b = { ...build, [sa]: ca, [sb]: cb };
              if (!valid(b)) continue;
              const v = score(b);
              if (v > best + 1e-6) { build = b; best = v; improved = true; }
            }
          }
          if (evals % 400 < 40) await sleep(0);
        }
      }
      return { build, best, improved };
    }
    for (let round = 0; round < 4; round++) {
      say(`Finition : objets essayés deux par deux… (${evals} builds testés)`);
      const p = await pairPolish(top.build);
      if (!p.improved) break;
      const res = await climb(p.build);
      top = res.best > p.best + 1e-6 ? res : { build: p.build, best: p.best };
    }

    // Tolérance « mes objets » : un objet à acheter / looter est remplacé par un objet possédé (porté, inventaire, banque)
    // tant que le build reste à moins de ownTol % du meilleur trouvé. Remplacements les moins coûteux d'abord.
    const ownTol = Math.max(0, Math.min(50, +opts.ownTol || 0));
    const isOwned = (c) => !c || c.src === 'worn' || c.src === 'inv' || c.src === 'bank';
    let ownKept = 0, bestFound = top.best;
    if (ownTol > 0 && top.best > 0) {
      say('Préférence pour tes objets…');
      const floor = top.best * (1 - ownTol / 100);
      let b = { ...top.build }, v = top.best;
      for (;;) {
        let move = null;
        for (const s of slots) {
          if (isOwned(b[s.slot])) continue;
          for (const c of cands[s.accepts]) {
            if (!isOwned(c)) continue;
            const t = { ...b, [s.slot]: c };
            if (c.two && s.slot === 'arme') t.bouclier = null;
            if (!valid(t)) continue;
            const tv = score(t);
            if (tv >= floor && (!move || tv > move.v)) move = { t, v: tv };
          }
        }
        if (!move) break;
        b = move.t; v = move.v; ownKept++;
        await sleep(0);
      }
      if (ownKept) top = { build: b, best: v };
    }

    // anneaux / dofus : un objet déjà porté garde son emplacement (moins d'équipements à changer)
    const final = { ...top.build };
    for (const type of new Set(slots.map((s) => s.accepts))) {
      const group = slots.filter((s) => s.accepts === type);
      if (group.length < 2) continue;
      const items = group.map((s) => final[s.slot]).filter(Boolean);
      const place = {};
      for (const c of items) if (c.src === 'worn' && group.some((s) => s.slot === c.wornSlot)) place[c.wornSlot] = c;
      const rest = items.filter((c) => !Object.values(place).includes(c));
      for (const s of group) if (!place[s.slot]) place[s.slot] = rest.shift() || null;
      for (const s of group) final[s.slot] = place[s.slot];
    }
    // objets à looter retenus : où les obtenir, et sont-ils en vente à l'HDV ? (HDV non fouillé : emplacements concernés seulement)
    if (bestiary) {
      const drops = Object.values(final).filter((c) => c?.src === 'drop');
      for (const c of drops) { c.sources = bestiary.drops[c.id] || []; c.bossSources = bestiary.boss[c.id] || []; }
      const types = [...new Set(drops.map((c) => c.type))];
      if (types.length) {
        if (!opts.hdv) say('Objets à looter : recherche à l’HDV…');
        const offers = opts.hdv ? pool.filter((c) => c.src === 'hdv') : await fetchHdvGear(types, planLevel, hdvFailed);
        for (const c of drops) {
          const o = offers.filter((x) => x.id === c.id).sort((a, b) => a.price - b.price)[0];
          if (o) c.offer = { price: o.price, listingId: o.listingId, seller: o.seller, fusion: o.fusion };
        }
      }
    }
    // actuel : équipement et points tels quels ; proposé : nouvel équipement (+ points redistribués si l'option est active)
    const cur = evalBuild(current, false), nxt = evalBuild(final);
    const curTurn = cur.turn, nxtTurn = nxt.turn;
    // contrôle du modèle : stats calculées pour l'équipement actuel vs fiche du jeu
    const checks = [
      ['PV', buildPvOf(level)(cur.S), sheet.pv], ['PA', buildPaOf(level, sheet.prestige)(cur.S), sheet.pa],   // fiche = niveau actuel
      ...Object.keys(sheet.bonus).map((k) => [STAT_LABELS[k] || k, cur.S[k] || 0, (sheet.base[k] || 0) + sheet.bonus[k]]),
    ].filter(([, a, b]) => Number.isFinite(b));
    // deck conseillé : deckN sorts offensifs (ceux du tour d'abord, les plus forts ; complétés par les plus forts du build)
    const ranked = spells.filter((x) => x.usable).map((x) => ({ sp: x, v: profileAvg(x.pf, nxt.S) })).sort((a, b) => b.v - a.v);
    const deck = [...nxtTurn.used].sort((a, b) => b.v - a.v).map((u) => u.sp).slice(0, deckN);
    for (const { sp: x } of ranked) { if (deck.length >= deckN) break; if (!deck.includes(x)) deck.push(x); }
    // cartes non offensives déjà dans le deck 3 (buffs, soins…) : conservées, c'est toi qui les choisis
    const dmgIds = new Set(sp.spells.map((x) => x.id));
    const keepCards = sp.deckIds(DECK_TARGET).filter((id) => !dmgIds.has(id) && !deck.some((x) => x.id === id)).slice(0, DECK_CARDS - deck.length);
    return { gearMult, sheet, slots, current, final, cur, nxt, curTurn, nxtTurn, pvOf, paOf, checks, evals, paOff, deckN, planLevel, statLevel, planCapital, setFx, hdv: opts.hdv, target, goal, bestiary,
      ownTol, ownKept, ownLoss: ownKept && bestFound > 0 ? (1 - top.best / bestFound) * 100 : 0,
      pvMin, pvShort: pvMin && pvOf(nxt.S) < pvMin, paMin, paShort: paMin && paOf(nxt.S) < paMin, bank, budget, hdvFailed, realloc: opts.realloc !== false, cost: costOf(final), deck: deck.map((x) => ({ sp: x, v: profileAvg(x.pf, nxt.S) })),
      deckChunks: sp.chunks, keepCards };
  }

  async function openBuildOptimizer({ load = null } = {}) {
    document.querySelector('.dm-picker')?.remove();
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const ov = document.createElement('div');
    ov.className = 'dm-picker';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:#000a;display:grid;justify-items:center;align-items:start;padding:4vh 16px 16px;font:13px system-ui,sans-serif;color:#eee';
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => e.stopPropagation());
    let o = { deckN: 4, paOff: '', pvMin: '', deckOnly: false, hdv: false, realloc: true, dropsOnly: true };
    try { o = { ...o, ...JSON.parse(localStorage.getItem(BUILD_OPTS_KEY) || '{}') }; } catch { /* stockage indisponible */ }
    if (!BUILD_GOALS[o.goal]) o.goal = o.krala ? 'krala' : 'dps';   // ancienne case « Kralamoure »
    delete o.krala;
    const inp = 'background:#2a231a;border:1px solid #5a4a33;border-radius:8px;color:#eee;padding:5px 8px;font:13px system-ui,sans-serif';
    const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:6px 12px;color:#fff;cursor:pointer;font:600 13px system-ui,sans-serif;background:#2a231a';
    ov.innerHTML = `
      <div style="width:min(900px,100%);max-height:90vh;display:flex;flex-direction:column;gap:10px;background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:14px;box-shadow:0 10px 40px #000">
        <div style="display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:15px">🧬 Optimiseur de build${DM.tip("Cherche l’équipement qui maximise l’objectif choisi. Par défaut, tes dégâts sur un tour : le meilleur enchaînement de sorts de dégâts qui tient dans tes PA offensifs (tous tes PA si tu n’en fixes pas), sur une cible sans résistances. Prend en compte fusion, prestige, Bouclier de forge, bonus de panoplie (dofusdb) et PA gagnés par l’équipement. Les PV minimum évitent un build trop fragile.")}</b><button data-a="x" style="${btn};background:transparent">✕</button></div>
        <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center">
          <label data-tip="Ce que l’optimiseur maximise.&#10;Dégâts par tour : sur une cible sans résistances.&#10;Kralamoure : contre le boss de guilde, ses résistances (20 % Neutre, Terre, Feu et Air, 30 % Eau) appliquées à chaque coup ; le combat dure 10 tours, seul le total de dégâts compte.&#10;Prospection : celle de l’équipement et des panoplies + 1 par 10 de Chance ; avec « Redistribuer mes points », tous tes points vont en Chance.&#10;Sagesse : idem, points en Sagesse.&#10;Seule cette stat compte (les dégâts et PV n’entrent pas en jeu, utilise PV / PA minimum pour un plancher) ; à égalité, l’objet que tu portes déjà est gardé.">Objectif <select data-o="goal" style="${inp}">${Object.entries(BUILD_GOALS).map(([k, g]) => `<option value="${k}">${g.label}</option>`).join('')}</select></label>
          <label data-tip="Ne propose que des objets jusqu’à ce niveau. Au-dessus de ton niveau actuel, c’est une prévision : PV, PA de base et points de caractéristiques (5 par niveau) de ce niveau-là ; les objets trop hauts pour toi aujourd’hui ne sont pas équipés et les points ne sont pas appliqués. Vide = ton niveau actuel.">Niveau max <input data-o="lvlMax" type="number" min="1" max="200" placeholder="le mien" style="${inp};width:70px"></label>
          <label data-tip="PA de ton tour qui servent à taper ; le reste va à tes buffs, shields, soins… Les dégâts comptés sont ceux du meilleur enchaînement de sorts offensifs (autant de sorts que ces PA le permettent). Les PA au-delà gardent leur valeur (+3 % chacun). Vide = tous tes PA servent à taper.">PA offensifs <input data-o="paOff" type="number" min="1" max="12" placeholder="tous" style="${inp};width:70px"></label>
          <label data-tip="Affichage seulement : nombre de sorts offensifs conseillés pour ton deck avec le build proposé (bouton « Écrire dans le deck 3 »). Ne change pas les objets choisis.">Sorts conseillés <select data-o="deckN" style="${inp}">${[2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}">${n}</option>`).join('')}</select></label>
          <label>PV minimum <input data-o="pvMin" type="number" min="0" placeholder="aucun" style="${inp};width:90px"></label>
          <label data-tip="Le build garde au moins ce nombre de PA (base 6, 7 dès le niveau 100, + PA de l’équipement et des panoplies, 12 au maximum). Vide = sans contrainte. En objectif Dégâts avec des PA offensifs fixés, chaque PA au-delà compte quand même pour +3 % : il n’est pas sacrifié pour un petit bonus.">PA minimum <input data-o="paMin" type="number" min="0" max="12" placeholder="aucun" style="${inp};width:70px"></label>
          <label data-tip="Préférer tes objets (portés, inventaire, banque) à ceux qu’il faudrait acheter ou looter, tant que le build reste à moins de ce pourcentage du meilleur trouvé. Ex. 3 : un objet possédé qui fait perdre 2 % est gardé. Vide = le meilleur build, d’où que viennent les objets.">Tolérance mes objets <input data-o="ownTol" type="number" min="0" max="50" step="0.5" placeholder="0" style="${inp};width:60px"> %</label>
          <label style="cursor:pointer"><input data-o="deckOnly" type="checkbox"> Sorts du deck actif uniquement</label>
          <label style="cursor:pointer" data-tip="Considère tous tes points de caractéristiques comme redistribuables (comme après une réinitialisation) : l’optimiseur choisit en même temps l’équipement et la répartition. Décoché : tes points restent comme ils sont."><input data-o="realloc" type="checkbox"> Redistribuer mes points</label>
          <label style="cursor:pointer" data-tip="Ajoute les objets de ton autre compte (onglet ouvert en navigation privée ou normale), sauf ceux encore liés (reçus ou achetés il y a moins de 24 h). Un bouton les met dans la file d’échange de ce compte."><input data-o="bank" type="checkbox"> Inclure la banque (autre compte)</label>
          <label style="cursor:pointer" data-tip="Ajoute les objets en vente à l’HDV (jusqu’à 400 annonces par emplacement) : le build peut alors contenir des objets à acheter, avec leur prix."><input data-o="hdv" type="checkbox"> Fouiller l’HDV</label>
          <label style="cursor:pointer" data-tip="Ajoute tous les objets lootables du bestiaire (à ton niveau) que tu n’as pas : le build peut alors contenir des objets à aller chercher, avec les monstres qui les lâchent, leurs zones et tes chances. Pour ceux-là, l’HDV est vérifié : s’ils sont en vente, tu peux les acheter directement. Le bestiaire est importé une fois puis gardé en copie locale (rafraîchie chaque jour)."><input data-o="bestiary" type="checkbox"> Chercher dans le bestiaire</label>
          <label data-k="dropsOnlyBox" style="cursor:pointer" data-tip="Avec le bestiaire : seulement les objets qu’on obtient en chasse sur les monstres d’une zone — drop avec une chance connue, ou « objet bonus de victoire » propre à la zone (chance non publiée par le jeu). Pas ceux des seuls boss du Chemin ou de chasse. Tu peux aller les chercher (🐉 Aller dropper)."><input data-o="dropsOnly" type="checkbox"> Drops de monstres uniquement</label>
          <label data-k="budgetBox" data-tip="Total maximum des achats HDV du build proposé. Vide = pas de limite.">Budget <input data-o="budget" type="number" min="0" placeholder="illimité" style="${inp};width:110px"> K</label>
          <button data-a="go" style="${btn};background:#8a5a1a;margin-left:auto">Lancer</button>
        </div>
        <div data-k="saves" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px"></div>
        <div data-k="msg" style="font-size:12px;color:#b9a98c;min-height:1em"></div>
        <details data-k="bl" style="font-size:12px"><summary style="cursor:pointer;color:#b9a98c"></summary><div data-k="blList" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px"></div></details>
        <div data-k="out" style="overflow-y:auto;display:flex;flex-direction:column;gap:10px"></div>
      </div>`;
    document.body.appendChild(ov);
    const $ = (q) => ov.querySelector(q);
    for (const el of ov.querySelectorAll('[data-o]')) {
      if (el.type === 'checkbox') el.checked = !!o[el.dataset.o]; else el.value = o[el.dataset.o] ?? '';
      el.addEventListener('change', () => {
        o[el.dataset.o] = el.type === 'checkbox' ? el.checked : el.value;
        try { localStorage.setItem(BUILD_OPTS_KEY, JSON.stringify(o)); } catch { /* idem */ }
        syncOpts();
      });
    }
    const syncOpts = () => { $('[data-k="budgetBox"]').style.display = o.hdv ? '' : 'none'; $('[data-k="dropsOnlyBox"]').style.display = o.bestiary ? '' : 'none'; };
    syncOpts();
    // liste noire : visible et modifiable ici
    const renderBl = () => {
      const bl = buildBlacklist(), n = Object.keys(bl).length;
      $('[data-k="bl"]').style.display = n ? '' : 'none';
      $('[data-k="bl"] summary').textContent = `🚫 Liste noire (${n}) — objets jamais proposés`;
      $('[data-k="blList"]').innerHTML = Object.entries(bl).map(([id, name]) =>
        `<span style="background:#2a231a;border:1px solid #5a4a33;border-radius:6px;padding:2px 6px">${esc(name)} <button data-unban="${esc(id)}" title="Retirer de la liste noire" style="background:none;border:0;color:#ff7b6b;cursor:pointer">✕</button></span>`).join('');
    };
    renderBl();
    let armed = null, armTimer = null;   // bouton d'achat en attente de confirmation
    const disarm = () => { armed = null; clearTimeout(armTimer); };
    const say = (t, err) => { $('[data-k="msg"]').textContent = t; $('[data-k="msg"]').style.color = err ? '#ff7b6b' : '#b9a98c'; };
    let result = null, running = false, loaded = null;   // loaded : build enregistré affiché ({ name, at, who })
    const renderSaves = () => {
      const list = buildSaves();
      const box = $('[data-k="saves"]');
      box.style.display = list.length ? '' : 'none';
      box.innerHTML = `<span style="color:#b9a98c">💾 Builds enregistrés</span>
        <select data-k="saveSel" style="${inp};max-width:360px">${list.map((x) => `<option value="${esc(x.id)}">${esc(x.name)} — ${esc(x.who || '?')}, ${new Date(x.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</option>`).join('')}</select>
        <button data-a="loadSave" style="${btn}">📂 Ouvrir</button><button data-a="delSave" style="${btn}" title="Supprimer ce build enregistré (2e clic pour confirmer)">🗑</button>`;
    };
    const openSave = (id) => {
      const x = buildSaves().find((b) => b.id === id);
      if (!x) return;
      disarm();
      result = unpackBuild(x.data);
      loaded = { name: x.name, at: x.at, who: x.who };
      render();
      say(`📂 Build « ${x.name} » enregistré le ${new Date(x.at).toLocaleString('fr-FR')} : photo de ce moment-là (HDV, inventaire et points ont pu changer depuis).`);
    };
    renderSaves();
    ov.addEventListener('click', async (e) => {
      if (e.target.closest('[data-a="x"]')) return close();
      if (e.target.closest('[data-a="saveBuild"]') && result) {
        const name = ($('[data-k="saveName"]')?.value || '').trim() || 'Build sans nom';
        let entry;
        try {
          entry = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, who: myName() || '', at: Date.now(), data: packBuild(result) };
          await save({ buildSaves: [entry, ...buildSaves()].slice(0, BUILD_SAVES_MAX) });
        } catch (err) {
          say(`❌ Enregistrement impossible : ${err.message}`, true);
          return;
        }
        loaded = { name, at: entry.at, who: entry.who };
        renderSaves();
        render();
        say(`💾 Build « ${name} » enregistré : rouvre-le ici ou depuis la bulle ❤️, sans relancer la recherche.`);
        return;
      }
      if (e.target.closest('[data-a="loadSave"]')) return openSave($('[data-k="saveSel"]').value);
      const del = e.target.closest('[data-a="delSave"]');
      if (del) {
        if (armed !== del) {
          disarm();
          armed = del;
          del.textContent = '⚠️ Supprimer ?';
          armTimer = setTimeout(() => { if (armed === del) { del.textContent = '🗑'; disarm(); } }, 5000);
          return;
        }
        disarm();
        await save({ buildSaves: buildSaves().filter((b) => b.id !== $('[data-k="saveSel"]').value) });
        renderSaves();
        say('Build enregistré supprimé.');
        return;
      }
      const fav = e.target.closest('[data-fav]');
      if (fav && result) {
        const [slot, side] = fav.dataset.fav.split('|');
        const c = side === 'cur' ? result.current[slot] : result.final[slot];
        if (c) { await toggleFav(c); render(); }
        return;
      }
      const unban = e.target.closest('[data-unban]');
      if (unban) {
        const bl = { ...buildBlacklist() };
        delete bl[unban.dataset.unban];
        await save({ buildBlacklist: bl });
        renderBl();
        say('Objet retiré de la liste noire : relance la recherche pour en tenir compte.');
        return;
      }
      const ban = e.target.closest('[data-ban]');
      if (ban) {
        await save({ buildBlacklist: { ...buildBlacklist(), [ban.dataset.ban]: ban.dataset.name } });
        renderBl();
        ban.closest('td').style.textDecoration = 'line-through';
        ban.remove();
        say(`🚫 ${ban.dataset.name} en liste noire — clique « Lancer » pour une nouvelle recherche sans lui.`);
        return;
      }
      const bq = e.target.closest('[data-bankq]');
      if (bq && result) {
        const c = Object.values(result.final).find((x) => x?.src === 'bank' && String(x.uid) === bq.dataset.bankq);
        if (!c) return;
        const queues = { ...(cfg.tradeQueues || {}) };
        const q = (queues[c.bankName] || []).map((x) => ({ ...x }));
        const it = { name: c.name, lvl: c.lvl, fusion: c.fusion || 0 };
        const cur = q.find((x) => sameItem(x, it));
        if (!cur) q.push({ ...it, qty: 1 });   // un seul exemplaire suffit pour l'équiper
        queues[c.bankName] = q;
        await save({ tradeQueues: queues });
        c.queued = true;
        render();
        say(`📦 ${c.name} ajouté à la file d’échange de ${c.bankName} : va sur son onglet et lance « Tout échanger ».`);
        return;
      }
      const buy = e.target.closest('[data-buy]');
      if (buy && result && !buy.disabled) {
        const c = Object.values(result.final).find((x) => (x?.src === 'hdv' && String(x.listingId) === buy.dataset.buy)
          || (x?.src === 'drop' && String(x.offer?.listingId) === buy.dataset.buy));
        if (!c) return;
        const price = c.src === 'drop' ? c.offer.price : c.price, listingId = c.src === 'drop' ? c.offer.listingId : c.listingId;
        if (armed !== buy) {   // 1er clic : confirmation
          disarm();
          armed = buy;
          buy.textContent = `⚠️ Confirmer ${fmt(price)} K`;
          armTimer = setTimeout(() => { if (armed === buy) { buy.textContent = '🛒 Acheter'; disarm(); } }, 6000);
          return;
        }
        disarm();
        buy.disabled = true;
        buy.textContent = 'Achat…';
        try {
          await hdvCall('buyListing', [listingId]);
          Object.assign(c, { src: 'inv', bought: true });   // possédé : « Équiper ce build » le prendra
          DM.log(`optimiseur : achat HDV ${c.name} (${price} K, annonce ${listingId})`);
          render();
        } catch (err) {
          buy.disabled = false;
          buy.textContent = `❌ ${err.message}`;
        }
        return;
      }
      const pt = e.target.closest('[data-a="points"]');
      if (pt && result && !pt.disabled) {
        if (armed !== pt) {
          disarm();
          armed = pt;
          pt.textContent = '⚠️ Confirmer : réinitialiser et répartir';
          armTimer = setTimeout(() => { if (armed === pt) { pt.textContent = '📊 Appliquer cette répartition'; disarm(); } }, 6000);
          return;
        }
        disarm();
        pt.disabled = true;
        try {
          const base = await applyPoints(result.nxt.alloc, result.sheet.base, (m) => { pt.textContent = m; });
          result.sheet.base = base;   // la fiche suit : l'écran « actuel » reflète les nouveaux points
          pt.textContent = '✔ Points répartis';
          say('✔ Points de caractéristiques répartis.');
        } catch (err) {
          pt.disabled = false;
          pt.textContent = `🔁 Réessayer — ❌ ${err.message}`;
        }
        return;
      }
      const dk = e.target.closest('[data-a="deck"]');
      if (dk && result && !dk.disabled) {
        if (armed !== dk) {
          disarm();
          armed = dk;
          dk.textContent = '⚠️ Confirmer : écraser le deck 3';
          armTimer = setTimeout(() => { if (armed === dk) { dk.textContent = '🃏 Écrire dans le deck 3'; disarm(); } }, 6000);
          return;
        }
        disarm();
        dk.disabled = true;
        try {
          if (!saveDeckId) saveDeckId = await findAction(result.deckChunks || [], 'saveDeck', SAVE_DECK_FALLBACK);
          await callAction('deck', saveDeckId, [[...result.deck.map((d) => ({ id: d.sp.id, f: 0 })), ...result.keepCards.map((id) => ({ id, f: 0 }))], DECK_TARGET]);
          dk.textContent = '✔ Deck 3 enregistré (choisis-le sur /deck pour l’emmener en combat)';
        } catch (err) {
          if (!err.game) saveDeckId = null;
          dk.disabled = false;
          dk.textContent = `❌ ${err.message}`;
        }
        return;
      }
      if (e.target.closest('[data-a="copyDeck"]') && result) {
        const b = e.target.closest('[data-a="copyDeck"]');
        try { await navigator.clipboard.writeText(result.deck.map((d, i) => `${i + 1}. ${d.sp.name} (${d.sp.ap} PA, ~${Math.round(d.v)})`).join('\n')); b.textContent = '✔ Copié'; } catch { b.textContent = '❌ Copie impossible'; }
        return;
      }
      if (e.target.closest('[data-a="go"]') && !running) {
        running = true;
        $('[data-a="go"]').disabled = true;
        $('[data-k="out"]').innerHTML = '';
        try {
          const t0 = Date.now();
          fetchFlight.onRetry = (m) => say(`⏳ ${m}`);
          result = await optimizeBuild(o, say);
          loaded = null;
          say(`Terminé : ${result.evals} builds testés en ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
          render();
          rememberBuild(result);
        } catch (err) {
          say(`❌ ${err.message || err}`, true);
        } finally {
          fetchFlight.onRetry = null;
          running = false;
          $('[data-a="go"]').disabled = false;
        }
      }
      if (e.target.closest('[data-a="dropFarm"]') && result) return openDropFarm(result);
      const eq = e.target.closest('[data-a="equip"]');
      if (eq && result && !eq.disabled) {
        const changes = result.slots.map((s) => ({ s, to: result.final[s.slot], from: result.current[s.slot] }))
          .filter(({ to, from }) => to && !['hdv', 'bank', 'drop'].includes(to.src) && to !== from && !(to.lvl > result.sheet.level))
          .map(({ s, to, from }) => ({ slot: s.slot, label: s.label, from, to }))
          .sort((a, b) => (a.slot === 'arme' ? -1 : b.slot === 'arme' ? 1 : 0));
        // déjà équipés lors d'un essai précédent (interrompu par une erreur) : on ne les refait pas
        result.equipped ||= {};
        const todo = changes.filter((c) => result.equipped[c.slot] !== c.to);
        if (!todo.length) return;
        eq.disabled = true;
        try {
          await runEquip({ changes: todo, stats: [] }, null, (i, n, c) => {
            result.equipped[c.slot] = c.to;
            eq.textContent = `Équipement ${i}/${n} : ${c.to.name}…`;
          });
          // build optimisé en place : l'auto-équipement (fait pour l'XP) ne doit pas le défaire
          const wasAuto = (cfg.equipAuto || 'off') !== 'off';
          if (wasAuto) await save({ equipAuto: 'off' });
          eq.textContent = `✔ Build équipé${wasAuto ? ' — auto-équipement passé sur Off' : ''}`;
        } catch (err) {
          const left = changes.filter((c) => result.equipped[c.slot] !== c.to).length;
          eq.disabled = false;   // on peut recliquer : seuls les objets restants seront équipés
          eq.textContent = `🔁 Réessayer (${left} restant${left > 1 ? 's' : ''}) — ❌ ${err.message}`;
        }
      }
    });

    const fmt = (n) => Math.round(n).toLocaleString('fr-FR');
    // Survol d'un objet : ses stats (prestige compris) et l'écart avec l'objet de l'autre colonne du même emplacement.
    const hover = document.createElement('div');
    hover.style.cssText = 'position:fixed;z-index:2147483647;max-width:300px;padding:8px 10px;border-radius:8px;background:#0f1114;border:1px solid #5a4a33;box-shadow:0 4px 14px #000a;font:12px/1.45 system-ui,sans-serif;color:#e8e6e1;pointer-events:none;display:none';
    ov.appendChild(hover);
    const statIdxOf = (k) => { const i = STAT_ORDER.indexOf(k); return i < 0 ? 999 : i; };
    const statLine = (k, v, signed) => `<div style="color:${signed ? (v > 0 ? '#6fcf7a' : '#ff7b6b') : v < 0 ? '#ff7b6b' : 'inherit'}">${v > 0 ? '+' : ''}${fmt(v)} ${esc(STAT_LABELS[k] || k)}</div>`;
    ov.addEventListener('mouseover', (e) => {
      const el = e.target.closest('[data-hover]');
      if (!el || !result) { hover.style.display = 'none'; return; }
      const [slot, side] = el.dataset.hover.split('|');
      const c = side === 'cur' ? result.current[slot] : result.final[slot];
      const other = side === 'cur' ? result.final[slot] : result.current[slot];
      if (!c) { hover.style.display = 'none'; return; }
      const keys = (o) => Object.keys(o || {}).filter((k) => o[k]).sort((a, b) => statIdxOf(a) - statIdxOf(b));
      const diffKeys = [...new Set([...keys(c.eff), ...keys(other?.eff)])].sort((a, b) => statIdxOf(a) - statIdxOf(b))
        .filter((k) => (c.eff[k] || 0) !== (other?.eff?.[k] || 0));
      hover.innerHTML = `<div style="font-weight:800">${esc(itemLabel(c))}</div>
        <div style="color:#8a7d66;font-size:11px">Niveau ${c.lvl ?? '?'}${c.setName ? ` · ${esc(c.setName)}` : ''}${c.src === 'hdv' ? ` · HDV ${fmt(c.price)} K (${esc(c.seller)})` : c.src === 'worn' ? ' · porté' : c.src === 'bank' ? ` · banque (${esc(c.bankName)})` : c.src === 'drop' ? ' · à looter (bestiaire)' : ' · inventaire'}${c.two ? ' · deux mains' : ''}</div>
        <div style="margin-top:4px">${keys(c.eff).map((k) => statLine(k, c.eff[k])).join('') || '<i>aucune stat</i>'}</div>
        ${other !== c ? `<div style="margin-top:6px;border-top:1px solid #3a3024;padding-top:4px;color:#b9a98c">${side === 'new' ? `Par rapport à ${other ? esc(itemLabel(other)) : 'l’emplacement vide'}` : `En passant à ${other ? esc(itemLabel(other)) : 'vide'}`} :</div>
          ${diffKeys.map((k) => statLine(k, side === 'new' ? (c.eff[k] || 0) - (other?.eff?.[k] || 0) : (other?.eff?.[k] || 0) - (c.eff[k] || 0), true)).join('') || '<i>aucun écart</i>'}
          <div style="color:#8a7d66;font-size:11px;margin-top:3px">Hors bonus de panoplie (voir la ligne « Panoplies »).</div>` : ''}`;
      hover.style.display = 'block';
      const rc = el.getBoundingClientRect(), w = hover.offsetWidth, h = hover.offsetHeight;
      hover.style.left = `${Math.max(6, Math.min(rc.left, innerWidth - w - 6))}px`;
      hover.style.top = `${rc.bottom + h + 8 > innerHeight ? Math.max(6, rc.top - h - 6) : rc.bottom + 6}px`;
    });
    ov.addEventListener('mouseout', (e) => { if (!e.relatedTarget?.closest?.('[data-hover]')) hover.style.display = 'none'; });
    function render() {
      const r = result;
      const gain = r.nxtTurn.dmg - r.curTurn.dmg;
      const gs = r.goal.stat, gA = gs ? r.goal.value(r.cur.S) : 0, gB = gs ? r.goal.value(r.nxt.S) : 0;
      const heart = (c, slot, side) => `<button data-fav="${esc(slot)}|${side}" title="${buildFavs()[c.id] ? 'Retirer des favoris' : 'Ajouter aux favoris (bulle ❤️ en bas à gauche)'}" style="background:none;border:0;cursor:pointer;padding:0 2px;font-size:13px;color:${buildFavs()[c.id] ? '#ff5c7a' : '#8a7d66'}">${buildFavs()[c.id] ? '❤' : '♡'}</button>`;
      const item = (c, slot, side) => (c ? `${heart(c, slot, side)}<span data-hover="${esc(slot)}|${side}" style="cursor:help">${c.icon ? `<img src="/img/items/${+c.icon}.png" alt="" style="width:26px;height:26px;object-fit:contain;vertical-align:middle">` : ''} ${esc(itemLabel(c))}${c.src === 'hdv' ? ` <span style="color:#f0c04a">🛒 ${fmt(c.price)} K</span>` : ''}${c.src === 'bank' ? ` <span style="color:#8fb8ee">🏦 ${esc(c.bankName)}</span>` : ''}${c.src === 'drop' ? ` <span style="color:#c99bff">🐉 à looter</span>${c.offer ? ` <span style="color:#f0c04a">· en vente ${fmt(c.offer.price)} K${c.offer.fusion ? ` (fusion ${c.offer.fusion})` : ''}</span>` : ''}` : ''}${c.bought ? ' <span style="color:#6fcf7a">✔ acheté</span>' : ''}</span>` : '<i style="color:#8a7d66">vide</i>');
      const sbtn = 'border:1px solid #5a4a33;border-radius:6px;padding:2px 7px;color:#fff;cursor:pointer;font:600 11px system-ui,sans-serif;background:#2a231a;margin-left:4px';
      const tools = (c) => (!c ? '' : `${c.src === 'bank' ? (c.queued ? '<span style="color:#6fcf7a;margin-left:4px">✔ en file d’échange</span>' : `<button data-bankq="${esc(c.uid)}" style="${sbtn};background:#2e6fbf" title="Ajoute cet objet à la file d’échange de ${esc(c.bankName)} : lance « Tout échanger » depuis son onglet, puis équipe-le">📦 File d’échange</button>`) : ''}${c.src === 'drop' && c.offer ? `<button data-buy="${esc(c.offer.listingId)}" style="${sbtn};background:#8a5a1a" title="Acheter cette annonce (vendeur : ${esc(c.offer.seller)}) — 2e clic pour confirmer">🛒 Acheter</button>` : ''}${c.src === 'hdv' ? `<button data-buy="${esc(c.listingId)}" style="${sbtn};background:#8a5a1a" title="Acheter cette annonce (vendeur : ${esc(c.seller)}) — 2e clic pour confirmer">🛒 Acheter</button>` : ''}<button data-ban="${+c.id}" data-name="${esc(c.name)}" style="${sbtn}" title="Mettre en liste noire : ne plus jamais proposer cet objet">🚫</button>`);
      // monstres qui lâchent un objet à looter : les 3 meilleures chances (prospection comprise), niveaux et zones
      const pctTxt = (x) => `${(x >= 1 ? x.toFixed(1) : x.toFixed(2)).replace('.', ',')} %`;
      // (taux 0 dans le bestiaire = « objet bonus de victoire » ; Boss du Chemin d'abord, ~90 %)
      const srcLine = (c) => {
        const lines = [
          ...(c.bossSources || []).slice(0, 2).map(([n, lvl, step, p, z, done]) => `👑 ${esc(n)} (Boss du Chemin, étape ${step}${done ? ', vaincu' : ''}, niv. ${lvl}) : ${p ? pctTxt(p) : '?'} — ${esc(z)}`),
          ...(c.sources || []).slice(0, 3).map(([n, lo, hi, p, z]) => `${esc(n)} (niv. ${lo === hi ? lo : `${lo}–${hi}`}) : ${p ? pctTxt(p) : 'objet bonus de victoire'} — ${esc(z.map((id) => r.bestiary.zones[id]?.[0] || `zone ${id}`).join(', ') || 'zone inconnue')}`),
        ];
        const more = Math.max(0, (c.bossSources || []).length - 2) + Math.max(0, (c.sources || []).length - 3);
        return `<div style="font-weight:400;font-size:11px;color:#b9a98c">${lines.join('<br>') || 'Ni monstre ni boss du bestiaire ne le lâche (coffres, objet bonus…).'}${more ? `<br>+ ${more} autre(s) source(s)` : ''}</div>`;
      };
      const drops = Object.values(r.final).filter((c) => c?.src === 'drop');
      const rows = r.slots.map((s) => {
        const a = r.current[s.slot], b = r.final[s.slot];
        const same = a === b || (a && b && a.id === b.id && a.fusion === b.fusion);
        return `<tr style="border-top:1px solid #3a3024;${same ? 'color:#8a7d66' : ''}"><td style="padding:3px 6px">${esc(s.label)}</td><td>${item(a, s.slot, 'cur')}</td><td>${same ? '=' : '→'}</td><td style="${same ? '' : 'font-weight:700'}">${item(b, s.slot, 'new')}${same ? '' : tools(b)}${!same && b?.src === 'drop' ? srcLine(b) : ''}</td></tr>`;
      }).join('');
      const turn = (t) => t.used.map((u) => `${esc(u.sp.name)} (${u.sp.ap} PA, ${fmt(u.v)})`).join(' + ') || '—';
      const keys = [...new Set(['pa', 'pv', ...(gs ? [gs, ...(r.goal.also || [])] : []), ...OFFENSE_KEYS.filter((k) => k !== 'pa'), 'vitalite'])];
      const statRows = keys.map((k) => {
        const a = k === 'pa' ? r.paOf(r.cur.S) : k === 'pv' ? r.pvOf(r.cur.S) : r.cur.S[k] || 0;
        const b = k === 'pa' ? r.paOf(r.nxt.S) : k === 'pv' ? r.pvOf(r.nxt.S) : r.nxt.S[k] || 0;
        if (!a && !b) return '';
        const d = b - a;
        return `<span style="white-space:nowrap">${esc(k === 'pv' ? 'PV' : k === 'pa' ? 'PA' : STAT_LABELS[k] || k)} ${fmt(a)} → <b>${fmt(b)}</b>${d ? ` <span style="color:${d > 0 ? '#6fcf7a' : '#ff7b6b'}">(${d > 0 ? '+' : ''}${fmt(d)})</span>` : ''}</span>`;
      }).filter(Boolean).join(' · ');
      const sets = (st) => st.active.map((a) => `${esc(a.name)} (${a.count})`).join(', ') || 'aucune';
      const hdvCost = Object.values(r.final).filter((c) => c?.src === 'hdv').reduce((n, c) => n + c.price, 0);
      const deckHtml = r.deck.map((d, i) => `<span style="white-space:nowrap">${i + 1}. ${esc(d.sp.name)} <span style="color:#8a7d66">(${d.sp.ap} PA, ~${fmt(d.v)})</span></span>`).join(' · ');
      const badChecks = r.checks.filter(([, a, b]) => Math.abs(a - b) > Math.max(2, Math.abs(b) * 0.02));
      const owned = r.slots.some((s) => r.final[s.slot] && !['hdv', 'bank', 'drop'].includes(r.final[s.slot].src) && r.final[s.slot] !== r.current[s.slot] && !(r.final[s.slot].lvl > r.sheet.level));
      const ahead = (r.statLevel || r.sheet.level) > r.sheet.level;   // prévision à un niveau pas encore atteint
      $('[data-k="out"]').innerHTML = `
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:baseline">
          ${gs ? `<div>${esc(STAT_LABELS[gs] || gs)}${r.goal.also ? ' (Chance comprise)' : ''} : <b>${fmt(gA)}</b> → <b style="font-size:17px;color:#6fcf7a">${fmt(gB)}</b> ${gB - gA > 0 ? `<span style="color:#6fcf7a">(+${fmt(gB - gA)})</span>` : '<span style="color:#b9a98c">(ton build est déjà le meilleur trouvé)</span>'}</div>
          <div style="font-size:12px">Dégâts par tour : ${fmt(r.curTurn.dmg)} → <b>${fmt(r.nxtTurn.dmg)}</b>${gain ? ` <span style="color:${gain > 0 ? '#6fcf7a' : '#ff7b6b'}">(${gain > 0 ? '+' : ''}${fmt(gain)})</span>` : ''}</div>`
    : `<div>Dégâts par tour${r.target ? ` sur ${esc(r.target.name)} (résistances comprises)` : ''} : <b>${fmt(r.curTurn.dmg)}</b> → <b style="font-size:17px;color:#6fcf7a">${fmt(r.nxtTurn.dmg)}</b> ${gain > 0.5 ? `<span style="color:#6fcf7a">(+${fmt(gain)}, +${(gain / Math.max(1, r.curTurn.dmg) * 100).toFixed(1)} %)</span>` : '<span style="color:#b9a98c">(ton build est déjà le meilleur trouvé)</span>'}</div>`}
          ${hdvCost ? `<div style="color:#f0c04a">🛒 Achats HDV restants : ${fmt(hdvCost)} K${r.budget ? ` / budget ${fmt(r.budget)} K` : ''}</div>` : r.budget ? `<div style="color:#b9a98c">Budget ${fmt(r.budget)} K : aucun achat nécessaire</div>` : ''}
        </div>
        ${r.planLevel && r.planLevel !== r.sheet.level ? `<div style="font-size:12px;color:#8fd4ee">📅 ${ahead ? `Prévision au niveau ${r.planLevel} (tu es niveau ${r.sheet.level}) : objets jusqu’au niveau ${r.planLevel}, PV, PA et ${fmt(r.planCapital)} points de caractéristiques de ce niveau. Les objets au-dessus de ton niveau actuel ne seront pas équipés.` : `Objets limités au niveau ${r.planLevel} (tu es niveau ${r.sheet.level}).`}</div>` : ''}
        ${r.bestiary ? `<div style="font-size:12px;color:#c99bff">🐉 Bestiaire : ${r.bestiary.count} objet(s) lootable(s) à ton niveau que tu n’as pas, pris en compte (copie du ${new Date(r.bestiary.at).toLocaleString('fr-FR')})${drops.length ? ` — ${drops.length} à looter dans le build proposé${drops.some((c) => c.offer) ? `, dont ${drops.filter((c) => c.offer).length} en vente à l’HDV` : ''}` : ''}.</div>` : ''}
        ${r.bank ? `<div style="font-size:12px;color:#8fb8ee">🏦 Banque ${esc(r.bank.name)} : ${r.bank.count} objet(s) disponible(s)${r.bank.bound ? `, ${r.bank.bound} lié(s) ignoré(s)` : ''}.</div>` : ''}
        ${r.ownKept ? `<div style="font-size:12px;color:#6fcf7a">🎒 Tolérance ${String(r.ownTol).replace('.', ',')} % : ${r.ownKept} objet(s) à acheter ou looter remplacé(s) par des objets que tu as (−${r.ownLoss.toFixed(1).replace('.', ',')} % par rapport au meilleur build trouvé).</div>` : ''}
        ${r.paShort ? `<div style="color:#ff7b6b;font-weight:700">⚠️ PA minimum (${r.paMin}) impossible à atteindre avec tes objets : le build ci-dessous est celui qui a le plus de PA (${r.paOf(r.nxt.S)}).</div>` : ''}
        ${r.hdvFailed.length ? `<div style="color:#f0a040">⚠️ HDV illisible pour : ${r.hdvFailed.map((t) => esc(SLOT_NAMES[t] || t)).join(', ')} (site saturé) — ces emplacements n’ont pas d’objet HDV proposé.</div>` : ''}
        ${r.pvShort ? `<div style="color:#ff7b6b;font-weight:700">⚠️ PV minimum (${fmt(r.pvMin)}) impossible à atteindre avec tes objets : le build ci-dessous est celui qui a le plus de PV (${fmt(r.pvOf(r.nxt.S))}).</div>` : ''}
        <div style="font-size:12px"><b>Sorts du tour</b>${r.paOff ? ` (${r.paOff} PA offensifs)` : ''} — actuel : ${turn(r.curTurn)}<br><b style="color:#6fcf7a">proposé</b> : ${turn(r.nxtTurn)}</div>
        <table style="border-collapse:collapse;width:100%;font-size:12px"><tr style="color:#b9a98c;text-align:left"><th style="padding:3px 6px">Emplacement</th><th>Actuel</th><th></th><th>Proposé</th></tr>${rows}</table>
        <div style="font-size:12px"><b>Panoplies</b> — actuel : ${sets(r.cur)} · proposé : ${sets(r.nxt)}</div>
        ${r.realloc ? `<div style="font-size:12px;background:#241e16;border:1px solid #3a3024;border-radius:8px;padding:6px 8px">
          <b>📊 Points de caractéristiques</b> — ${fmt(r.planCapital ?? r.sheet.capital)} points au total${ahead ? ` au niveau ${r.statLevel} (${fmt(r.sheet.capital)} aujourd’hui)` : ` (${fmt(r.sheet.pointsFree)} libres actuellement)`}<br>
          ${POINT_STATS.map((k) => { const a = r.sheet.base[k] || 0, b = r.nxt.alloc[k] || 0; return `<span style="white-space:nowrap;${a === b ? 'color:#8a7d66' : ''}">${esc(STAT_LABELS[k] || k)} ${fmt(a)} → <b>${fmt(b)}</b></span>`; }).join(' · ')}
          <div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            ${ahead ? `<span style="color:#8fd4ee">📅 Répartition du niveau ${r.statLevel} : à appliquer une fois ce niveau atteint (relance alors la recherche).</span>`
              : POINT_STATS.every((k) => (r.sheet.base[k] || 0) === (r.nxt.alloc[k] || 0)) ? '<span style="color:#6fcf7a">✔ Tes points sont déjà répartis ainsi.</span>'
              : `<button data-a="points" style="${btn};background:#2e6fbf" title="Réinitialise tes points si une stat doit baisser, puis les répartit comme indiqué (2e clic pour confirmer)">📊 Appliquer cette répartition</button>`}
            <span style="color:#8a7d66;font-size:11px">L’équipement, lui, s’équipe avec le bouton plus bas.</span></div></div>` : ''}
        <div style="font-size:12px;background:#241e16;border:1px solid #3a3024;border-radius:8px;padding:6px 8px">
          <b>🃏 Sorts offensifs conseillés (${r.deck.length})</b> :<br>${deckHtml}
          <div style="color:#8a7d66;font-size:11px;margin-top:2px">« Écrire dans le deck 3 » remplace les sorts de dégâts du deck 3 par ceux-ci ; ses autres cartes (buffs, soins…${r.keepCards.length ? `, ${r.keepCards.length} carte(s) actuellement` : ''}) sont conservées.</div>
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
            <button data-a="deck" style="${btn};background:#2e6fbf" title="Remplace les sorts de dégâts de ton deck 3 par ceux-ci, en gardant ses autres cartes (2e clic pour confirmer)">🃏 Écrire dans le deck 3</button>
            <button data-a="copyDeck" style="${btn}">📋 Copier la liste</button>
          </div>
        </div>
        <div style="font-size:12px;line-height:1.6">${statRows}</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px">
          ${loaded ? `<span style="color:#8fb8ee">📂 « ${esc(loaded.name)} » (${esc(loaded.who || '?')}, ${new Date(loaded.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })})</span>`
            : `<input data-k="saveName" maxlength="60" value="${esc(`${r.goal.label.replace(/^\S+\s/, '')} — ${fmt(r.goal.stat ? r.goal.value(r.nxt.S) : r.nxtTurn.dmg)}`)}" style="${inp};width:240px" title="Nom du build">
          <button data-a="saveBuild" style="${btn};background:#2e6fbf" title="Garde ce résultat : tu pourras le rouvrir sans relancer la recherche (ici ou depuis la bulle ❤️)">💾 Enregistrer ce build</button>`}
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button data-a="dropFarm" style="${btn};background:#6a3fa0" title="Liste de courses : objets à looter du build et favoris ❤️ ; le pilote enchaîne les combats de chasse dans les zones où ils tombent, jusqu’à les avoir tous">🐉 Aller dropper</button>
          <button data-a="equip" style="${btn};background:#2e7d32" ${owned ? '' : 'disabled'}>✅ Équiper ce build${Object.values(r.final).some((c) => c?.src === 'hdv') ? ' (objets possédés seulement)' : ''}</button>
          <span style="font-size:11px;color:#8a7d66">Les objets HDV (🛒) sont à acheter, ceux de la banque (🏦) à échanger d’abord, ceux du bestiaire (🐉) à looter (ou à acheter s’ils sont en vente) ; relance ensuite la recherche pour les équiper.</span>
        </div>
        <details style="font-size:11px;color:#b9a98c"><summary style="cursor:pointer">Contrôle du modèle (${badChecks.length ? `<span style="color:#f0a040">${badChecks.length} écart(s)</span>` : '<span style="color:#6fcf7a">OK</span>'})</summary>
          Stats calculées pour ton équipement actuel / affichées sur ta fiche : ${r.checks.map(([l, a, b]) => `<span style="color:${Math.abs(a - b) > Math.max(2, Math.abs(b) * 0.02) ? '#f0a040' : 'inherit'}">${esc(l)} ${fmt(a)} / ${fmt(b)}</span>`).join(' · ')}.
          Panoplies de la fiche : ${r.sheet.sets.map((x) => `${esc(x.name)} (${x.count}/${x.max}) ${esc(x.text)}`).join(' ; ') || 'aucune'}.
          Prestige ${r.sheet.prestige} (+${r.sheet.prestige * PRESTIGE_GEAR_PCT} %)${r.sheet.forge ? `, Bouclier de forge niv. ${r.sheet.forge} (+${String(r.sheet.forgePct).replace('.', ',')} %)` : ''}${r.gearMult ? ` → équipement ×${r.gearMult.toFixed(4).replace('.', ',')}` : ''}, niveau ${r.sheet.level}.</details>`;
    }
    if (load) openSave(load);
    else {   // réouverture : la dernière recherche, sans la relancer
      const last = lastBuild();
      if (last) {
        try {
          result = unpackBuild(last.data);
          render();
          say(`🕘 Dernière recherche (${new Date(last.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}) : photo de ce moment-là — « Lancer » pour la refaire avec ton inventaire actuel.`);
        } catch { result = null; }
      }
    }
  }

  // Favoris : chaque objet se déplie sur ses sources (bestiaire) ; une zone ouvre ses groupes de chasse.
  async function openFavorites() {
    document.querySelector('.dm-picker')?.remove();
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const ov = document.createElement('div');
    ov.className = 'dm-picker';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:#000a;display:grid;justify-items:center;align-items:start;padding:4vh 16px 16px;font:13px system-ui,sans-serif;color:#eee';
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:4px 9px;color:#fff;cursor:pointer;font:600 12px system-ui,sans-serif;background:#2a231a';
    ov.innerHTML = `<div style="width:min(720px,100%);max-height:90vh;display:flex;flex-direction:column;gap:10px;background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:14px;box-shadow:0 10px 40px #000">
      <div style="display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:15px">❤️ Favoris${DM.tip('Builds enregistrés avec 💾 dans l’optimiseur : « Ouvrir » les réaffiche sans relancer la recherche. Objets ajoutés avec le cœur ♡ de l’optimiseur de build. Clique sur un objet pour voir les boss et monstres qui le lâchent, avec tes chances ; clique sur une zone pour ouvrir ses groupes de chasse.')}</b><button data-a="drop" style="${btn};background:#6a3fa0" title="Farmer des objets favoris : liste de courses, puis combats de chasse automatiques dans les zones où ils tombent">🐉 Aller dropper</button><button data-a="clear" style="${btn}" title="Retirer tous les objets favoris (les builds enregistrés sont gardés) — 2e clic pour confirmer">🗑️ Vider tout</button><button data-a="x" style="${btn};background:transparent">✕</button></div>
      <div data-k="msg" style="font-size:12px;color:#b9a98c"></div>
      <div style="overflow-y:auto;display:flex;flex-direction:column;gap:10px">
        <div data-k="saves" style="display:flex;flex-direction:column;gap:4px"></div>
        <div data-k="list" style="display:flex;flex-direction:column;gap:6px"></div></div></div>`;
    document.body.appendChild(ov);
    const $ = (q) => ov.querySelector(q);
    const say = (t) => { $('[data-k="msg"]').textContent = t; };
    let b = null;
    try { b = await fetchBestiary(say); say(''); } catch (e) { say(`Bestiaire illisible (${e.message}) : sources indisponibles.`); }
    const pctTxt = (x) => `${(x >= 1 ? x.toFixed(1) : x.toFixed(2)).replace('.', ',')} %`;
    const zoneBtn = (id) => `<button data-zone="${+id}" style="${btn};background:#2e6fbf" title="Ouvrir les groupes de chasse de cette zone">🗺️ ${esc(b?.zones[id]?.[0] || `Zone ${id}`)}${b?.zones[id] ? ` <span style="font-weight:400;color:#cfe0ff">niv. ${b.zones[id][1]}–${b.zones[id][2]}</span>` : ''}</button>`;
    const sources = (id) => {
      const bosses = b?.boss[id] || [], mobs = b?.drops[id] || [];
      // monstres regroupés par zone (meilleure chance d'abord) : un clic sur la zone = ses groupes de chasse
      const byZone = new Map();
      for (const [n, lo, hi, p, zs] of mobs) {
        for (const z of zs.length ? zs : [null]) {
          if (!byZone.has(z)) byZone.set(z, []);
          byZone.get(z).push(`${esc(n)} <span style="color:#8a7d66">(niv. ${lo === hi ? lo : `${lo}–${hi}`})</span> : ${p ? pctTxt(p) : 'objet bonus de victoire'}`);
        }
      }
      const html = [
        ...bosses.map(([n, lvl, step, p, z, done, zid]) => `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">👑 <b>${esc(n)}</b> <span style="color:#8a7d66">Boss du Chemin, étape ${step}${done ? ' (vaincu)' : ''}, niv. ${lvl}</span> : ${p ? pctTxt(p) : '?'} ${zid != null ? zoneBtn(zid) : `<span style="color:#8a7d66">— ${esc(z)}</span>`}</div>`),
        ...[...byZone].map(([z, list]) => `<div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">${z == null ? '<span style="color:#8a7d66">Zone inconnue</span>' : zoneBtn(z)}<span style="flex:1;min-width:200px">${list.join(' · ')}</span></div>`),
      ];
      return html.join('') || '<div style="color:#8a7d66">Ni monstre ni boss du bestiaire ne le lâche (coffres, objet bonus, boutique…).</div>';
    };
    const render = () => {
      const saves = buildSaves();
      $('[data-k="saves"]').innerHTML = saves.length ? `<b style="font-size:13px">💾 Builds enregistrés</b>${saves.map((x) => `<div style="display:flex;gap:8px;align-items:center;background:#241e16;border:1px solid #3a3024;border-radius:8px;padding:4px 8px">
        <span style="flex:1">${esc(x.name)} <span style="color:#8a7d66;font-size:12px">— ${esc(x.who || '?')}, ${new Date(x.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</span></span>
        <button data-open-save="${esc(x.id)}" style="${btn};background:#2e6fbf">📂 Ouvrir</button></div>`).join('')}<b style="font-size:13px;margin-top:6px">❤️ Objets</b>` : '';
      const favs = Object.entries(buildFavs()).sort((x, y) => (y[1].lvl || 0) - (x[1].lvl || 0));
      $('[data-a="clear"]').style.display = favs.length ? '' : 'none';
      $('[data-k="list"]').innerHTML = favs.length ? favs.map(([id, f]) => `<details style="background:#241e16;border:1px solid #3a3024;border-radius:8px;padding:6px 8px">
        <summary style="cursor:pointer;display:flex;align-items:center;gap:6px">${f.icon ? `<img src="/img/items/${+f.icon}.png" alt="" style="width:26px;height:26px;object-fit:contain">` : ''}
          <b style="flex:1">${esc(f.name)}</b><span style="color:#8a7d66;font-size:12px">${esc(SLOT_NAMES[f.type] || f.type || '')}${f.lvl ? ` · niv. ${f.lvl}` : ''}${f.setName ? ` · ${esc(f.setName)}` : ''}</span>
          ${f.type ? `<a href="/hdv?emplacement=${encodeURIComponent(f.type)}" target="_blank" style="${btn};text-decoration:none" title="Ouvrir l’HDV sur cet emplacement (nouvel onglet)">🛒 HDV</a>` : ''}
          <button data-unfav="${esc(id)}" style="${btn}" title="Retirer des favoris">✕</button></summary>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;font-size:12px">${sources(+id)}</div></details>`).join('')
        : '<div style="color:#b9a98c">Aucun objet favori : dans l’optimiseur de build, clique sur le cœur ♡ à côté d’un objet.</div>';
    };
    render();
    ov.addEventListener('click', async (e) => {
      if (e.target.closest('[data-a="x"]')) return close();
      if (e.target.closest('[data-a="drop"]')) { close(); openDropFarm(); return; }
      const clr = e.target.closest('[data-a="clear"]');
      if (clr) {
        if (!clr.dataset.armed) {   // 2e clic dans les 5 s pour confirmer
          clr.dataset.armed = '1';
          clr.textContent = `⚠️ Confirmer : retirer ${Object.keys(buildFavs()).length} objet(s)`;
          setTimeout(() => { if (clr.isConnected) { delete clr.dataset.armed; clr.textContent = '🗑️ Vider tout'; } }, 5000);
          return;
        }
        delete clr.dataset.armed;
        clr.textContent = '🗑️ Vider tout';
        await save({ buildFavs: {} });
        render();
        return;
      }
      const os = e.target.closest('[data-open-save]');
      if (os) { close(); openBuildOptimizer({ load: os.dataset.openSave }); return; }
      const un = e.target.closest('[data-unfav]');
      if (un) { e.preventDefault(); await toggleFav({ id: un.dataset.unfav }); render(); return; }
      const z = e.target.closest('[data-zone]');
      if (z) {
        // onglet du pilote : on ne l'emmène pas ailleurs, la zone s'ouvre dans un nouvel onglet
        const url = `/chasse?zone=${+z.dataset.zone}`;
        if (isOwner()) window.open(url, '_blank'); else location.href = url;
      }
    });
  }

  async function openSpellList() {
    document.querySelector('.dm-picker')?.remove();
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const ov = document.createElement('div');
    ov.className = 'dm-picker';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:#000a;display:grid;justify-items:center;align-items:start;padding:4vh 16px 16px;font:13px system-ui,sans-serif;color:#eee';
    ov.innerHTML = '<div style="background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:16px">Lecture de tes sorts…</div>';
    document.body.appendChild(ov);
    let favChanged = false;
    const close = () => {
      ov.remove();
      document.removeEventListener('keydown', onKey, true);
      if (favChanged && location.pathname.startsWith('/deck')) location.reload();   // la page /deck affiche les nouveaux favoris
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => e.stopPropagation());

    let data;
    try {
      data = await fetchSpells();
    } catch (e) {
      ov.firstElementChild.textContent = `❌ ${e.message}`;
      return;
    }
    const { spells, favs, variableOnly, chunks } = data;
    const NO_FILTERS = { q: '', target: '', el: '', sort: 'avg', dir: -1, favOnly: false, real: false };
    const baseOf = new Map(spells.map((sp) => [sp, { ...sp }]));   // valeurs de base de chaque sort
    let charStats = null, statsMsg = '';
    let f = { ...NO_FILTERS };
    try { f = { ...f, ...JSON.parse(localStorage.getItem(SPELL_FILTERS_KEY) || '{}'), q: '' }; } catch { /* stockage indisponible */ }
    const saveFilters = () => { try { localStorage.setItem(SPELL_FILTERS_KEY, JSON.stringify(f)); } catch { /* idem */ } };
    let msg = '';

    const inp = 'background:#2a231a;border:1px solid #5a4a33;border-radius:8px;color:#eee;padding:5px 8px;font:13px system-ui,sans-serif';
    const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:5px 10px;color:#fff;cursor:pointer;font:600 12px system-ui,sans-serif;background:#2a231a';
    const SORTS = [['avg', 'Dégâts totaux'], ['perAp', 'Dégâts / PA'], ['ap', 'Coût en PA'], ['name', 'Nom']];
    ov.innerHTML = `
      <div style="width:min(860px,100%);max-height:90vh;display:flex;flex-direction:column;gap:10px;background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:14px;box-shadow:0 10px 40px #000">
        <div style="display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:15px">📚 Tierlist de mes sorts${DM.tip("Tous les sorts à dégâts de ta collection, avec les dégâts de base de la carte (sans tes caractéristiques). Un sort à plusieurs lignes de dégâts affiche leur total, même sur des éléments différents : toutes les lignes sont appliquées, sauf celles à x % de chance (comptées en moyenne, 🎲). Bombes, pièges et poisons comptent leurs dégâts (le poison, sur toute sa durée). Le cadenas met le sort en favori sur le site (toujours en haut de la liste de /deck).")}</b><button data-a="test" style="${btn}" data-tip="Compare mon calcul aux vrais coups de ton dernier combat (capturé automatiquement) : coup observé, estimation sans résistance et estimation avec les résistances de la cible. « Copier » pour me l’envoyer.">🧪 Tester le calcul</button><button data-a="x" style="${btn};background:transparent">✕</button></div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
          <input data-f="q" placeholder="Rechercher un sort…" style="${inp};flex:1;min-width:140px">
          <select data-f="target" style="${inp}"><option value="">Toutes cibles</option><option value="single">Cible unique</option><option value="zone">Zone</option></select>
          <select data-f="el" style="${inp}"><option value="">Tous éléments</option>${ELEMENTS.map((e, i) => `<option value="${i}">${e.name}</option>`).join('')}<option value="multi">Multi-éléments</option></select>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" data-f="favOnly"> Favoris</label>
          <label data-tip="Calcule les dégâts avec tes caractéristiques (lues sur ton dernier combat) : stat de l’élément + Puissance (+1 % par point), Dommages fixes à chaque ligne, % Dommages aux sorts, critique (chance de la carte + ton % Critique, coup ×1,25 estimé) et vision spectrale. Un sort multi-éléments ne profite que de tes éléments forts." style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-left:auto">
            <span class="dm-sw" style="position:relative;width:34px;height:18px;border-radius:9px;background:#5a4a33;transition:.15s;flex:none"><span style="position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#eee;transition:.15s"></span></span>
            <input type="checkbox" data-f="real" style="display:none"> Avec mes stats</label>
        </div>
        <div data-k="stats" style="font-size:11px;color:#b9a98c;display:none"></div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center"><span style="color:#b9a98c">Trier :</span>
          ${SORTS.map(([k, l]) => `<button data-sort="${k}" style="${btn}">${l}</button>`).join('')}
          <span data-k="count" style="margin-left:auto;color:#b9a98c"></span>
        </div>
        <div data-k="msg" style="font-size:12px;min-height:1em"></div>
        <div data-k="list" style="overflow-y:auto;display:flex;flex-direction:column;gap:4px;padding-right:4px"></div>
        <div style="color:#8a7d66;font-size:11px">${variableOnly.length ? `Non classés (dégâts selon la vie) : ${esc(variableOnly.join(', '))}. ` : ''}Dégâts de base des cartes, hors caractéristiques du personnage.</div>
      </div>`;
    const $ = (sel) => ov.querySelector(sel);
    for (const el of ov.querySelectorAll('[data-f]')) {
      if (el.type === 'checkbox') el.checked = !!f[el.dataset.f]; else el.value = f[el.dataset.f] ?? '';
      el.addEventListener(el.tagName === 'INPUT' && el.type !== 'checkbox' ? 'input' : 'change', () => {
        f[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value;
        saveFilters();
        if (el.dataset.f === 'real') return applyStats();
        render();
      });
    }
    // Interrupteur « Avec mes stats » : recalcul de tous les sorts avec les caractéristiques (ou retour aux valeurs de base)
    async function applyStats() {
      if (f.real && !charStats) {
        statsMsg = 'Lecture de tes caractéristiques…';
        render();
        charStats = await fetchCharStats();
        statsMsg = charStats ? '' : 'Caractéristiques introuvables : lance un combat puis rouvre la tierlist.';
      }
      for (const sp of spells) {
        const d = f.real && charStats ? spellDamage(sp.card, charStats.stats) : baseOf.get(sp);
        Object.assign(sp, { min: d.min, max: d.max, avg: d.avg, byEl: d.byEl, critP: d.critP || 0 });
        sp.perAp = sp.ap ? sp.avg / sp.ap : Infinity;
      }
      render();
    }
    ov.addEventListener('click', async (e) => {
      if (e.target.closest('[data-a="x"]')) return close();
      if (e.target.closest('[data-a="test"]')) return openDamageTest(spells);
      const sb = e.target.closest('[data-sort]');
      if (sb) {
        const k = sb.dataset.sort;
        // nouveau tri : sens naturel (dégâts décroissants, PA et nom croissants) ; même tri : on inverse
        f.dir = f.sort === k ? -f.dir : (k === 'ap' || k === 'name' ? 1 : -1);
        f.sort = k;
        saveFilters();
        return render();
      }
      const fb = e.target.closest('[data-fav]');
      if (!fb || fb.disabled) return;
      const id = +fb.dataset.fav, on = !favs.has(id);
      fb.disabled = true;
      try {
        await setFavorite(id, on, chunks);
        if (on) favs.add(id); else favs.delete(id);
        favChanged = true;
        msg = '';
      } catch (err) {
        msg = `❌ Favori : ${err.message}`;
      }
      render();
    });

    const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
    const STAT_SHOW = [['force', 'Force'], ['intelligence', 'Intel.'], ['chance', 'Chance'], ['agilite', 'Agi.'], ['puissance', 'Puissance'],
      ['dommages', 'Dommages'], ['dommagesNeutre', 'Do Neutre'], ['dommagesTerre', 'Do Terre'], ['dommagesFeu', 'Do Feu'], ['dommagesEau', 'Do Eau'],
      ['dommagesAir', 'Do Air'], ['critique', '% Crit'], ['dommagesCritiques', 'Do Crit'], ['dmgPctSorts', '% Do sorts'], ['po', 'PO']];
    function render() {
      const sw = ov.querySelector('.dm-sw');
      sw.style.background = f.real ? '#2e7d32' : '#5a4a33';
      sw.firstElementChild.style.left = f.real ? '18px' : '2px';
      const sb = $('[data-k="stats"]');
      sb.style.display = f.real ? '' : 'none';
      sb.textContent = statsMsg || (charStats ? `Tes stats (combat de ${DM.hhmm(charStats.at)}) : ${STAT_SHOW.filter(([k]) => +charStats.stats[k]).map(([k, l]) => `${l} ${charStats.stats[k]}`).join(' · ') || 'aucun bonus'} — dégâts avant résistances du monstre.` : '');
      const q = normName(f.q || '');
      const list = spells.filter((sp) => {
        if (q && !normName(sp.name).includes(q)) return false;
        if (f.target === 'single' && sp.zone) return false;
        if (f.target === 'zone' && !sp.zone) return false;
        const els = Object.keys(sp.byEl);
        if (f.el === 'multi' && els.length < 2) return false;
        if (f.el !== '' && f.el !== 'multi' && !els.includes(String(f.el))) return false;
        if (f.favOnly && !favs.has(sp.id)) return false;
        return true;
      });
      const key = f.sort;
      list.sort((a, b) => (key === 'name' ? a.name.localeCompare(b.name) * f.dir
        : ((a[key] === b[key] ? 0 : a[key] > b[key] ? 1 : -1) * f.dir) || b.avg - a.avg || a.name.localeCompare(b.name)));
      for (const b of ov.querySelectorAll('[data-sort]')) {
        const on = b.dataset.sort === key;
        b.style.background = on ? '#8a5a1a' : '#2a231a';
        b.textContent = SORTS.find(([k]) => k === b.dataset.sort)[1] + (on ? (f.dir > 0 ? ' ▲' : ' ▼') : '');
      }
      $('[data-k="count"]').textContent = `${list.length} / ${spells.length} sorts · ${favs.size} favori(s)`;
      $('[data-k="msg"]').textContent = msg;
      $('[data-k="msg"]').style.color = '#ff7b6b';
      $('[data-k="list"]').innerHTML = list.map((sp, i) => {
        const fav = favs.has(sp.id);
        const chips = Object.entries(sp.byEl).sort((a, b) => b[1] - a[1]).map(([el, v]) => {
          const E = ELEMENTS[el] || { name: '?', color: '#888' };
          return `<span title="${esc(E.name)} : ${fmt(v)} en moyenne" style="display:inline-block;padding:1px 6px;border-radius:6px;font-size:11px;font-weight:700;color:${E.color};border:1px solid ${E.color}66;background:${E.color}1f">${esc(E.name)}</span>`;
        }).join(' ');
        const tags = [sp.zone ? '🌀 Zone' : '🎯 Cible unique', sp.delayed ? '⏳ différé' : '', sp.random ? '🎲 % de chance' : '', sp.variable ? '+ variable' : ''].filter(Boolean).join(' · ');
        return `<div style="display:grid;grid-template-columns:28px 40px 1fr auto auto auto 30px;gap:8px;align-items:center;background:${fav ? '#3a2e14' : '#241e16'};border:1px solid ${fav ? '#e0b040' : '#3a3024'};border-radius:8px;padding:5px 8px">
          <b style="color:#b9a98c;text-align:right">${i + 1}</b>
          <img src="/img/spells/sort_${+sp.icon}.png" alt="" style="width:36px;height:36px;object-fit:contain">
          <div style="min-width:0"><div style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(sp.desc)}">${esc(sp.name)}</div>
            <div style="font-size:11px;color:#b9a98c">${chips} ${tags}</div></div>
          <div style="text-align:center" title="Coût en PA"><b style="font-size:15px;color:#5aa9e6">${sp.ap}</b><div style="font-size:10px;color:#8a7d66">PA</div></div>
          <div style="text-align:right;min-width:86px" title="${f.real ? `Dégâts moyens avec tes stats (critique ${Math.round((sp.critP || 0) * 100)} % compris) — min sans critique, max en critique` : 'Dégâts totaux (min – max)'}"><b style="font-size:15px">${fmt(sp.avg)}</b><div style="font-size:10px;color:#8a7d66">${sp.min} – ${sp.max}</div></div>
          <div style="text-align:right;min-width:56px" title="Dégâts moyens par PA"><b style="font-size:14px;color:#f0c04a">${sp.ap ? fmt(sp.perAp) : '—'}</b><div style="font-size:10px;color:#8a7d66">/ PA</div></div>
          <button data-fav="${sp.id}" title="${fav ? 'Favori sur le site : cliquer pour le retirer' : 'Mettre en favori sur le site (toujours en haut de /deck)'}" style="width:28px;height:28px;border-radius:50%;cursor:pointer;border:1px solid ${fav ? '#e0b040' : '#5a4a33'};background:${fav ? '#e0b040' : 'transparent'};color:${fav ? '#1d1812' : '#b9a98c'};font-size:13px">${fav ? '🔒' : '🔓'}</button>
        </div>`;
      }).join('') || '<div style="color:#b9a98c;padding:12px">Aucun sort ne correspond aux filtres.</div>';
    }
    if (f.real) applyStats(); else render();
  }

  // ---------- Farm de drop (🐉 Aller dropper, depuis l'optimiseur) ----------
  // cfg.dropRun = { active, items: [{ id, name, icon, tier, need, got, srcs: [{ m: monstre, p: ta chance %, z: [zones] }] }],
  //   zoneNames: { id: libellé }, zone, tried: [zones sans groupe utile depuis le dernier combat], skipped: [zones abandonnées],
  //   prev: { mode, huntZone, huntZoneName, huntGroup }, startedAt }
  // Le pilote passe en mode Chasse sur la zone la plus rentable, n'attaque que les groupes contenant un monstre qui lâche
  // un objet voulu, compte les objets reçus (butin de fin de combat) et change de zone quand celle-ci n'a plus rien à donner.
  // Copies : T1 = 1 exemplaire, T2 = 3, T3 = 9, T4 = 27, T5 (Rayonnant) = 81 (fusion 3 → 1).
  const DROP_MAX_DEFEATS = 5;
  const dropOn = () => !!cfg.dropRun?.active;
  const dropLeft = (run = cfg.dropRun) => (run?.items || []).filter((it) => it.got < it.need);
  const dropZoneName = (z, run = cfg.dropRun) => run?.zoneNames?.[z] || `zone ${z}`;
  // Zones utiles : objets restants qu'on peut y obtenir, et somme des chances (la plus rentable d'abord).
  function dropZones(run = cfg.dropRun) {
    const zones = new Map();
    for (const it of dropLeft(run)) {
      for (const s of it.srcs) {
        for (const z of s.z || []) {
          if (run.skipped?.includes(z)) continue;
          const e = zones.get(z) || { ids: new Set(), score: 0 };
          if (!e.ids.has(it.id)) e.score += s.p;
          e.ids.add(it.id);
          zones.set(z, e);
        }
      }
    }
    return [...zones].sort((a, b) => b[1].ids.size - a[1].ids.size || b[1].score - a[1].score);
  }
  // Monstres à attaquer dans une zone (noms normalisés) : ceux qui lâchent un objet restant.
  const dropTargets = (zone, run = cfg.dropRun) => new Set(dropLeft(run)
    .flatMap((it) => it.srcs.filter((s) => (s.z || []).includes(zone)).map((s) => normName(s.m))));

  // Groupe à attaquer sur la page de la zone : n° du groupe avec le plus de monstres voulus ; false si aucun ; null si la
  // page n'est pas encore chargée.
  function dropPickGroup() {
    const cards = groupCards();
    if (!cards.length) return null;
    const targets = dropTargets(cfg.huntZone);
    let best = null;
    for (const p of cards) {
      const n = groupMonsters(p).filter((m) => targets.has(normName(m))).length;
      if (n && (!best || n > best.n)) best = { g: groupNumber(p), n };
    }
    return best ? best.g : false;
  }

  // Zone suivante (la plus rentable, hors zones déjà essayées sans groupe utile et zones abandonnées).
  async function dropGoZone(why) {
    const run = cfg.dropRun;
    if (!run?.active) return;
    if (!dropLeft(run).length) return dropFinish();
    const next = dropZones(run).find(([z]) => !(run.tried || []).includes(z));
    if (!next) {
      const lost = dropLeft(run).map((it) => it.name);
      return dropStop(`aucune zone restante n’a de groupe avec les monstres voulus${run.skipped?.length ? ` (${run.skipped.length} zone(s) abandonnée(s) après ${DROP_MAX_DEFEATS} défaites)` : ''}. Objets manquants : ${lost.join(', ')}`);
    }
    const [z, info] = next;
    DM.log(`farm de drop : ${why} → ${dropZoneName(z)} (${info.ids.size} objet(s) possible(s))`);
    await save({ dropRun: { ...run, zone: z }, huntZone: z, huntZoneName: dropZoneName(z), huntGroup: null, huntTarget: null, lossStreak: 0 });
    setStatus(`Farm de drop : ${why} → ${dropZoneName(z)}…`);
    progress();
    if (isOwner()) location.assign(`/chasse?zone=${z}`);
  }

  // Butin de fin de combat (rewards.items : un exemplaire par ligne, « f » = tier de fusion).
  let dropLastReward = '';
  function dropOnRewards(rewards, key) {
    if (!dropOn() || !Array.isArray(rewards?.items) || !rewards.items.length) return;
    const sig = `${key}|${rewards.items.map((i) => `${i.id}:${i.f || 0}`).join(',')}`;
    if (sig === dropLastReward) return;
    dropLastReward = sig;
    const run = { ...cfg.dropRun, items: cfg.dropRun.items.map((it) => ({ ...it })) };
    const got = [];
    for (const r of rewards.items) {
      const it = run.items.find((x) => x.id === r.id && x.got < x.need);
      if (!it) continue;
      it.got = Math.min(it.need, it.got + 3 ** (+r.f || 0));
      got.push(it);
    }
    if (!got.length) return;
    run.tried = [];
    save({ dropRun: run });
    for (const it of got) {
      DM.log(`farm de drop : ${it.name} ${it.got}/${it.need}`);
      notify('drop', `🐉 Drop : **${it.name}** (${it.got}/${it.need}${it.got >= it.need ? ' ✔' : ''}) — ${dropZoneName(run.zone, run)}`);
    }
    if (!dropLeft(run).length) dropFinish();
  }

  // Fin du farm : pilote arrêté, mode précédent rétabli.
  async function dropEnd(status, msg) {
    const run = cfg.dropRun;
    if (!run) return;
    const prev = run.prev || {};
    await save({ dropRun: { ...run, active: false, endedAt: Date.now() }, enabled: false, paused: false, botFight: false, status,
      mode: prev.mode || cfg.mode, huntZone: prev.huntZone ?? null, huntZoneName: prev.huntZoneName || '', huntGroup: prev.huntGroup ?? null, huntTarget: null });
    notify('drop', msg);
  }
  const dropFinish = () => dropEnd('Farm de drop terminé ✔',
    `✅ **Farm de drop terminé** : tout est droppé (${(cfg.dropRun?.items || []).map((it) => `${it.name} ×${it.need}`).join(', ')}). Pilote arrêté.`);
  const dropStop = (reason) => dropEnd(`Farm de drop arrêté : ${reason}`.slice(0, 200), `⏹️ **Farm de drop arrêté** : ${reason}`);

  // Lancement depuis l'optimiseur : items = [{ id, name, icon, tier, srcs }], zoneNames = { id: libellé }.
  async function startDropFarm(items, zoneNames) {
    const run = {
      active: true, startedAt: Date.now(), zoneNames, tried: [], skipped: [], zone: null,
      items: items.map((it) => ({ ...it, need: it.need ?? 3 ** (it.tier - 1), got: 0 })),
      prev: dropOn() ? cfg.dropRun.prev : { mode: cfg.mode, huntZone: cfg.huntZone, huntZoneName: cfg.huntZoneName, huntGroup: cfg.huntGroup },
    };
    if (!dropZones(run).length) throw new Error('aucune zone de chasse connue pour ces objets');
    await save({ dropRun: run, mode: 'chasse', pauseReason: null });
    await send({ type: 'claim', start: true }).catch(() => {});   // le pilote démarre sur cet onglet
    await dropGoZone('départ');
  }

  // Fenêtre « 🐉 Aller dropper » : objets à looter du build (à cocher, rien par défaut) → liste de courses en dessous,
  // avec le tier voulu pour chacun (retenu d'une fois sur l'autre).
  const DROP_TIERS_KEY = 'dmDropTiers';
  // Candidats : objets à looter du build (r, facultatif) puis objets favoris ❤️ ; sources lues dans le bestiaire.
  async function openDropFarm(r = null) {
    document.querySelector('.dm-drop-farm')?.remove();
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    let b;
    try { b = await fetchBestiary(); } catch (e) { tradeToast(`🐉 Bestiaire illisible : ${e.message}`, 'err'); return; }
    const zones = b.zones || {};
    // exemplaires possédés (inventaire + porté), en équivalents T1 : un objet en tier n vaut 3^(n−1) exemplaires
    const owned = new Map();
    try {
      const st = await fetchEquipState();
      for (const e of st.entries) owned.set(e.id, (owned.get(e.id) || 0) + e.qty * 3 ** (e.fusion || 0));
      for (const s of st.slots) if (s.cur) owned.set(s.cur.id, (owned.get(s.cur.id) || 0) + 3 ** (s.cur.fusion || 0));
    } catch (e) { DM.log(`aller dropper : inventaire illisible (${e.message}) — objets possédés non déduits`); }
    const cands = [
      // tous les objets du build proposé (à looter ou déjà possédés : farmer un objet qu'on a fait monter son tier)
      ...Object.values(r?.final || {}).filter(Boolean).map((c) => ({ id: c.id, name: c.name, icon: c.icon, from: 'build' })),
      ...Object.entries(buildFavs()).map(([id, f]) => ({ id: +id, name: f.name, icon: f.icon, from: 'fav' })),
    ].filter((c, i, a) => a.findIndex((x) => x.id === c.id) === i);
    const items = cands.map((c) => {
      // p = 0 : « objet bonus de victoire » de la zone (le jeu ne publie pas la chance)
      const srcs = (b.drops[c.id] || []).filter(([, , , , zs]) => zs?.length).map(([m, , , p, z]) => ({ m, p: +p || 0, z }));
      return { c, srcs, best: Math.max(0, ...srcs.map((s) => s.p)), have: owned.get(c.id) || 0 };
    });
    // exemplaires encore à farmer pour le tier voulu (T1 = 1, T2 = 3, T3 = 9… moins ceux qu'on a déjà)
    const needOf = (i) => Math.max(0, 3 ** (tierOf(i) - 1) - items[i].have);
    const haveTxt = (n) => (n ? `possédé : ${n} ex.${n >= 3 ? ` (≈ T${Math.floor(Math.log(n) / Math.log(3) + 1e-9) + 1})` : ''}` : '');
    let tiers = {};
    try { tiers = JSON.parse(localStorage.getItem(DROP_TIERS_KEY) || '{}'); } catch { /* stockage indisponible */ }
    const cart = new Set();   // indices des objets dans la liste de courses
    const ov = document.createElement('div');
    ov.className = 'dm-drop-farm';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483601;background:#000c;display:grid;justify-items:center;align-items:start;padding:4vh 16px 16px;font:13px system-ui,sans-serif;color:#eee';
    const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:5px 10px;color:#fff;cursor:pointer;font:600 12px system-ui,sans-serif;background:#2a231a';
    const inp = 'background:#2a231a;border:1px solid #5a4a33;border-radius:8px;color:#eee;padding:3px 6px;font:13px system-ui,sans-serif';
    const row = 'display:flex;align-items:center;gap:8px;background:#241e16;border:1px solid #3a3024;border-radius:8px;padding:5px 8px';
    const pct = (x) => `${(x >= 1 ? x.toFixed(1) : x.toFixed(2)).replace('.', ',')} %`;
    const icon = (c) => (c.icon ? `<img src="/img/items/${+c.icon}.png" alt="" style="width:26px;height:26px;object-fit:contain">` : '');
    const tierOf = (i) => tiers[items[i].c.id] || 1;
    ov.innerHTML = `<div style="width:min(680px,100%);max-height:90vh;display:flex;flex-direction:column;gap:10px;background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:14px;box-shadow:0 10px 40px #000">
      <div style="display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:15px">🐉 Aller dropper${DM.tip('Coche les objets à aller chercher : ils passent dans la liste de courses, où tu choisis le tier voulu. Le pilote passe ensuite en mode Chasse : il va dans la zone la plus rentable, n’attaque que les groupes qui contiennent un monstre qui lâche un objet de la liste, compte les objets reçus en fin de combat et change de zone quand celle-ci n’a plus rien à donner (ou aucun groupe utile). 5 défaites d’affilée dans une zone : elle est abandonnée (notification) et on passe à la suivante. Plus aucune zone possible : arrêt + notification. Tout est droppé : arrêt + notification. Le mode de combat (Auto du jeu / par poids) est celui du menu 🤖. Tier : T1 = 1 exemplaire, T2 = 3, T3 = 9, T4 = 27, T5 (Rayonnant) = 81 (fusion 3 → 1).')}</b><button data-a="x" style="${btn};background:transparent">✕</button></div>
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#b9a98c"><span style="flex:1">Objets du build et objets favoris ❤️ — coche ceux à farmer (les exemplaires que tu as déjà sont déduits) :</span>
        <button data-a="all" style="${btn};padding:2px 8px">☑ Tout sélectionner</button><button data-a="none" style="${btn};padding:2px 8px">☐ Tout désélectionner</button></div>
      <div style="overflow-y:auto;max-height:38vh;display:flex;flex-direction:column;gap:4px">${items.map(({ c, srcs, best, have }, i) => `<label style="${row};cursor:${srcs.length ? 'pointer' : 'default'};${srcs.length ? '' : 'opacity:.55'}">
        <input type="checkbox" data-i="${i}" ${srcs.length ? '' : 'disabled'}>
        ${icon(c)}
        <span style="flex:1;min-width:0"><b>${esc(c.name)}</b> <span style="font-size:11px;color:${c.from === 'fav' ? '#ff5c7a' : '#c99bff'}">${c.from === 'fav' ? '❤️ favori' : '🧬 build'}</span>${have ? ` <span style="font-size:11px;color:#6fcf7a">🎒 ${haveTxt(have)}</span>` : ''}<br><span style="color:#8a7d66;font-size:12px">${!srcs.length ? 'pas obtenable en chasse (boss du Chemin ou de chasse…)'
          : best > 0 ? `meilleure chance ${pct(best)} · ${new Set(srcs.flatMap((s) => s.z)).size} zone(s) · ${esc(srcs.slice().sort((a, b) => b.p - a.p).slice(0, 2).map((s) => `${s.m} (${pct(s.p)})`).join(', '))}`
          : `objet bonus de victoire (chance non publiée) · ${esc([...new Set(srcs.flatMap((s) => s.z))].map((z) => zones[z]?.[0] || `zone ${z}`).slice(0, 3).join(', '))}`}</span></span>
      </label>`).join('') || '<div style="color:#b9a98c">Aucun objet : ce build n’a pas d’objet à looter (🐉), et tu n’as pas de favori ❤️. Ajoute des objets en favori avec le cœur ♡ de l’optimiseur.</div>'}</div>
      <div style="border-top:1px solid #3a3024;padding-top:8px;display:flex;flex-direction:column;gap:4px">
        <div style="display:flex;align-items:center;gap:6px"><b style="font-size:13px;flex:1">🛒 Liste de courses</b>
          <label style="font-size:12px;color:#b9a98c">Tier pour toute la liste <select data-a="tierAll" style="${inp}"><option value="">—</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">T${n}${n === 5 ? ' (Rayonnant)' : ''}</option>`).join('')}</select></label></div>
        <div data-k="cart" style="overflow-y:auto;max-height:30vh;display:flex;flex-direction:column;gap:4px"></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center"><span data-k="msg" style="flex:1;font-size:12px;color:#b9a98c"></span><button data-a="go" style="${btn};background:#8a5a1a">🐉 Lancer le farm</button></div></div>`;
    document.body.appendChild(ov);
    DM.installTips(ov);
    const $ = (q) => ov.querySelector(q);
    const renderCart = () => {
      const list = [...cart].sort((a, b) => a - b);
      $('[data-k="cart"]').innerHTML = list.map((i) => {
        const { c, best, have } = items[i], t = tierOf(i), need = needOf(i);
        return `<div style="${row};${need ? '' : 'opacity:.6'}">${icon(c)}<b style="flex:1;min-width:0">${esc(c.name)}${have ? `<br><span style="font-weight:400;font-size:11px;color:#6fcf7a">🎒 ${haveTxt(have)}</span>` : ''}</b>
          <select data-t="${i}" style="${inp}">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}"${n === t ? ' selected' : ''}>T${n}${n === 5 ? ' (Rayonnant)' : ''}</option>`).join('')}</select>
          <span style="color:#b9a98c;font-size:12px;width:140px;text-align:right">${!need ? '✔ déjà atteint' : `${need} ex. à farmer · ${best > 0 ? `~${Math.ceil(need / (best / 100)).toLocaleString('fr-FR')} combats` : 'chance inconnue'}`}</span>
          <button data-rm="${i}" style="${btn};padding:2px 7px" title="Retirer de la liste">✕</button></div>`;
      }).join('') || '<div style="color:#8a7d66;font-size:12px">Vide : coche des objets au-dessus.</div>';
      const todo = list.filter((i) => needOf(i) > 0);
      const total = todo.reduce((n, i) => n + (items[i].best > 0 ? Math.ceil(needOf(i) / (items[i].best / 100)) : 0), 0);
      const unknown = todo.some((i) => !(items[i].best > 0));
      $('[data-a="go"]').disabled = !todo.length;
      $('[data-a="go"]').style.opacity = todo.length ? '' : '.5';
      $('[data-a="go"]').textContent = todo.length ? `🐉 Lancer le farm (${todo.length} objet(s)${total ? `, ~${total.toLocaleString('fr-FR')} combats${unknown ? ' + chances inconnues' : ''}` : ''})`
        : list.length ? '✔ Tout est déjà atteint' : '🐉 Lancer le farm';
    };
    renderCart();
    const close = () => ov.remove();
    ov.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.i != null) { if (t.checked) cart.add(+t.dataset.i); else cart.delete(+t.dataset.i); renderCart(); }
      if (t.dataset.a === 'tierAll' && t.value) {   // tier de toute la liste ; chaque ligne reste modifiable ensuite
        for (const i of cart) tiers[items[i].c.id] = +t.value;
        try { localStorage.setItem(DROP_TIERS_KEY, JSON.stringify(tiers)); } catch { /* idem */ }
        t.value = '';
        renderCart();
      }
      if (t.dataset.t != null) {
        tiers[items[+t.dataset.t].c.id] = +t.value;
        try { localStorage.setItem(DROP_TIERS_KEY, JSON.stringify(tiers)); } catch { /* idem */ }
        renderCart();
      }
    });
    ov.addEventListener('click', async (e) => {
      if (e.target === ov || e.target.closest('[data-a="x"]')) return close();
      const sel = e.target.closest('[data-a="all"], [data-a="none"]')?.dataset.a;
      if (sel) {
        items.forEach(({ srcs }, i) => {
          const cb = $(`[data-i="${i}"]`);
          if (!cb || !srcs.length) return;
          cb.checked = sel === 'all';
          if (cb.checked) cart.add(i); else cart.delete(i);
        });
        renderCart();
        return;
      }
      const rm = e.target.closest('[data-rm]');
      if (rm) { cart.delete(+rm.dataset.rm); const cb = $(`[data-i="${rm.dataset.rm}"]`); if (cb) cb.checked = false; renderCart(); return; }
      if (!e.target.closest('[data-a="go"]') || !cart.size) return;
      const pick = [...cart].filter((i) => needOf(i) > 0).map((i) => ({ ...items[i], i }));
      if (!pick.length) { $('[data-k="msg"]').textContent = 'Tous les tiers voulus sont déjà atteints avec tes objets.'; return; }
      const zoneNames = {};
      for (const { srcs } of pick) for (const s of srcs) for (const z of s.z) zoneNames[z] = zones[z]?.[0] || `Zone ${z}`;
      try {
        $('[data-k="msg"]').textContent = 'Lancement…';
        await startDropFarm(pick.map(({ c, srcs, i }) => ({ id: c.id, name: c.name, icon: c.icon, tier: tierOf(i), need: needOf(i), srcs })), zoneNames);
        close();
        document.querySelector('.dm-picker')?.remove();
      } catch (err) {
        $('[data-k="msg"]').textContent = `❌ ${err.message}`;
      }
    });
  }

  // ---------- Auto par poids : notre propre mode auto (cfg.fightEngine === 'weights') ----------
  // L'Auto du jeu joue à la vitesse ×1 ; ici le pilote joue lui-même, comme à la main, par la server action du combat
  // « fightAction(action, idOnglet, seq) » : { type:'play', card: uid, target } ou { type:'end' }. Chaque réponse
  // contient le nouvel état ({ state, rewards }, ou { wait: ms } si le serveur veut qu'on patiente).
  // Choix : chaque carte a un poids (cfg.cardWeights[idCarte] = { w, every }, arme = clé 'w'). À chaque action, parmi
  // les cartes jouables, on retient la combinaison qui tient dans les PA avec le plus gros total de poids, et on joue
  // sa carte la plus lourde. Poids 0 = jamais jouée ; every = au plus une fois tous les N tours (buffs qui durent) ;
  // soins seulement sous cfg.autoHealBelow % de PV. Cible : l'ennemi vivant qui a le moins de PV.
  const FIGHT_ACTION_FALLBACK = '70ef177923eabb2dd53cecdb33f2fa0fe42313c618';
  // needsTarget du jeu : une ligne visant un ennemi avec un de ces effets demande une cible
  const TARGET_EFFECTS = new Set(['dmg', 'steal', 'dmgCasterHp', 'debuff', 'stealStat', 'apRemove', 'apSteal', 'summon', 'bomb', 'trap', 'stun', 'dmgLostHp', 'poison']);
  const needsTarget = (card) => (card.eff || []).some((e) => e?.tgt === 'enemy' && TARGET_EFFECTS.has(e.k));
  const WEAPON_KEY = 'w';
  // Nature d'une carte : 'ap' (gain de PA), 'heal' (soin), 'buff' (sans cible : bouclier, buff…) ou 'dmg'.
  function cardKind(card) {
    const eff = card.eff || [];
    if (eff.some((e) => e?.k === 'apGain')) return 'ap';
    if (eff.some((e) => /heal/i.test(e?.k || '') && e.tgt !== 'enemy') && !eff.some((e) => e?.k === 'dmg')) return 'heal';
    if (!needsTarget(card)) return 'buff';
    return 'dmg';
  }
  const KIND_LABEL = { ap: '⚡ PA', heal: '💚 soin', buff: '🛡️ buff', dmg: '⚔️ dégâts' };
  // Réglage par défaut : gain de PA d'abord (100), buffs (90, relancés à la fin de leur durée), soins (80),
  // puis les dégâts selon leurs dégâts de base par PA (plafonnés à 79), l'arme à 30.
  function defaultWeight(card, weapon = false) {
    if (weapon) return { w: 30, every: 0 };
    const kind = cardKind(card);
    if (kind === 'ap') return { w: 100, every: 0 };
    if (kind === 'buff') return { w: 90, every: Math.max(0, ...(card.eff || []).map((e) => +e?.dur || 0)) };
    if (kind === 'heal') return { w: 80, every: 0 };
    const dmg = spellDamage(card);
    const ap = +card.ap || 0;
    return { w: Math.max(1, Math.min(79, Math.round(dmg && ap ? dmg.avg / ap : dmg?.avg || 10))), every: 0 };
  }
  const weightOf = (card, weapon = false) => {
    const own = cfg.cardWeights?.[weapon ? WEAPON_KEY : card.id];
    const def = defaultWeight(card, weapon);
    return { w: own?.w ?? def.w, every: own?.every ?? def.every, own: !!own };
  };

  // Identifiant d'onglet du jeu (sessionStorage « dofusmasters:onglet ») : le serveur refuse les actions d'un autre onglet.
  function gameTabId() {
    const k = 'dofusmasters:onglet';
    try {
      let id = sessionStorage.getItem(k);
      if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(k, id); }
      return id;
    } catch { return null; }
  }

  // Valeur RSC entièrement résolue (références « $id:chemin » remplacées), pour l'état initial du combat.
  function rscDeep(rows, v, depth = 0) {
    if (depth > 40) return v;
    v = rscResolve(rows, v);
    if (Array.isArray(v)) return v.map((x) => rscDeep(rows, x, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rscDeep(rows, x, depth + 1)]));
    return v === '$undefined' ? undefined : v;
  }

  // Prochaine action : la carte la plus lourde de la meilleure combinaison jouable, sinon fin du tour.
  function chooseFightAction(st, casts, blocked) {
    const p = st.fighters.p;
    const target = Object.values(st.fighters).filter((f) => f.team !== p.team && f.alive && f.id !== 'p')
      .sort((a, b) => a.hp - b.hp)[0];
    const lowHp = p.maxHp > 0 && (p.hp * 100) / p.maxHp < (+cfg.autoHealBelow || 0);
    const cards = (p.hand || []).map((uid) => p.cards?.[uid]).filter(Boolean).map((c) => ({ c, key: c.id, weapon: false }));
    if (p.weaponCard && !p.weaponUsed) cards.push({ c: p.weaponCard, key: WEAPON_KEY, weapon: true });
    const cand = [];
    for (const x of cards) {
      const { w, every } = weightOf(x.c, x.weapon);
      const ap = +x.c.ap || 0;
      if (!(w > 0) || ap > p.ap || p.sealed?.includes(x.c.uid) || blocked.has(x.c.uid)) continue;
      if (needsTarget(x.c) && !target) continue;
      if (cardKind(x.c) === 'heal' && !lowHp) continue;
      if (every > 0 && casts[x.key] != null && p.turnNo - casts[x.key] < every) continue;
      cand.push({ ...x, w, ap });
    }
    if (!cand.length) return { action: { type: 'end' }, label: 'fin du tour' };
    // meilleure combinaison (main de quelques cartes : on les essaie toutes) ; à égalité, la moins chère en PA
    let best = null;
    const n = Math.min(cand.length, 12);
    for (let m = 1; m < 1 << n; m++) {
      let w = 0, ap = 0;
      for (let i = 0; i < n; i++) if (m & (1 << i)) { w += cand[i].w; ap += cand[i].ap; }
      if (ap > p.ap) continue;
      if (!best || w > best.w || (w === best.w && ap < best.ap)) best = { m, w, ap };
    }
    const pick = cand.filter((_, i) => best.m & (1 << i)).sort((a, b) => b.w - a.w || b.ap - a.ap)[0];
    const tgt = needsTarget(pick.c) ? target.id : undefined;
    return { action: { type: 'play', card: pick.c.uid, target: tgt }, pick, label: `${pick.c.name}${tgt ? ` → ${target.name}` : ''}` };
  }

  // useGameAuto : sur cette page, on laisse l'Auto du jeu (état illisible, combat déjà en Auto, erreur…).
  let weightedBusy = false, useGameAuto = false;
  // État de départ du combat, capté par netwatch dans la réponse de lancement : évite de recharger /combat.
  let fightInit = null;
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.type !== 'dm-fight-init' || typeof e.data.json !== 'string') return;
    try { fightInit = { st: rscDeep({}, JSON.parse(e.data.json)), at: Date.now() }; } catch { return; }
    if (!weightsOn() || !isOwner()) return;
    // La boucle du pilote attend 3 s après chaque clic de lancement : on démarre le combat sans elle, dès que la page est
    // sur /combat (lancement depuis /aventure ou /chasse : le temps que le jeu y navigue).
    (async () => {
      for (let i = 0; i < 40 && !location.pathname.startsWith('/combat'); i++) await sleep(50);
      if (location.pathname.startsWith('/combat') && cfg.botFight && !weightedBusy && !useGameAuto && weightsOn() && isOwner()) weightedFight();
    })();
  });
  // ID de la server action du combat : gardé pour l'onglet ; relu dans les chunks seulement s'il est refusé.
  const FIGHT_ID_KEY = 'dmFightActionId';
  const cachedFightId = () => { try { return sessionStorage.getItem(FIGHT_ID_KEY) || FIGHT_ACTION_FALLBACK; } catch { return FIGHT_ACTION_FALLBACK; } };
  async function refreshFightId() {
    const id = await findAction((await fetchFlight('/combat')).chunks, 'fightAction', FIGHT_ACTION_FALLBACK);
    try { sessionStorage.setItem(FIGHT_ID_KEY, id); } catch { /* rien */ }
    return id;
  }
  // manual = { stop, status(texte) } : combat lancé à la main (Kralamoure…), joué par poids à la demande, sans le pilote.
  async function weightedFight(manual = null) {
    if (weightedBusy) return;
    weightedBusy = true;
    let reload = true;
    const fallback = (why) => {
      if (manual) { DM.log(`auto par poids (manuel) : ${why}`); manual.status(`⚠️ ${why}`); reload = false; return; }
      DM.log(`auto par poids : ${why} → Auto du jeu`); useGameAuto = true; reload = false;
    };
    const status = (t) => (manual ? manual.status(t) : setStatus(t));
    try {
      // état de départ : celui capté au lancement (récent), sinon la page /combat (toujours la page à la main :
      // des cartes ont pu être jouées depuis le lancement)
      let st = !manual && fightInit && Date.now() - fightInit.at < 60000 && fightInit.st?.status === 'ongoing' ? fightInit.st : null;
      fightInit = null;
      if (!st) {
        const { flight } = await fetchFlight('/combat');
        const { rows, props } = rscProps(flight, (x) => 'initial' in x && 'charId' in x);
        st = props && rscDeep(rows, props.initial);
      }
      if (!st?.fighters?.p) return fallback('état du combat introuvable');
      if (st.status !== 'ongoing') return;   // déjà fini : le rechargement affiche l'écran de fin
      if (st.auto) return fallback('combat déjà lancé en Auto');
      let actionId = cachedFightId(), idChecked = false;
      const tabId = gameTabId();
      // dernier tour où chaque carte a été jouée (règle « tous les X tours »), conservé pour ce combat
      const fightKey = `${st.kind}|${Object.values(st.fighters).filter((f) => f.id !== 'p').map((f) => `${f.name}:${f.maxHp}`).join(',')}`;
      let casts = {};
      try { const s = JSON.parse(sessionStorage.getItem('dmAutoCasts') || '{}'); if (s.key === fightKey) casts = s.casts || {}; } catch { /* rien */ }
      const keepCasts = () => { try { sessionStorage.setItem('dmAutoCasts', JSON.stringify({ key: fightKey, casts })); } catch { /* rien */ } };
      let blocked = new Set(), blockedTurn = null, errors = 0;
      for (let i = 0; i < 400 && st.status === 'ongoing'; i++) {
        if (manual ? manual.stop : !isOwner() || !cfg.botFight || !weightsOn()) { reload = false; return; }
        if (presenceDialog()) { reload = false; return; }
        if (st.currentId !== 'p') return fallback(`pas notre tour (${st.currentId})`);
        const p = st.fighters.p;
        if (blockedTurn !== p.turnNo) { blocked = new Set(); blockedTurn = p.turnNo; }
        const { action, pick, label } = chooseFightAction(st, casts, blocked);
        status(`Auto par poids : tour ${p.turnNo}, ${p.ap} PA — ${label}`);
        const lo = Math.max(0, +cfg.autoActMin || 0), hi = Math.max(lo, +cfg.autoActMax || 0);
        await sleep((lo + Math.random() * (hi - lo)) * 1000);
        let res;
        try {
          res = await callAction('combat', actionId, [action, tabId, st.seq]);
        } catch (e) {
          // ID périmé (nouveau déploiement du site) : relu une fois dans les chunks, puis on réessaie
          if (!e.game && !idChecked && (e.status === 404 || e.message === 'Réponse du serveur illisible')) {
            idChecked = true;
            actionId = await refreshFightId();
            continue;
          }
          if (!e.game || ++errors > 5) throw e;
          if (/aucun combat en cours/i.test(e.message)) return;
          DM.log(`auto par poids : « ${label} » refusé (${e.message})`);
          if (action.type === 'play') { blocked.add(action.card); continue; }
          return fallback(`fin de tour refusée (${e.message})`);
        }
        progress();
        if (res.wait) { await sleep(+res.wait + 100); continue; }
        if (res.presence) return;   // vérification de présence : la page rechargée l'affiche, le pilote la résout
        if (res.otherTab || !res.state) return fallback(`réponse inattendue (${Object.keys(res).join(', ')})`);
        if (pick) { casts[pick.key] = p.turnNo; keepCasts(); }
        st = res.state;
        if (res.rewards && st.status !== 'ongoing') dropOnRewards(res.rewards, `${st.kind}|${st.logCount}`);
      }
      if (st.status !== 'ongoing') DM.log(`auto par poids : combat ${st.status === 'won' ? 'gagné' : 'perdu'}`);
    } catch (e) {
      fallback(e.message);
    } finally {
      weightedBusy = false;
      // la page n'a rien vu de nos actions : on la recharge, elle affiche l'écran de fin (ou l'état à jour)
      if (reload && (manual || isOwner())) location.reload();
    }
  }

  // Bouton « 🎯 Jouer par poids » sur un combat lancé à la main (Kralamoure, faille, boss…) : le combat en cours est
  // joué avec les poids des cartes, comme l'Auto par poids du pilote, mais sans relance à la fin.
  let manualRun = null;
  function scanManualWeightsButton() {
    let b = document.querySelector('.dm-manual-weights');
    const show = location.pathname.startsWith('/combat') && modOn('weights') && !endTitle() && !(isOwner() && cfg.botFight)
      && !!document.querySelector('button') && !presenceDialog();
    if (!show && !manualRun) { b?.remove(); return; }
    if (b) return;
    b = document.createElement('button');
    b.type = 'button';
    b.className = 'dm-manual-weights';
    b.style.cssText = 'position:fixed;right:16px;bottom:80px;z-index:2147483000;max-width:min(360px,calc(100vw - 32px));padding:9px 14px;border-radius:10px;border:1px solid #c9a24a;background:#2a231a;color:#f0d78c;font:700 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 16px #000a;text-align:left';
    b.textContent = '🎯 Jouer ce combat par poids';
    b.title = 'Autopilot-DM : joue ce combat avec les poids des cartes (🎯 Poids des cartes), sans animation. Recliquer pour arrêter. La page se recharge à la fin.';
    b.addEventListener('click', () => {
      if (manualRun) { manualRun.stop = true; b.textContent = 'Arrêt…'; return; }
      if (weightedBusy) return;
      manualRun = { stop: false, status: (t) => { b.textContent = `■ ${t}`; } };
      b.textContent = '■ Lecture du combat…';
      weightedFight(manualRun).finally(() => {
        manualRun = null;
        if (b.isConnected && !b.textContent.startsWith('■ ⚠️')) b.textContent = '🎯 Jouer ce combat par poids';
        else if (b.isConnected) setTimeout(() => { if (!manualRun) b.textContent = '🎯 Jouer ce combat par poids'; }, 6000);
      });
    });
    document.body.appendChild(b);
  }

  // Écran de réglage : poids des cartes du deck actif (+ arme), soins et rythme.
  async function openCardWeights() {
    document.querySelector('.dm-picker')?.remove();
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const ov = document.createElement('div');
    ov.className = 'dm-picker';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:#000a;display:grid;justify-items:center;align-items:start;padding:4vh 16px 16px;font:13px system-ui,sans-serif;color:#eee';
    ov.innerHTML = '<div style="background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:16px">Lecture de ton deck…</div>';
    document.body.appendChild(ov);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => e.stopPropagation());

    // toute la collection (une entrée par carte) + la composition de chaque deck
    let all, decks, active;
    try {
      const { flight } = await fetchFlight('/deck');
      const { rows, props } = rscProps(flight, (x) => Array.isArray(x.collection) && 'initialDecks' in x);
      if (!props) throw new Error('Deck introuvable sur /deck');
      const res = (v) => rscResolve(rows, v);
      active = +res(props.initialActive) || 0;
      decks = (res(props.initialDecks) || []).map((d) => (res(d) || []).map((k) => +String(k).split(':')[0]));
      const byId = new Map();
      for (const raw of props.collection) {
        const card = rscDeep(rows, res(raw)?.card);
        if (card?.id && !byId.has(card.id)) byId.set(card.id, { ...card, name: card.n });
      }
      all = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    } catch (e) {
      ov.firstElementChild.textContent = `❌ ${e.message}`;
      return;
    }
    const WEAPON = { id: WEAPON_KEY, name: 'Arme équipée', ap: '—', eff: [] };
    const inp = 'background:#2a231a;border:1px solid #5a4a33;border-radius:8px;color:#eee;padding:4px 6px;font:13px system-ui,sans-serif;width:64px';
    const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:5px 10px;color:#fff;cursor:pointer;font:600 12px system-ui,sans-serif;background:#2a231a';
    ov.innerHTML = `
      <div style="width:min(640px,100%);max-height:90vh;display:flex;flex-direction:column;gap:10px;background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:14px;box-shadow:0 10px 40px #000">
        <div style="display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:15px">🎯 Poids des cartes${DM.tip('Utilisé par le mode de combat « Auto par poids ». À chaque action, le pilote garde la combinaison de cartes jouables qui tient dans tes PA avec le plus gros total de poids, et joue la plus lourde en premier. 0 = jamais jouée. « Tous les » : au plus une fois tous les N tours (buffs qui durent) ; vide ou 0 = dès que possible. Les réglages sont par carte : ils suivent la carte si tu changes de deck.')}</b><button data-a="reset" style="${btn}" data-tip="Remet les cartes affichées (et l’arme) aux valeurs par défaut : gain de PA 100, buffs 90 (relancés à la fin de leur durée), soins 80, dégâts selon leurs dégâts de base par PA, arme 30.">↺ Par défaut</button><button data-a="x" style="${btn};background:transparent">✕</button></div>
        <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;font-size:12px;color:#b9a98c">
          <label data-tip="Les cartes de soin ne sont jouées que si tes PV sont sous ce pourcentage.">Soigner sous <input data-o="autoHealBelow" type="number" min="0" max="100" style="${inp}"> % PV</label>
          <label data-tip="Pause aléatoire entre deux actions (carte ou fin de tour), en secondes.">Entre deux actions <input data-o="autoActMin" type="number" min="0" step="0.1" style="${inp}"> à <input data-o="autoActMax" type="number" min="0" step="0.1" style="${inp}"> s</label>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center" data-k="tabs"></div>
        <input data-k="q" placeholder="Rechercher une carte…" style="${inp};width:100%;display:none">
        <div style="overflow-y:auto;display:flex;flex-direction:column;gap:4px" data-k="list"></div>
        <div style="font-size:12px;color:#b9a98c">Mode de combat actuel : <b data-k="engine"></b> (menu 🤖 → Activité → Combat).</div>
      </div>`;
    const $ = (q) => ov.querySelector(q);
    let view = active;   // n° de deck affiché, ou 'all' (toute la collection)
    const byId = new Map(all.map((c) => [c.id, c]));
    const shown = () => {
      if (view === 'all') {
        const q = normName($('[data-k="q"]').value);
        return all.filter((c) => !q || normName(c.name).includes(q));
      }
      return [...new Set(decks[view] || [])].map((id) => byId.get(id)).filter(Boolean);
    };
    const render = () => {
      $('[data-k="engine"]').textContent = cfg.fightEngine === 'weights' ? 'Auto par poids' : 'Auto du jeu';
      for (const el of ov.querySelectorAll('[data-o]')) el.value = cfg[el.dataset.o] ?? '';
      $('[data-k="tabs"]').innerHTML = decks.map((d, i) => `<button data-v="${i}" style="${btn};${view === i ? 'background:#2e6fbf' : ''}"${d.length ? '' : ' disabled'}>Deck ${i + 1}${i === active ? ' ★' : ''}</button>`).join('')
        + `<button data-v="all" style="${btn};${view === 'all' ? 'background:#2e6fbf' : ''}">Toute la collection (${all.length})</button>`;
      $('[data-k="q"]').style.display = view === 'all' ? '' : 'none';
      const list = shown();
      $('[data-k="list"]').innerHTML = (list.length ? [...list, WEAPON] : []).map((c) => {
        const weapon = c === WEAPON;
        const { w, every, own } = weightOf(c, weapon);
        const kind = weapon ? '🗡️ arme' : KIND_LABEL[cardKind(c)];
        return `<div style="display:flex;align-items:center;gap:8px;background:#241e16;border:1px solid #3a3024;border-radius:8px;padding:5px 8px">
          <span style="flex:1;min-width:0"><b>${esc(c.name)}</b> <span style="color:#b9a98c;font-size:12px">· ${esc(c.ap)} PA · ${kind}${own ? '' : ' · défaut'}</span></span>
          <label style="font-size:12px;color:#b9a98c">Poids <input data-w="${esc(c.id)}" type="number" min="0" max="100" value="${w}" style="${inp}"></label>
          <label style="font-size:12px;color:#b9a98c">tous les <input data-e="${esc(c.id)}" type="number" min="0" max="20" value="${every || ''}" placeholder="—" style="${inp};width:52px"> tours</label>
        </div>`;
      }).join('') || '<div style="color:#b9a98c">Aucune carte.</div>';
    };
    render();
    DM.installTips(ov);
    $('[data-k="q"]').addEventListener('input', render);
    const setCard = (id, patch) => {
      const w = { ...(cfg.cardWeights || {}) };
      const card = id === WEAPON_KEY ? WEAPON : byId.get(+id);
      const cur = weightOf(card, id === WEAPON_KEY);
      w[id] = { w: cur.w, every: cur.every, ...patch };
      save({ cardWeights: w });
    };
    ov.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.w) setCard(t.dataset.w, { w: Math.max(0, Math.min(100, Math.round(+t.value || 0))) });
      else if (t.dataset.e) setCard(t.dataset.e, { every: Math.max(0, Math.min(20, Math.round(+t.value || 0))) });
      else if (t.dataset.o) save({ [t.dataset.o]: Math.max(0, +t.value || 0) });
      else return;
      render();
    });
    ov.addEventListener('click', (e) => {
      const v = e.target.closest('[data-v]')?.dataset.v;
      if (v != null) { view = v === 'all' ? 'all' : +v; render(); if (view === 'all') $('[data-k="q"]').focus(); return; }
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'x') close();
      if (a === 'reset') {   // cartes affichées (deck ou collection) + arme
        const w = { ...(cfg.cardWeights || {}) };
        for (const c of shown()) delete w[c.id];
        delete w[WEAPON_KEY];
        save({ cardWeights: w });
        render();
      }
    });
  }

  // Bouton « 🎯 Poids des cartes » sur la page /deck (module Auto par poids).
  function scanDeckButton() {
    let b = document.querySelector('.dm-deck-weights');
    if (!location.pathname.startsWith('/deck') || !modOn('weights')) { b?.remove(); return; }
    if (b) return;
    b = document.createElement('button');
    b.type = 'button';
    b.className = 'dm-deck-weights';
    b.textContent = '🎯 Poids des cartes';
    b.title = 'Autopilot-DM : priorité de chaque carte pour l’Auto par poids';
    b.style.cssText = 'position:fixed;right:16px;bottom:80px;z-index:2147483000;padding:9px 14px;border-radius:10px;border:1px solid #c9a24a;background:#2a231a;color:#f0d78c;font:700 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 16px #000a';
    b.addEventListener('click', () => openCardWeights());
    document.body.appendChild(b);
  }

  // ---------- Bouton ▶ / ⏸ (au-dessus de la bulle 🤖) ----------
  // ▶ : le pilote démarre sur cet onglet et relance en boucle le combat de la page : zone de chasse (/chasse?zone=…),
  // aventure, ascension ; sur /combat, le type du combat est lu dans la page (onPath, onAscension, huntZone). Un combat
  // qui ne se relance pas (boss de chasse, Kralamoure…) : rien ne démarre. Autre page : l'activité choisie dans le menu.
  // ⏸ : arrêt du pilote.
  async function playContext() {
    const p = location.pathname, zone = +new URLSearchParams(location.search).get('zone');
    const zoneName = (z) => (cfg.huntZones || []).find((x) => x.id === z)?.name || (location.pathname.startsWith('/chasse') && document.querySelector('h1')?.textContent.trim()) || `Zone ${z}`;
    if (p.startsWith('/chasse')) return zone ? { mode: 'chasse', huntZone: zone, huntZoneName: zoneName(zone), huntGroup: null, huntTarget: null } : { error: 'choisis d’abord une zone de chasse' };
    if (p.startsWith('/aventure')) return { mode: 'aventure' };
    if (p.startsWith('/ascension')) return { mode: 'ascension' };
    if (p.startsWith('/combat')) {
      const { flight } = await fetchFlight('/combat');
      const props = rscProps(flight, (x) => 'charId' in x && 'onPath' in x).props;
      if (!props) return { error: 'combat illisible' };
      if (+props.huntZone) return { mode: 'chasse', huntZone: +props.huntZone, huntZoneName: zoneName(+props.huntZone), huntGroup: null, huntTarget: null };
      if (props.onAscension) return { mode: 'ascension' };
      if (props.onPath) return { mode: 'aventure' };
      return { error: 'ce combat (boss de chasse, Kralamoure…) ne se relance pas — pour le jouer : 🎯 Jouer ce combat par poids' };
    }
    return {};
  }
  let playBusy = false;
  async function onPlayPause() {
    if (playBusy) return;
    if (cfg.enabled && isOwner()) { send({ type: 'toggle', fromPage: true }).catch(() => {}); return; }   // ⏸
    playBusy = true;
    try {
      const ctx = await playContext();
      if (ctx.error) { tradeToast(`▶ ${ctx.error}`, 'err'); return; }
      if (dropOn() && ctx.mode) await dropStop('remplacé par ▶ sur une autre activité');
      await save({ ...ctx, pauseReason: null, lossStreak: 0 });
      await send({ type: 'claim', start: true, status: 'Démarrage…' }).catch(() => {});
      // combat en cours sur la page : le pilote le prend en main (Auto du jeu ou par poids), puis relance en boucle
      if (location.pathname.startsWith('/combat') && !endTitle()) { lastAutoClick = 0; await save({ botFight: true }); markLaunch(); }
      tradeToast(`▶ Pilote : ${DM.modeLabel(cfg)}`, 'ok');
    } catch (e) {
      tradeToast(`▶ ${e.message}`, 'err');
    } finally {
      playBusy = false;
    }
  }

  // ---------- Bulle en bas à gauche + menu (pilote, chasse, autosell) ----------
  // Shadow DOM : le CSS du site (Tailwind) ne déteint pas sur le menu, et inversement.
  const MENU_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, sans-serif; }
    .bubble { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; width: 44px; height: 44px; border-radius: 50%;
      display: grid; place-items: center; font-size: 22px; cursor: pointer; user-select: none;
      background: #262a31; border: 3px solid var(--st, #666); box-shadow: 0 2px 10px rgba(0,0,0,.5); transition: transform .15s; }
    .bubble:hover { transform: scale(1.08); }
    .bubble.play { bottom: 64px; left: 16px; width: 36px; height: 36px; font-size: 15px; border-width: 2px; color: #fff; }
    .panel:not([hidden]) ~ .bubble.play { display: none; }
    .bubble.fav { left: 64px; width: 36px; height: 36px; bottom: 16px; font-size: 16px; border-width: 2px; border-color: #c0485a; }
    .panel { position: fixed; left: 12px; bottom: 64px; z-index: 2147483647; width: 290px; max-width: calc(100vw - 24px);
      max-height: calc(100vh - 80px); overflow-y: auto; background: #1b1d22; color: #e8e6e1;
      border: 1px solid #3a3f48; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.55);
      font-size: 13px; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
    .panel[hidden], .row[hidden] { display: none; }
    .sec { background: #262a31; border-radius: 8px; padding: 9px; display: flex; flex-direction: column; gap: 7px; }
    .head { display: flex; justify-content: space-between; align-items: center; font-weight: 700; }
    .muted { color: #9aa0a8; font-size: 12px; font-weight: 400; }
    .status { font-size: 12px; overflow-wrap: anywhere; }
    button { border: 0; border-radius: 6px; padding: 7px 9px; font-weight: 600; font-size: 13px; cursor: pointer;
      color: #fff; background: #3a3f48; }
    button:hover:not(:disabled) { filter: brightness(1.15); }
    button:disabled { opacity: .6; cursor: default; }
    .seg { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px; }
    .seg button.on { background: #2e6fbf; }
    select { width: 100%; background: #14161a; color: #e8e6e1; border: 1px solid #3a3f48; border-radius: 5px; padding: 5px; font-size: 13px; }
    .num { width: 56px; background: #14161a; color: #e8e6e1; border: 1px solid #3a3f48; border-radius: 5px; padding: 4px; font-size: 12px; }
    .row { display: flex; gap: 4px; }
    .row select { flex: 1; min-width: 0; }
    .ok { color: #6fcf7a; } .err { color: #ff7b6b; }
    summary { cursor: pointer; }
    .check { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
    .rars { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; margin-bottom: 4px; }
    .locks { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; max-height: 160px; overflow-y: auto; }
    .locks li { display: flex; justify-content: space-between; align-items: center; gap: 6px; font-size: 12px; }
    .locks button { padding: 1px 7px; font-size: 12px; background: transparent; color: #9aa0a8; }
    .wanted { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
    .wanted li { background: #1b1d22; border: 1px solid #5a4a20; border-radius: 6px; padding: 5px 7px; font-size: 12px; cursor: pointer;
      display: flex; align-items: center; gap: 7px; }
    .wanted li img { width: 34px; height: 34px; object-fit: contain; flex: none; }
    .wanted li:hover { border-color: #e0b040; }
    .wanted li.old { opacity: .5; }
    .wanted b { color: #e0b040; }
    .fuse { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; }
    .fuse li { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 12px;
      background: #1b1d22; border: 1px solid #3a3f48; border-radius: 6px; padding: 5px 7px; }
    .fuse li b { color: #e0b040; }
    .fuse button { padding: 3px 8px; font-size: 12px; flex: none; background: #8a6a1a; }
    .eqstats { display: grid; grid-template-columns: auto 1fr; gap: 4px 6px; align-items: center; font-size: 12px; }
    .eqstats b { color: #e0b040; text-align: center; }
    .eqslots { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
    .eqslots.dofus { grid-template-columns: repeat(6, 1fr); }
    .eqslot { display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 4px 1px; border-radius: 7px;
      background: #1b1d22; border: 1px solid #3a3f48; font-size: 9.5px; font-weight: 600; color: #9aa0a8; min-width: 0; }
    .eqslot span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .eqslot.on { border-color: #e0b040; color: #e8e6e1; background: #2b2618; }
    .eqslot img { width: 26px; height: 26px; object-fit: contain; }
    .eqslot .em { font-size: 17px; line-height: 26px; }
    .eqslot:not(.on) img, .eqslot:not(.on) .em { opacity: .3; filter: grayscale(1); }
    .eqslot.chg { box-shadow: 0 0 0 2px #2e9e44 inset; }
    .eqplan { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; max-height: 220px; overflow-y: auto; }
    .eqplan li { background: #1b1d22; border: 1px solid #3a3f48; border-radius: 6px; padding: 4px 7px; font-size: 12px; }
    .eqplan .up { color: #6fcf7a; } .eqplan .down { color: #ff7b6b; }
  `;
  const ST_COLOR = { off: '#666', on: '#2e9e44', pause: '#d18b00', other: '#2e6fbf' };

  let ui = null, sellArmed = null, sellBusy = false, sellResetTimer;
  const fmtK = (n) => (n || 0).toLocaleString('fr-FR');
  const SELL_LABEL = 'Vendre l’inventaire';

  function buildUi() {
    const host = document.createElement('div');
    host.id = 'dm-pilot-ui';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${MENU_CSS}</style>
      <div class="panel" hidden>
        <div class="sec">
          <div class="head"><span>🤖 Pilote auto${DM.tip("Démarre ou arrête le pilote sur cet onglet. Il enchaîne les combats en Auto selon l’activité choisie ci-dessous. Compteur : victoires / défaites du pilote.")}</span><span class="muted" data-k="stats"></span></div>
          <div class="status" data-k="status"></div>
          <button data-k="toggle"></button>
          <div data-k="dropBox" class="muted" style="display:none;flex-direction:column;gap:3px;border:1px solid #6a3fa0;border-radius:6px;padding:6px">
            <div data-k="dropInfo"></div>
            <button data-k="dropStop" style="padding:2px 7px;font-size:12px" data-tip="Arrête le farm de drop (le pilote s’arrête aussi).">■ Arrêter le farm</button>
          </div>
          <details data-k="timesBox">
            <summary class="muted">⏱ Chronomètre des combats${DM.tip("Durée moyenne d’un combat du pilote (du lancement à l’écran de fin) et de la boucle complète (d’un lancement au suivant, pauses de plus de 5 min exclues), par activité et par mode de combat. Pour comparer l’Auto du jeu et l’Auto par poids sur la durée.")}</summary>
            <div class="muted" data-k="times" style="display:flex;flex-direction:column;gap:3px;margin-top:4px"></div>
            <button data-k="timesReset" style="padding:2px 7px;font-size:12px;margin-top:4px" data-tip="Remet le chronomètre à zéro.">↺ Remettre à zéro</button>
          </details>
        </div>
        <div class="sec">
          <div class="head"><span>🗺️ Activité${DM.tip("Aventure : étapes du Chemin.\nChasse : refait en boucle un groupe d’une zone.\nAscension : étages de boss (niveau 200).\nÀ droite : ta dernière énergie connue.")}</span><span class="muted" data-k="energy"></span></div>
          <div class="seg">
            <button data-mode="aventure">Aventure</button>
            <button data-mode="chasse">Chasse</button>
            <button data-mode="ascension" data-tip="Étages de boss, débloqué au niveau 200">Ascension</button>
          </div>
          <div data-k="zoneBox">
            <div class="muted" style="margin-bottom:4px">Zone${DM.tip("Zone farmée en mode Chasse (zones à ton niveau). Par défaut le pilote attaque le groupe le plus dur ; si tu attaques toi-même un groupe, c’est celui-là qui est relancé.")}</div>
            <div class="row"><select data-k="zone"></select><button data-k="reload" data-tip="Recharger la liste des zones depuis le jeu.">↻</button></div>
            <div class="row" style="align-items:center;justify-content:space-between;margin-top:5px">
              <span class="muted" data-k="groupInfo"></span>
              <button data-k="groupReset" data-tip="Oublier le groupe choisi à la main et revenir au groupe le plus dur de la zone." style="padding:2px 7px;font-size:12px">↺ plus dur</button>
            </div>
            <div class="muted" style="margin-top:4px">Astuce : clique toi-même sur « Attaquer » dans n’importe quelle zone, le pilote relancera ce groupe en Auto.</div>
          </div>
          <div data-mod="weights">
          <div class="muted" style="margin:6px 0 4px">Combat${DM.tip("Auto du jeu : le bouton Auto du site (animations à vitesse ×1).\nAuto par poids : le pilote joue lui-même les cartes selon tes poids (🎯), sans animation, avec une courte pause entre deux actions. Récompenses entières, comme l’Auto du jeu.")}</div>
          <div class="seg" style="grid-template-columns:1fr 1fr">
            <button data-engine="game">Auto du jeu</button>
            <button data-engine="weights">Auto par poids</button>
          </div>
          <button data-k="weights" style="margin-top:4px;width:100%" data-tip="Régler la priorité de chaque carte (decks et collection) pour l’Auto par poids.">🎯 Poids des cartes</button>
          </div>
        </div>
        <div class="sec" data-mod="autosell">
          <div class="head"><span>🧹 Autosell${DM.tip("Vend au marchand, en un clic, tous les objets non équipés sauf ceux que tu conserves. 1er clic : aperçu ; 2e clic dans les 8 s : vente.")}</span></div>
          <div class="muted">Vend les objets non équipés (familiers, dofus, Rayonnants et objets 🔒 conservés).</div>
          <label class="check"><input type="checkbox" data-k="keepAbove"> Garder les objets au-dessus de mon niveau${DM.tip("Ne vend pas les objets d’un niveau supérieur à ton personnage : tu pourras les porter plus tard.")}</label>
          <div class="muted" style="margin-top:4px">Garder les raretés :${DM.tip("Les objets des raretés cochées ne sont jamais vendus par l’Autosell.")}</div>
          <div class="rars">${DM.RARITIES.map((n, i) => `<label class="check"><input type="checkbox" data-k="rar${i}"> ${n}</label>`).join('')}</div>
          <button data-k="sell">${SELL_LABEL}</button>
          <div class="status" data-k="sellMsg"></div>
          <details data-k="lockBox">
            <summary class="muted"><span data-k="lockTitle"></span>${DM.tip("Objets protégés de l’Autosell. Pour en ajouter : ouvre un objet dans /inventaire et clique « 🔓 Verrouiller ». ✕ pour déverrouiller.")}</summary>
            <ul class="locks" data-k="locks"></ul>
          </details>
        </div>
        <div class="sec" data-mod="fusion">
          <div class="head"><span>✨ Fusion${DM.tip("3 exemplaires d’un même objet au même tier → 1 exemplaire du tier suivant (+10 % de stats), jusqu’au tier Rayonnant. Les objets portés ne sont pas touchés.")}</span><span class="muted">3 identiques → tier +1</span></div>
          <div class="row">
            <button data-k="fuseScan" style="flex:1" data-tip="Liste les objets que tu peux fusionner, avec le résultat des fusions en cascade.">Chercher les doublons</button>
            <button data-k="fuseAll" data-tip="Fusionne tout ce qui est listé, en cascade (3 base → 1 T2, 3 T2 → 1 T3…).">Tout fusionner</button>
          </div>
          <div class="status" data-k="fuseMsg"></div>
          <ul class="fuse" data-k="fuseList"></ul>
        </div>
        <div class="sec" data-mod="equip">
          <div class="head"><span>🛡️ Auto-équipement${DM.tip("Équipe automatiquement les meilleurs objets de ton inventaire selon jusqu’à 5 caractéristiques par ordre de priorité. La 1re compte pleinement, la 2e pour 35 %, la 3e pour 15 %, puis les 4e et 5e (facultatives) pour 8 % et 4 % : elles départagent les objets proches. Un emplacement vide est toujours rempli, même par un objet sans ces stats. Chaque stat est comparée au meilleur objet du même type (ex. meilleur chapeau). Les bonus de panoplie ne sont pas pris en compte.")}</span></div>
          <div class="seg eqmode">
            <button data-eqmode="off" data-tip="Pas de vérification automatique : utilise Aperçu / Équiper ci-dessous.">Off</button>
            <button data-eqmode="semi" data-tip="Régulièrement (toutes les 3 min par défaut, réglable dans la popup de l’extension → Réglages), vérifie l’inventaire. Si un objet ferait mieux, une fenêtre le propose avec l’écart de stats : ✔ pour l’équiper, ✖ pour ne plus jamais le proposer.">Semi</button>
            <button data-eqmode="auto" data-tip="Régulièrement (toutes les 3 min par défaut, réglable dans la popup → Réglages), équipe directement les meilleurs objets (hors objets refusés en mode Semi).">Auto</button>
          </div>
          <div class="row" style="align-items:center;justify-content:space-between" data-k="eqDeclBox">
            <span class="muted" data-k="eqDecl"></span>
            <button data-k="eqDeclReset" data-tip="Oublier les objets refusés : ils pourront de nouveau être proposés." style="padding:2px 7px;font-size:12px">↺ Oublier</button>
          </div>
          <div class="eqstats">
            ${[1, 2, 3, 4, 5].map((n) => `<b>${n}</b><select data-k="eqS${n}"></select>`).join('')}
          </div>
          <div class="muted">Emplacements à optimiser${DM.tip("Clique sur un emplacement pour l’activer ou le désactiver. Un emplacement désactivé (grisé) garde son objet actuel. Les icônes des objets portés s’affichent après un aperçu ; un contour vert = l’objet de cet emplacement va changer.")}</div>
          <div class="eqslots" data-k="eqSlots"></div>
          <div class="eqslots dofus" data-k="eqDofus"></div>
          <div class="row">
            <button data-k="eqPreview" style="flex:1" data-tip="Calcule le meilleur équipement sans rien changer : liste des objets qui seraient équipés, avec l’écart sur tes caractéristiques.">🔍 Aperçu</button>
            <button data-k="eqGo" data-tip="Équipe les objets de l’aperçu (recalculé juste avant, au cas où ton inventaire a changé).">✅ Équiper</button>
          </div>
          <div class="status" data-k="eqMsg"></div>
          <ul class="eqplan" data-k="eqPlan"></ul>
        </div>
        <div class="sec" data-mod="tools">
          <div class="head"><span>📚 Tierlist des sorts${DM.tip("Classe tous tes sorts à dégâts : dégâts totaux (toutes lignes et éléments additionnés), dégâts par PA ou coût en PA, avec filtres cible unique / zone et par élément. Le cadenas met un sort en favori sur le site.")}</span></div>
          <div class="row"><button data-k="spells" data-mod="spells" style="flex:1">Ouvrir la tierlist</button><button data-k="build" data-mod="build" style="flex:1" data-tip="Cherche l’équipement qui maximise tes dégâts sur un tour (sorts, PA, panoplies, prestige ; HDV en option).">🧬 Optimiser mon build</button></div>
        </div>
        <div class="sec" data-mod="wanted">
          <div class="head"><span>🎯 Avis de recherche${DM.tip("Parcourt toutes les zones de chasse et repère les groupes contenant des monstres recherchés. Chaque trouvaille s’affiche ici et peut être envoyée sur Discord.")}</span><span class="muted" data-k="scanAge"></span></div>
          <div class="row">
            <button data-k="scan" style="flex:1" data-tip="Scanne toutes les zones dans la plage de niveaux choisie (les groupes changent toutes les ~3 min).">Scanner les zones</button>
            <button data-k="scanResume" data-tip="Ne rescanne que les zones en échec lors du dernier scan.">Reprendre</button>
          </div>
          <div class="row" style="align-items:center;gap:6px;font-size:12px">
            <span class="muted">Niveaux${DM.tip("Ne scanne que les zones dont les niveaux croisent cette plage. Vide = pas de limite.")}</span>
            <input type="number" data-k="lvlMin" min="0" max="200" placeholder="min" class="num">
            <span class="muted">à</span>
            <input type="number" data-k="lvlMax" min="0" max="200" placeholder="max" class="num">
            <span class="muted" style="margin-left:auto">plus hauts d’abord</span>
          </div>
          <div class="row" style="align-items:center;gap:6px;font-size:12px">
            <span class="muted">Au moins${DM.tip("Ne garde que les groupes contenant au moins ce nombre de monstres recherchés : plusieurs avis dans le même combat.")}</span>
            <input type="number" data-k="minPerGroup" min="1" max="8" class="num">
            <span class="muted">avis dans le même combat</span>
          </div>
          <label class="check"><input type="checkbox" data-k="wantedLoop"> Scanner en continu (à chaque renouvellement des groupes)${DM.tip("Relance automatiquement un scan juste après chaque renouvellement des groupes, tant que l’onglet reste ouvert.")}</label>
          <div class="status" data-k="scanMsg"></div>
          <ul class="wanted" data-k="wanted"></ul>
        </div>
      </div>
      <div class="bubble" title="Autopilot-DM">🤖</div>
      <div class="bubble fav" data-mod="build" title="Favoris : builds enregistrés et objets à looter">❤️</div>
      <div class="bubble play" data-k="play"></div>`;
    DM.installTips(root);
    const $ = (k) => root.querySelector(`[data-k="${k}"]`);
    const panel = root.querySelector('.panel');
    const bubble = root.querySelector('.bubble');
    root.querySelector('.bubble.fav').addEventListener('click', () => { setOpen(false); openFavorites(); });
    root.querySelector('.bubble.play').addEventListener('click', onPlayPause);

    // Ouverture du panneau mémorisée pour l'onglet : il reste ouvert après les rechargements de l'avance rapide.
    const setOpen = (open) => {
      panel.hidden = !open;
      try { sessionStorage.setItem('dmPanelOpen', open ? '1' : ''); } catch {}
      if (open) renderUi();
    };
    try { panel.hidden = !sessionStorage.getItem('dmPanelOpen'); } catch {}
    bubble.addEventListener('click', () => setOpen(panel.hidden));
    // Fermeture : clic de l'utilisateur ailleurs sur la page (pas les clics du pilote) ou Échap.
    document.addEventListener('click', (e) => { if (e.isTrusted && !e.composedPath().includes(host)) setOpen(false); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

    $('toggle').addEventListener('click', () => send({ type: 'toggle', fromPage: true }).catch(() => {}));
    for (const b of root.querySelectorAll('[data-mode]')) {
      b.addEventListener('click', async () => {
        await save({ mode: b.dataset.mode });
        renderUi();
        if (b.dataset.mode === 'chasse' && !cfg.huntZones?.length) await loadZones();
      });
    }
    $('zone').addEventListener('change', () => {
      const id = +$('zone').value;
      if (!id) return;
      const z = (cfg.huntZones || []).find((x) => x.id === id);
      save({ huntZone: id, huntZoneName: z?.name || $('zone').selectedOptions[0].text, huntGroup: null });
    });
    $('groupReset').addEventListener('click', () => save({ huntGroup: null }));
    $('reload').addEventListener('click', loadZones);
    $('sell').addEventListener('click', onSell);
    $('keepAbove').addEventListener('change', () => { disarmSell(); setSellMsg(''); save({ sellKeepAbove: $('keepAbove').checked }); });
    DM.RARITIES.forEach((_, i) => $(`rar${i}`).addEventListener('change', () => {
      disarmSell(); setSellMsg('');
      save({ sellKeepRarities: DM.RARITIES.map((__, j) => j).filter((j) => $(`rar${j}`).checked) });
    }));
    $('fuseScan').addEventListener('click', () => scanFusions());
    $('spells').addEventListener('click', () => { setOpen(false); openSpellList(); });
    $('timesReset').addEventListener('click', () => save({ fightTimes: {} }));
    $('dropStop').addEventListener('click', () => dropStop('arrêté à la main'));
    $('weights').addEventListener('click', () => { setOpen(false); openCardWeights(); });
    for (const b of root.querySelectorAll('[data-engine]')) {
      b.addEventListener('click', async () => { await save({ fightEngine: b.dataset.engine }); renderUi(); });
    }
    $('build').addEventListener('click', () => { setOpen(false); openBuildOptimizer(); });
    $('fuseAll').addEventListener('click', () => runFusions(fuseList || []));
    $('fuseList').addEventListener('click', (e) => {
      const id = +e.target.closest('button[data-fuse]')?.dataset.fuse;
      const it = id && fuseList?.find((x) => x.id === id);
      if (it) runFusions([it]);
    });
    $('scan').addEventListener('click', () => { if (scanRunning) scanStop = true; else runScan(false); renderUi(); });
    $('scanResume').addEventListener('click', () => runScan(true));
    $('wantedLoop').addEventListener('change', () => save({ wantedLoop: $('wantedLoop').checked }));
    // Appliqué aussitôt à la liste affichée (le scan garde tous les groupes) et aux prochaines notifications.
    $('minPerGroup').addEventListener('change', () => {
      if (!scanRunning) scanMsg = '';   // le compteur « N avis trouvé(s) » est recalculé avec le nouveau seuil
      save({ wantedMinPerGroup: Math.max(1, Math.min(8, Math.round(+$('minPerGroup').value || 1))) }).then(renderUi);
    });
    for (const k of ['lvlMin', 'lvlMax']) {
      $(k).addEventListener('change', () => {
        const v = Math.max(0, Math.min(200, Math.round(+$(k).value || 0)));
        save({ [k === 'lvlMin' ? 'wantedLvlMin' : 'wantedLvlMax']: v });   // pris en compte au prochain scan
      });
    }
    $('wanted').addEventListener('click', (e) => {
      const href = e.target.closest('li[data-href]')?.dataset.href;
      if (href) location.assign(href);   // avis encore valable : attaque directe en pilote auto ; sinon ouverture de la zone
    });
    $('locks').addEventListener('click', (e) => {
      const k = e.target.closest('button[data-unlock]')?.dataset.unlock;
      if (!k) return;
      const lockedItems = { ...(cfg.lockedItems || {}) };
      delete lockedItems[k];
      save({ lockedItems });
    });

    for (const n of [1, 2, 3, 4, 5]) {
      const sel = $(`eqS${n}`);
      sel.add(new Option(n === 1 ? '— choisir —' : '— aucune —', ''));
      for (const k of STAT_ORDER) sel.add(new Option(STAT_LABELS[k] || k, k));
      sel.addEventListener('change', () => {
        const stats = [1, 2, 3, 4, 5].map((i) => $(`eqS${i}`).value);
        eqPlanState = null;
        save({ equipStats: stats }).then(renderUi);
      });
    }
    const onSlotClick = (e) => {
      const b = e.target.closest('button[data-eqslot]');
      if (!b || equipBusy) return;
      const slots = { ...(cfg.equipSlots || {}) };
      slots[b.dataset.eqslot] = slots[b.dataset.eqslot] === false;
      eqPlanState = null;
      save({ equipSlots: slots }).then(renderUi);
    };
    $('eqSlots').addEventListener('click', onSlotClick);
    $('eqDofus').addEventListener('click', onSlotClick);
    for (const b of root.querySelectorAll('[data-eqmode]')) {
      b.addEventListener('click', async () => {
        await save({ equipAuto: b.dataset.eqmode });
        renderUi();
        if (b.dataset.eqmode !== 'off') autoEquipTick(true);   // première vérification tout de suite
      });
    }
    $('eqDeclReset').addEventListener('click', async () => {
      const equipDeclined = { ...(cfg.equipDeclined || {}) };
      delete equipDeclined[eqAcct()];
      eqSnooze.clear();
      await save({ equipDeclined });
      renderUi();
    });
    $('eqPreview').addEventListener('click', () => previewEquip());
    $('eqGo').addEventListener('click', () => applyEquip());

    document.body.appendChild(host);
    return { host, root, panel, bubble, $ };
  }

  async function loadZones() {
    ui.$('reload').disabled = true;
    try { cfg.huntZones = await DM.fetchZones(); } catch (e) { setSellMsg(`Zones de chasse : ${e.message}`, 'err'); }
    ui.$('reload').disabled = false;
    renderUi();
  }

  function setSellMsg(text, cls = '') {
    const el = ui.$('sellMsg');
    el.textContent = text;
    el.className = `status ${cls}`;
  }

  function disarmSell() {
    clearTimeout(sellResetTimer);
    sellArmed = null;
    ui.$('sell').textContent = SELL_LABEL;
    ui.$('sell').style.background = '';
  }

  // Autosell : 1er clic = aperçu, 2e clic (dans les 8 s) = vente.
  async function onSell() {
    if (sellBusy) return;
    sellBusy = true;
    const btn = ui.$('sell');
    btn.disabled = true;
    try {
      if (!sellArmed) {
        setSellMsg('Calcul…');
        const r = await runAutosell(true);
        if (!r.ok) return setSellMsg(`❌ ${r.error}`, 'err');
        if (!r.count) return setSellMsg(`Rien à vendre. ${DM.keptSummary(r)}`);
        sellArmed = r;
        btn.textContent = `⚠️ Confirmer : ${r.count} objets (~${fmtK(r.estimate)} K)`;
        btn.style.background = '#b07400';
        setSellMsg(DM.keptSummary(r));
        sellResetTimer = setTimeout(disarmSell, 8000);
      } else {
        disarmSell();
        setSellMsg('Vente en cours…');
        const r = await runAutosell(false);
        setSellMsg(r.ok ? `✔ ${r.count} objets vendus : +${fmtK(r.kamas)} kamas` : `❌ ${r.error}`, r.ok ? 'ok' : 'err');
      }
    } finally {
      btn.disabled = false;
      sellBusy = false;
    }
  }

  // ---------- Auto-équipement (menu) ----------
  let equipBusy = false, eqPlanState = null, eqState = null, eqMsg = '', eqMsgCls = '';
  const setEqMsg = (text, cls = '') => { eqMsg = text; eqMsgCls = cls; renderUi(); };
  const equipStats = () => [...(cfg.equipStats || []), '', '', '', '', ''].slice(0, 5);
  const equipEnabled = () => cfg.equipSlots || {};
  const statShort = (k) => STAT_LABELS[k] || k;

  async function previewEquip() {
    if (equipBusy) return;
    equipBusy = true;
    setEqMsg('Lecture de l’inventaire…');
    try {
      eqState = await fetchEquipState();
      eqPlanState = equipPlan(eqState, equipStats(), equipEnabled());
      const n = eqPlanState.changes.length;
      setEqMsg(n ? `${n} objet(s) à changer, ${eqPlanState.unchanged} déjà optimal(aux).` : 'Ton équipement est déjà le meilleur pour ces caractéristiques ✔', n ? '' : 'ok');
    } catch (e) {
      eqPlanState = null;
      setEqMsg(`❌ ${e.message}`, 'err');
    } finally {
      equipBusy = false;
      renderUi();
    }
  }

  async function applyEquip() {
    if (equipBusy) return;
    equipBusy = true;
    setEqMsg('Recalcul…');
    let done = 0;
    try {
      eqState = await fetchEquipState();   // inventaire peut-être changé depuis l'aperçu
      const plan = equipPlan(eqState, equipStats(), equipEnabled());
      eqPlanState = plan;
      if (!plan.changes.length) { setEqMsg('Rien à changer : équipement déjà optimal ✔', 'ok'); return; }
      done = await runEquip(plan, eqState.chunks, (i, total, c) => setEqMsg(`Équipement ${i}/${total} : ${c.to.name}…`));
      setEqMsg(`✔ ${done} objet(s) équipé(s).`, 'ok');
      eqPlanState = null;
    } catch (e) {
      setEqMsg(`❌ ${done ? `${done} équipé(s), puis : ` : ''}${e.message}`, 'err');
    } finally {
      equipBusy = false;
      renderUi();
      if (done && location.pathname.startsWith('/inventaire')) setTimeout(() => location.reload(), 1500);
    }
  }

  // ---------- Auto-équipement automatique (Off / Semi / Auto) ----------
  // Toutes les cfg.equipCheckMin minutes (popup → Réglages, 3 par défaut), on recalcule le meilleur équipement (mêmes stats et emplacements que le menu).
  // Auto : équipe directement. Semi : fenêtre de proposition, avec l'écart de stats ; « Non » = objet jamais reproposé
  // (cfg.equipDeclined, par personnage : le stockage est commun aux deux comptes). Jamais pendant un combat ni sur /inventaire.
  const equipCheckMs = () => Math.max(0.5, +cfg.equipCheckMin || 3) * 60000;
  const EQUIP_SNOOZE_MS = 30 * 60000;   // proposition fermée (✕) : pas reproposée avant 30 min
  let eqTimer = null, eqAutoBusy = false, eqAsk = null;
  const eqSnooze = new Map();           // changement (emplacement > objet) → fermé à
  const eqAcct = () => myName() || (chrome.extension?.inIncognitoContext ? 'privé' : 'normal');
  const eqDeclined = () => new Set(cfg.equipDeclined?.[eqAcct()] || []);
  const eqChangeKey = (c) => `${c.slot}>${eqItemKey(c.to)}`;
  const statIdx = (k) => { const i = STAT_ORDER.indexOf(k); return i < 0 ? 999 : i; };

  // Écart complet de stats (toutes les caractéristiques). Arme à deux mains : le bouclier retiré compte comme une perte.
  function fullDiff(c, state) {
    const before = { ...(c.from?.eff || {}) };
    const shield = c.slot === 'arme' && c.to.two && !c.from?.two && state.slots.find((s) => s.slot === 'bouclier')?.cur;
    if (shield) for (const [k, v] of Object.entries(shield.eff)) before[k] = (before[k] || 0) + v;
    const keys = new Set([...Object.keys(before), ...Object.keys(c.to.eff)]);
    const diff = [...keys].map((k) => [k, (c.to.eff[k] || 0) - (before[k] || 0)]).filter(([, d]) => d)
      .sort((a, b) => statIdx(a[0]) - statIdx(b[0]));
    return { diff, shield };
  }

  async function autoEquipTick(force = false) {
    const mode = cfg.equipAuto || 'off';
    if (dead || mode === 'off' || !modOn('equip') || eqAutoBusy || equipBusy || !equipStats()[0] || eqAsk?.host.isConnected) return;
    const path = location.pathname;
    if (/^\/(inventaire|connexion)/.test(path) || (path.startsWith('/combat') && !endTitle())) return;
    if (!isOwner() && document.visibilityState !== 'visible') return;   // onglet du pilote, ou onglet affiché
    const acct = eqAcct(), now = Date.now();
    if (!force && now - (cfg.equipCheckAt?.[acct] || 0) < equipCheckMs()) return;
    eqAutoBusy = true;
    try {
      await save({ equipCheckAt: { ...(cfg.equipCheckAt || {}), [acct]: now } });
      const state = await fetchEquipState();
      const plan = equipPlan(state, equipStats(), equipEnabled(), eqDeclined());
      if (!plan.changes.length) return;
      if (mode === 'auto') {
        let done = 0;
        try {
          done = await runEquip(plan, state.chunks, (i) => { done = i; });
        } finally {
          const names = plan.changes.slice(0, done).map((c) => itemLabel(c.to));
          if (names.length) tradeToast(`🛡️ Auto-équipement : ${names.join(', ')}`, 'ok');
          eqState = null; eqPlanState = null;
          renderUi();
        }
        return;
      }
      const fresh = plan.changes.filter((c) => now - (eqSnooze.get(eqChangeKey(c)) || 0) > EQUIP_SNOOZE_MS);
      if (fresh.length && !eqAsk?.host.isConnected) showEquipAsk(plan, state);
    } catch (e) {
      DM.log(`auto-équipement : ${e.message || e}`);
    } finally {
      eqAutoBusy = false;
    }
  }

  const ASK_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, sans-serif; }
    .box { position: fixed; right: 12px; top: 12px; z-index: 2147483646; width: 360px; max-width: calc(100vw - 24px);
      max-height: calc(100vh - 24px); overflow-y: auto; background: #1b1d22; color: #e8e6e1; border: 1px solid #2e6fbf;
      border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.55); font-size: 12px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    .top { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 800; }
    .x { margin-left: auto; background: none; border: 0; color: #9aa0a8; cursor: pointer; font-size: 15px; }
    .muted { color: #9aa0a8; font-weight: 400; font-size: 11px; }
    .row { background: #262a31; border: 1px solid #3a3f48; border-radius: 8px; padding: 7px; display: flex; flex-direction: column; gap: 5px; }
    .items { display: flex; align-items: center; gap: 6px; }
    .it { flex: 1; display: flex; align-items: center; gap: 5px; min-width: 0; }
    .it img { width: 30px; height: 30px; object-fit: contain; flex: none; }
    .it span { overflow: hidden; text-overflow: ellipsis; }
    .it.to { font-weight: 700; }
    .slot { font-weight: 800; color: #8fb8ee; }
    .diff { display: flex; flex-wrap: wrap; gap: 3px 8px; }
    .up { color: #6fcf7a; } .down { color: #ff7b6b; } .main { font-weight: 800; text-decoration: underline; }
    .btns { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    button.b { border: 0; border-radius: 6px; padding: 6px; color: #fff; font-weight: 700; cursor: pointer; background: #3a3f48; }
    button.b.yes { background: #2e7d32; } button.b.no { background: #8a3a32; }
    button.b:disabled { opacity: .5; cursor: default; }
    .res { font-weight: 700; } .res.ok { color: #6fcf7a; } .res.err { color: #ff7b6b; }
  `;

  function showEquipAsk(plan, state) {
    if (!document.body) return;
    eqAsk?.host.remove();
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
    const icon = (it) => (it?.icon ? `<img src="/img/items/${+it.icon}.png" alt="">` : '');
    const host = document.createElement('div');
    host.id = 'dm-equip-ask';
    const root = host.attachShadow({ mode: 'open' });
    const chosen = new Set(plan.stats);
    const rows = plan.changes.map((c, i) => {
      const { diff, shield } = fullDiff(c, state);
      const d = diff.map(([k, v]) => `<span class="${v > 0 ? 'up' : 'down'}${chosen.has(k) ? ' main' : ''}">${v > 0 ? '+' : ''}${v} ${esc(statShort(k))}</span>`).join('');
      return `<div class="row" data-i="${i}">
        <div><span class="slot">${esc(c.label)}</span>${c.to.lvl ? ` <span class="muted">niv. ${+c.to.lvl}</span>` : ''}</div>
        <div class="items">
          <div class="it">${icon(c.from)}<span>${c.from ? esc(itemLabel(c.from)) : '<i class="muted">vide</i>'}</span></div>
          <span>→</span>
          <div class="it to">${icon(c.to)}<span>${esc(itemLabel(c.to))}</span></div>
        </div>
        ${shield ? `<div class="muted">Arme à deux mains : retire aussi ${esc(itemLabel(shield))}</div>` : ''}
        <div class="diff">${d || '<span class="muted">aucun écart de stats</span>'}</div>
        <div class="btns"><button class="b yes" data-a="yes">✔ Équiper</button><button class="b no" data-a="no">✖ Non, ne plus proposer</button></div>
      </div>`;
    }).join('');
    root.innerHTML = `<style>${ASK_CSS}</style><div class="box">
      <div class="top">🛡️ Nouveaux objets à équiper<button class="x" data-a="close" title="Plus tard (reproposé dans 30 min)">✕</button></div>
      <div class="muted">Selon tes caractéristiques ${plan.stats.map((k) => `<b>${esc(statShort(k))}</b>`).join(', ')} (soulignées ci-dessous).</div>
      ${rows}</div>`;
    document.body.appendChild(host);
    eqAsk = { host };
    const pending = new Set(plan.changes.map((_, i) => i));
    const close = () => {
      for (const i of pending) eqSnooze.set(eqChangeKey(plan.changes[i]), Date.now());
      host.remove();
      if (eqAsk?.host === host) eqAsk = null;
    };
    const answered = (i) => { pending.delete(i); if (!pending.size) setTimeout(close, 1500); };
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-a]');
      if (!b || b.disabled) return;
      if (b.dataset.a === 'close') return close();
      const row = b.closest('.row');
      const i = +row.dataset.i, c = plan.changes[i];
      const done = (text, cls) => { row.querySelector('.btns').outerHTML = `<div class="res ${cls}">${esc(text)}</div>`; };
      if (b.dataset.a === 'no') {
        const acct = eqAcct();
        const list = [...new Set([...(cfg.equipDeclined?.[acct] || []), eqItemKey(c.to)])];
        await save({ equipDeclined: { ...(cfg.equipDeclined || {}), [acct]: list } });
        done('Refusé : ne sera plus proposé', 'err');
        renderUi();
        return answered(i);
      }
      if (equipBusy || eqAutoBusy) return;
      row.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      eqAutoBusy = true;
      try {
        await runEquip({ changes: [c], stats: plan.stats }, state.chunks);
        done('✔ Équipé', 'ok');
        eqState = null; eqPlanState = null;
        renderUi();
      } catch (err) {
        done(`❌ ${err.message || err}`, 'err');
      } finally {
        eqAutoBusy = false;
        answered(i);
      }
    });
  }

  function renderEquip() {
    const $ = ui.$;
    const stats = equipStats();
    [1, 2, 3, 4, 5].forEach((n) => { const el = $(`eqS${n}`); if (ui.root.activeElement !== el) el.value = stats[n - 1] || ''; });
    const enabled = equipEnabled();
    const cur = Object.fromEntries((eqState?.slots || []).map((s) => [s.slot, s.cur]));
    const changing = new Set((eqPlanState?.changes || []).map((c) => c.slot));
    const slotHtml = (d) => {
      const it = cur[d.slot];
      const tip = `${d.label} : ${it ? `${it.name}${it.fusion ? ` (${it.fusion >= FUSION_MAX ? 'Rayonnant' : `Tiers ${it.fusion + 1}`})` : ''}` : (eqState ? 'vide' : '?')}${enabled[d.slot] === false ? ' — désactivé' : ''}`;
      return `<button data-eqslot="${d.slot}" class="eqslot${enabled[d.slot] === false ? '' : ' on'}${changing.has(d.slot) ? ' chg' : ''}" data-tip="${DM.tipAttr(tip)}">`
        + (it?.icon ? `<img src="/img/items/${+it.icon}.png" alt="">` : `<span class="em">${d.em}</span>`)
        + `<span>${d.dofus ? d.label.replace('Dofus ', 'D') : d.label}</span></button>`;
    };
    const html = EQUIP_SLOTS.filter((d) => !d.dofus).map(slotHtml).join('');
    const htmlD = EQUIP_SLOTS.filter((d) => d.dofus).map(slotHtml).join('');
    if ($('eqSlots').dmHtml !== html) { $('eqSlots').dmHtml = html; $('eqSlots').innerHTML = html; }
    if ($('eqDofus').dmHtml !== htmlD) { $('eqDofus').dmHtml = htmlD; $('eqDofus').innerHTML = htmlD; }
    for (const b of ui.root.querySelectorAll('[data-eqmode]')) b.classList.toggle('on', b.dataset.eqmode === (cfg.equipAuto || 'off'));
    const nDecl = cfg.equipDeclined?.[eqAcct()]?.length || 0;
    $('eqDeclBox').hidden = !nDecl;
    $('eqDecl').textContent = `${nDecl} objet(s) refusé(s), plus proposé(s)`;
    $('eqPreview').disabled = equipBusy || !stats[0];
    $('eqGo').disabled = equipBusy || !eqPlanState?.changes.length;
    $('eqGo').textContent = eqPlanState?.changes.length ? `✅ Équiper (${eqPlanState.changes.length})` : '✅ Équiper';
    const msg = $('eqMsg');
    msg.textContent = eqMsg || (stats[0] ? '' : 'Choisis au moins la caractéristique 1.');
    msg.className = `status ${eqMsgCls}`;
    const ul = $('eqPlan');
    ul.textContent = '';
    for (const c of eqPlanState?.changes || []) {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = `${c.label} : `;
      li.append(b, `${c.from ? itemLabel(c.from) : '(vide)'} → `);
      const to = document.createElement('b');
      to.textContent = itemLabel(c.to);
      li.append(to, document.createElement('br'));
      c.delta.forEach(([k, d], i) => {
        const sp = document.createElement('span');
        sp.className = d > 0 ? 'up' : 'down';
        sp.textContent = `${i ? ', ' : ''}${d > 0 ? '+' : ''}${d} ${statShort(k)}`;
        li.append(sp);
      });
      ul.appendChild(li);
    }
  }

  // ---------- Fusion (menu) ----------
  let fuseList = null, fuseBusy = false, fuseMsg = '', fuseMsgCls = '';
  const setFuseMsg = (text, cls = '') => { fuseMsg = text; fuseMsgCls = cls; renderUi(); };

  async function scanFusions(keepMsg) {
    if (fuseBusy) return;
    fuseBusy = true;
    if (!keepMsg) setFuseMsg('Lecture de l’inventaire…');
    try {
      fuseList = await fusePlan();
      if (!keepMsg) setFuseMsg(fuseList.length ? `${fuseList.length} objet(s) fusionnable(s).` : 'Aucun objet en 3 exemplaires (hors objets portés).');
    } catch (e) {
      fuseActionId = null;
      setFuseMsg(`❌ ${e.message || e}`, 'err');
    } finally {
      fuseBusy = false;
      renderUi();
    }
  }

  async function runFusions(items) {
    if (fuseBusy || !items.length) return;
    fuseBusy = true;
    renderUi();
    let done = 0;
    try {
      done = await fuseItems(items, (n, total, it) => setFuseMsg(`Fusion ${n}/${total} : ${it.name}…`));
      setFuseMsg(`✔ ${done} fusion(s) faite(s).`, 'ok');
    } catch (e) {
      fuseActionId = null;   // l'ID a peut-être changé (nouveau déploiement) : on le relira
      setFuseMsg(`❌ ${e.message || e}`, 'err');
    } finally {
      fuseBusy = false;
    }
    await scanFusions(true);   // liste à jour après fusion
    if (done && location.pathname.startsWith('/inventaire')) setTimeout(() => location.reload(), 1500);
  }

  function renderFuse() {
    const $ = ui.$;
    $('fuseScan').disabled = fuseBusy;
    $('fuseAll').disabled = fuseBusy || !fuseList?.length;
    $('fuseAll').style.display = fuseList?.length ? '' : 'none';
    const msg = $('fuseMsg');
    msg.textContent = fuseMsg || (fuseList ? '' : 'Repère les objets en 3 exemplaires ou plus du même tier.');
    msg.className = `status ${fuseMsgCls}`;
    const ul = $('fuseList');
    ul.textContent = '';
    for (const it of fuseList || []) {
      const li = document.createElement('li');
      const txt = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = it.name;
      const have = Object.entries(it.tiers).filter(([, q]) => q).map(([f, q]) => `${q}× ${tierLabel(+f)}`).join(', ');
      txt.append(b, ` niv. ${it.lvl}`, document.createElement('br'),
        `${have} → ${it.steps.length} fusion${it.steps.length > 1 ? 's' : ''}, jusqu’à ${tierLabel(it.best)}`);
      const btn = document.createElement('button');
      btn.textContent = 'Fusionner';
      btn.dataset.fuse = it.id;
      btn.disabled = fuseBusy;
      li.append(txt, btn);
      ul.appendChild(li);
    }
  }

  function renderUi() {
    if (dead || !document.body) return;
    if (!ui || !ui.host.isConnected) ui = buildUi();   // le site peut remplacer le <body>
    const mine = cfg.ownerTabId === myTabId;
    const on = cfg.enabled && mine;
    const state = !cfg.enabled ? 'off' : !mine ? 'other' : cfg.paused ? 'pause' : 'on';
    ui.bubble.style.setProperty('--st', ST_COLOR[state]);
    ui.bubble.title = on ? `Pilote ON — ${cfg.status || ''}` : cfg.enabled ? 'Pilote actif dans un autre onglet' : 'Pilote OFF';
    {
      const pb = ui.root.querySelector('.bubble.play');
      pb.textContent = on ? '⏸' : '▶';
      pb.style.background = on ? '#a33' : '#2e7d32';
      pb.style.borderColor = on ? '#d66' : '#5c5';
      pb.title = on ? 'Pause : arrêter le pilote' : 'Lecture : enchaîner les combats de cette page en boucle (chasse, aventure, ascension)';
    }
    if (ui.panel.hidden) return;

    const $ = ui.$;
    const hunt = cfg.mode === 'chasse';
    $('stats').textContent = `${cfg.wins || 0} V / ${cfg.losses || 0} D`;
    { const h = timeLines() || 'Pas encore de mesure : lance le pilote.'; if ($('times').innerHTML !== h) $('times').innerHTML = h; }
    {
      const run = cfg.dropRun;
      $('dropBox').style.display = run?.active ? 'flex' : 'none';
      if (run?.active) {
        const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
        const h = `<b>🐉 Farm de drop</b> · ${esc(dropZoneName(run.zone))}${run.items.map((it) => `<div>${it.got >= it.need ? '✔' : '•'} ${esc(it.name)} : ${it.got}/${it.need}</div>`).join('')}`;
        if ($('dropInfo').innerHTML !== h) $('dropInfo').innerHTML = h;
      }
    }
    $('status').textContent = on ? (cfg.status || '—') : cfg.enabled ? 'Actif dans un autre onglet' : 'Arrêté';
    const tg = $('toggle');
    tg.textContent = cfg.enabled ? '■ Arrêter' : `▶ Démarrer (${DM.modeLabel(cfg)})`;
    tg.style.background = cfg.enabled ? '#a33' : '#2e7d32';
    $('energy').textContent = cfg.energy != null ? `⚡ ${cfg.energy}/${cfg.energyMax}` : '';

    for (const b of ui.root.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === cfg.mode);
    for (const b of ui.root.querySelectorAll('[data-engine]')) b.classList.toggle('on', b.dataset.engine === (cfg.fightEngine || 'game'));
    // modules désactivés dans la popup : leurs sections du menu sont masquées
    for (const el of ui.root.querySelectorAll('[data-mod]')) {
      const k = el.dataset.mod;
      el.style.display = (k === 'tools' ? modOn('spells') || modOn('build') : modOn(k)) ? '' : 'none';
    }
    $('zoneBox').style.display = hunt ? '' : 'none';
    $('groupInfo').textContent = cfg.huntGroup ? `Groupe ${cfg.huntGroup} (choisi en jeu)` : 'Groupe le plus dur';
    $('groupReset').style.display = cfg.huntGroup ? '' : 'none';
    const sel = $('zone');
    let zones = cfg.huntZones || [];
    if (cfg.huntZone && !zones.some((z) => z.id === cfg.huntZone)) zones = [{ id: cfg.huntZone, name: cfg.huntZoneName || `Zone ${cfg.huntZone}` }, ...zones];
    const sig = zones.map((z) => z.id).join(',') + '|' + cfg.huntZone;
    if (sel.dataset.sig !== sig) {   // ne reconstruit la liste que si elle change (sinon le menu déroulant se refermerait)
      sel.dataset.sig = sig;
      sel.innerHTML = '';
      if (!cfg.huntZone) sel.add(new Option('— choisir une zone —', ''));
      for (const z of zones) sel.add(new Option(z.label || z.name, z.id, false, z.id === cfg.huntZone));
    }

    $('keepAbove').checked = cfg.sellKeepAbove !== false;
    DM.RARITIES.forEach((_, i) => { ui.$(`rar${i}`).checked = (cfg.sellKeepRarities || []).includes(i); });
    renderFuse();
    renderEquip();
    // Avis de recherche
    const st = cfg.wantedScan;
    const missing = st?.zones?.filter((z) => !['ok', 'empty'].includes(z.status)).length || 0;
    $('scan').textContent = scanRunning ? (scanStop ? 'Arrêt…' : '■ Arrêter le scan') : 'Scanner les zones';
    $('wantedLoop').checked = !!cfg.wantedLoop;
    if (ui.root.activeElement !== $('minPerGroup')) $('minPerGroup').value = cfg.wantedMinPerGroup || 1;
    // ne pas écraser un champ en cours de saisie
    for (const [k, key] of [['lvlMin', 'wantedLvlMin'], ['lvlMax', 'wantedLvlMax']]) {
      if (ui.root.activeElement !== $(k)) $(k).value = cfg[key] || '';
    }
    $('scanResume').style.display =!scanRunning && missing && st?.zones?.length ? '' : 'none';
    $('scanResume').textContent = `Reprendre (${missing})`;
    $('scanAge').textContent = st?.finishedAt ? `scan ${DM.hhmm(st.finishedAt)}` : '';
    $('scanMsg').textContent = scanMsg || (st?.zones ? `${scanMatches().length} avis trouvé(s)${missing ? ` · ${missing} zone(s) non scannée(s)` : ''}` : `${WANTED_KEYS.length} avis connus — lance un scan.`);
    const wl = $('wanted');
    wl.textContent = '';
    const now = Date.now();
    for (const f of scanMatches()) {
      const li = document.createElement('li');
      const old = f.rotateAt && now > f.rotateAt;
      li.dataset.href = old ? `/chasse?zone=${f.zoneId}` : attackLink(f);
      if (old) li.className = 'old';
      li.title = old ? 'Groupes renouvelés depuis le scan : ouvrir la zone' : 'Attaquer ce groupe (pilote auto, combats relancés en boucle)';
      if (f.img) {
        const ic = document.createElement('img');
        ic.src = f.img;
        ic.alt = '';
        li.appendChild(ic);
      }
      const txt = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = f.monster;
      txt.append(b, f.lvl ? ` niv. ${f.lvl}` : '', document.createElement('br'),
        `${f.zoneName} · G${f.group}${f.total ? ` (total ${f.total})` : ''}${f.count > 1 ? ` · 🎯×${f.count}` : ''}`,
        f.rotateAt ? ` · ${old ? 'expiré' : `jusqu’à ${DM.hhmm(f.rotateAt)}`}` : '');
      li.appendChild(txt);
      wl.appendChild(li);
    }

    const locks = Object.entries(cfg.lockedItems || {}).sort((a, b) => a[1].name.localeCompare(b[1].name));
    $('lockBox').style.display = locks.length ? '' : 'none';
    $('lockTitle').textContent = `🔒 ${locks.length} objet${locks.length > 1 ? 's' : ''} verrouillé${locks.length > 1 ? 's' : ''}`;
    const ul = $('locks');
    ul.textContent = '';
    for (const [k, it] of locks) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = `${it.name} (niv. ${it.lvl})`;
      const x = document.createElement('button');
      x.textContent = '✕';
      x.title = 'Déverrouiller';
      x.dataset.unlock = k;
      li.append(span, x);
      ul.appendChild(li);
    }
  }

  // ---------- Init ----------
  chrome.storage.onChanged.addListener((ch) => {
    if (dead) return;
    if (Object.keys(ch).every((k) => k === 'debugLog')) return;   // journal : rien à mettre à jour
    for (const k in ch) cfg[k] = ch[k].newValue;
    if (ch.enabled?.newValue) progress();
    if (ch.lockedItems && modOn('autosell')) scanLockButtons();
    if (ch.modules) scanModules();
    if ((ch.tradeQueues || ch.tradeHistory || ch.tradeLastRun) && modOn('trade')) renderQueue();
    renderUi();
  });
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'tick') tick();
    if (msg.type === 'ping') { sendResponse({ ok: !dead }); return; }   // le service worker vérifie que la page répond
    if (msg.type === 'autosell') { runAutosell(!!msg.dryRun).then(sendResponse); return true; }
    if (msg.type === 'tradePing') { tradeHealth().then(sendResponse); return true; }
    if (msg.type === 'tradeVerify') { tradeVerify(msg).then(sendResponse); return true; }
    if (msg.type === 'tradeBuy') { tradeBuy(msg).then(sendResponse); return true; }
    if (msg.type === 'peerGear') { peerGear().then(sendResponse); return true; }
  });

  (async () => {
    cfg = await DM.getAll();
    myTabId = await send({ type: 'whoami' }).catch(() => null);
    DM.installTips(document);   // bulles d'info des boutons d'échange / de la file / du sélecteur
    renderUi();
    const upd = DM.pendingUpdate(cfg);   // une fois par onglet : nouvelle version sur GitHub
    let shown = false;
    try { shown = sessionStorage.getItem('dmUpdateShown') === upd; if (upd) sessionStorage.setItem('dmUpdateShown', upd); } catch { /* stockage indisponible */ }
    if (upd && !shown) {
      tradeToast(`🆕 Autopilot-DM ${upd} disponible — clique ici pour l’installer.`, 'ok',
        () => send({ type: 'openUpdate' }).catch(() => {}));
    }
    await attackFromLink();
    runBuyTab();
    ticker = setInterval(tick, TICK_MS);
    eqTimer = setInterval(() => autoEquipTick(), 15000);
    tick();
  })();
})();
