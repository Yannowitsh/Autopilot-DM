// Autopilot-DM — content script : énergie, achat d’énergie, conditions de combat.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

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
  // juste après un achat, la page affiche encore l'ancienne énergie : on se fie au compteur (mis à jour par l'achat)
  const onPage = !fresh && Date.now() > pageEnergyStaleUntil && energyFromPage();   // en pause, la page peut être figée depuis longtemps : on relit /jeu
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
// Achat direct, depuis l'onglet du pilote : server action « buyEnergy(n) » (une requête pour n points ; réponse
// { energy } ou { error }). État d'achat (énergie, kamas, achats restants du jour) lu sur /jeu (widget BuyEnergy).
// true = énergie rachetée. Au plus un essai toutes les BUY_RETRY_MS (échec, kamas, plafond…).
const BUY_ACTION_FALLBACK = '40f4d83f85e7e109ae429bf31be8ff07cd2328e3d5';
let buyActionId = null, pageEnergyStaleUntil = 0;
async function requestBuy() {
  if (!cfg.autoBuyEnergy) return false;
  if (Date.now() < (cfg.buyNextTry || 0)) return false;
  await save({ buyNextTry: Date.now() + BUY_RETRY_MS });
  try {
    const { flight, chunks } = await fetchFlight('/jeu');
    const m = flight.match(/"energy":(\d+),"kamas":(\d+),"left":(\d+)/);
    if (!m) throw new Error('état d’achat introuvable sur /jeu');
    const props = { energy: +m[1], kamas: +m[2], left: +m[3] };
    const plan = planBuy(props);
    if (!plan.n) { DM.log(`achat: rien à acheter (${plan.why})`, props); return false; }
    if (!buyActionId) buyActionId = await findAction(chunks, 'buyEnergy', BUY_ACTION_FALLBACK);
    DM.log(`achat: ${plan.n} point(s) pour ~${plan.cost} kamas`, props);
    const res = await callAction('jeu', buyActionId, [plan.n]);
    const energy = +res.energy || props.energy + plan.n;
    await save({ energy, energyMax: plan.max, energyAt: Date.now(), buyNextTry: 0, pauseReason: null });
    lastEnergyCheck = Date.now();
    pageEnergyStaleUntil = Date.now() + 60000;
    notify('energy', `⚡ Énergie rachetée : +${plan.n} pour ${plan.cost.toLocaleString('fr-FR')} kamas → **${energy}**.`);
    return true;
  } catch (e) {
    buyActionId = null;   // ID peut-être périmé : relu au prochain essai
    DM.log(`achat: échec (${e.message})`);
    notify('errors', `⚠️ Achat d’énergie automatique impossible : ${e.message}. Nouvel essai dans ${BUY_RETRY_MS / 60000} min.`);
    return false;
  }
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
    setStatus(`Énergie rachetée ✔ (${cfg.energy}) — le farm continue…`);
    return false;
  }

  const minE = minEnergy();
  const resumeE = Math.max(cfg.resumeEnergy, minE);

  if (cfg.pauseReason === 'energy') {
    if (e < resumeE) {
      const bought = await requestBuy();   // achat auto (si activé) : la pause est levée s'il réussit
      setStatus(bought ? `Énergie rachetée ✔ (${cfg.energy}) — reprise…` : `Pause énergie : ${e} (reprise à ${resumeE})`, !bought);
      return false;
    }
    await save({ pauseReason: null });
    notify('energy', `▶️ Énergie remontée à ${e} : le pilote auto reprend.`);
  } else if (e < minE) {
    DM.log(`énergie basse : ${e} < ${minE} (achat auto ${cfg.autoBuyEnergy ? 'activé' : 'désactivé'})`);
    await save({ pauseReason: 'energy' });
    const bought = await requestBuy();
    setStatus(bought ? `Énergie rachetée ✔ (${cfg.energy}) — reprise…` : `Pause énergie : ${e} (reprise à ${resumeE})`, !bought);
    if (!bought) notify('energy', `🔋 Énergie basse (**${e}**). Pilote auto en pause, reprise automatique à ${resumeE}.`);
    return false;
  }
  return true;
}
