importScripts('shared.js');

const BOSS_REFRESH_MS = 10 * 60000;

// kind : type de notification (DM.NOTIF) ; ignoré si désactivé dans les réglages. Sans kind (test) : toujours envoyé.
async function discord(text, embeds, kind) {
  const s = await DM.getAll();
  const { webhookUrl } = s;
  const type = kind && DM.NOTIF.find((n) => n.kind === kind);
  if (type && s[type.key] === false) return { ok: true, skipped: true };
  if (!webhookUrl) return { ok: false, error: 'Webhook Discord non configuré' };
  try {
    const r = await DM.fetchT(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Autopilot-DM', content: text, ...(embeds ? { embeds } : {}) }),
    });
    return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function refreshBoss() {
  try {
    const r = await DM.fetchT(DM.ORIGIN + '/chasse', { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return;
    const info = DM.parseBossInfo(await r.text());
    if (info) await chrome.storage.local.set({ bossInfo: { ...info, fetchedAt: Date.now() } });
  } catch (e) { /* hors ligne ou déconnecté : on garde la grille par défaut */ }
}

async function updateBadge() {
  const s = await DM.getAll();
  const text = !s.enabled ? '' : s.paused ? 'II' : 'ON';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: s.paused ? '#d18b00' : '#2e9e44' });
}

async function bossCheck() {
  const s = await DM.getAll();
  if (!s.bossInfo || Date.now() - (s.bossInfo.fetchedAt || 0) > BOSS_REFRESH_MS) await refreshBoss();
  const { bossInfo, bossPreAlertMin, bossAlertedFor, bossPreAlertedFor } = await DM.getAll();

  const now = Date.now();
  const st = DM.bossStatus(bossInfo, now);
  const name = st.name || 'Boss de chasse';
  await bossAutoCheck(st, now);

  if (st.active && bossAlertedFor !== st.spawnAt) {
    await chrome.storage.local.set({ bossAlertedFor: st.spawnAt });
    await discord(`🐉 **${name}** est apparu ! Disponible jusqu'à **${DM.hhmm(st.endsAt)}** (un seul essai).\n${DM.ORIGIN}/chasse`, undefined, 'boss');
  } else if (!st.active && bossPreAlertMin > 0 && st.nextAt - now <= bossPreAlertMin * 60000 && bossPreAlertedFor !== st.nextAt) {
    await chrome.storage.local.set({ bossPreAlertedFor: st.nextAt });
    await discord(`⏳ **${name}** arrive à ${DM.hhmm(st.nextAt)}.`, undefined, 'boss');
  }
}

// ---------- Boss de chasse automatique ----------
// bossRun.phase : 'waiting' (le farm finit son combat sans relancer) → 'fighting' (onglet boss pilote) → supprimé.
const BOSS_FIGHT_MAX_MS = 8 * 60000;   // sécurité : onglet boss abandonné au-delà
const BOSS_MIN_LEFT_MS = 45 * 1000;    // inutile de partir si le boss s'en va dans moins de 45 s

async function bossAutoCheck(st, now) {
  const s = await DM.getAll();
  const run = s.bossRun;
  if (run?.phase === 'waiting' && now > run.endsAt) {   // le farm n'a pas fini à temps : boss manqué
    await chrome.storage.local.set({ bossRun: null });
    return;
  }
  if (run?.phase === 'fighting' && now - run.startedAt > BOSS_FIGHT_MAX_MS) return bossFinish('abandonné (délai dépassé)');
  if (run || !s.enabled || s.bossAuto === false || !st.active) return;
  if (s.bossTriedFor === st.spawnAt || st.endsAt - now < BOSS_MIN_LEFT_MS) return;
  await chrome.storage.local.set({
    bossTriedFor: st.spawnAt,   // un seul essai par apparition
    bossRun: { phase: 'waiting', spawnAt: st.spawnAt, endsAt: st.endsAt, name: st.name, farmTabId: s.ownerTabId },
  });
  if (s.ownerTabId != null) chrome.tabs.sendMessage(s.ownerTabId, { type: 'tick' }).catch(() => {});
}

// Le farm a fini son combat : on ouvre l'onglet du boss et on lui passe la main.
async function bossGo(farmTabId) {
  const s = await DM.getAll();
  if (s.bossRun?.phase !== 'waiting' || !s.enabled) return false;
  const tab = await chrome.tabs.create({ url: DM.ORIGIN + '/chasse', active: true });
  await chrome.storage.local.set({
    bossRun: { ...s.bossRun, phase: 'fighting', farmTabId, bossTabId: tab.id, startedAt: Date.now() },
    ownerTabId: tab.id,
    botFight: false,
    status: `Boss de chasse : ${s.bossRun.name || 'boss'}…`,
  });
  return true;
}

// Fin de l'essai : fermeture de l'onglet boss, retour sur l'onglet du farm qui reprend.
async function bossFinish(result, { closeTab = true } = {}) {
  const s = await DM.getAll();
  const run = s.bossRun;
  if (!run) return;
  // Le dernier combat du farm a déjà été compté avant le départ (bossGo) ; l'avance rapide repart de zéro.
  await chrome.storage.local.set({
    bossRun: null, botFight: false, ownerTabId: run.farmTabId, status: `Boss : ${result} — reprise du farm…`,
  });
  if (result) await discord(`🐉 **${run.name || 'Boss de chasse'}** : ${result}.`, undefined, 'boss');
  if (closeTab && run.bossTabId != null) setTimeout(() => chrome.tabs.remove(run.bossTabId).catch(() => {}), 2500);
  if (run.farmTabId != null) {
    try {
      // L'onglet du farm est resté figé (en arrière-plan, sur l'écran de fin) pendant le boss : on le recharge
      // sur sa page d'accueil (zone de chasse / aventure) pour repartir d'un état frais.
      await chrome.tabs.update(run.farmTabId, { active: true, url: DM.ORIGIN + DM.homePath(await DM.getAll()) });
    } catch {   // onglet du farm fermé entre-temps
      await chrome.storage.local.set({ enabled: false, status: 'Arrêté : onglet du farm fermé pendant le boss' });
    }
  }
}

// ---------- Achat d'énergie dans un onglet à part ----------
// energyBuy : { tabId, farmTabId, at } pendant l'achat. Au retour (« buyDone ») : fermeture de l'onglet d'achat,
// pause levée et rechargement de l'onglet du pilote sur sa page d'accueil (relance propre, même s'il était en combat).
const BUY_TAB_MAX_MS = 2 * 60000;

async function buyStart(farmTabId) {
  const s = await DM.getAll();
  if (!s.enabled || !s.autoBuyEnergy) { DM.log(`achat[sw]: refusé (pilote ${s.enabled ? 'ON' : 'OFF'}, achat auto ${s.autoBuyEnergy ? 'ON' : 'OFF'})`); return false; }
  if (s.energyBuy && Date.now() - s.energyBuy.at < BUY_TAB_MAX_MS) return true;
  const tab = await chrome.tabs.create({ url: DM.ORIGIN + '/jeu?dmBuy=1', active: false });
  await chrome.storage.local.set({ energyBuy: { tabId: tab.id, farmTabId, at: Date.now() } });
  DM.log(`achat[sw]: onglet d’achat ${tab.id} ouvert pour l’onglet ${farmTabId}`);
  return true;
}

async function buyDone(res, senderTabId) {
  const s = await DM.getAll();
  const run = s.energyBuy;
  DM.log(`achat[sw]: résultat de l’onglet ${senderTabId}`, res, 'attendu', run);
  if (!run || run.tabId !== senderTabId) return;
  await chrome.storage.local.set({ energyBuy: null });
  setTimeout(() => chrome.tabs.remove(run.tabId).catch(() => {}), 1500);
  if (!res.ok) {
    // raison « normale » (prix, réserve, plafond) : signalée une fois, pas à chaque nouvel essai
    if (res.soft && s.buySoftReason === res.error) return;
    await chrome.storage.local.set({ buySoftReason: res.soft ? res.error : null });
    await discord(res.soft
      ? `🔋 Achat d’énergie auto non fait : ${res.error}. Le pilote continue avec l’énergie restante.`
      : `⚠️ Achat d’énergie auto échoué (${res.error}). Nouvel essai dans 10 min.`, undefined, res.soft ? 'energy' : 'errors');
    return;
  }
  await chrome.storage.local.set({
    energy: res.energy, energyAt: Date.now(), pauseReason: null, paused: false, buyNextTry: 0, buySoftReason: null,
    status: `🛒 ${res.n} énergie achetée — relance…`,
  });
  await discord(`🛒 **${res.n} énergie** achetée pour ${res.cost.toLocaleString('fr-FR')} K → ${res.energy}/${res.max}`
    + ` (reste ~${res.kamas.toLocaleString('fr-FR')} K). Le pilote reprend.`, undefined, 'energy');
  if (s.enabled && s.ownerTabId === run.farmTabId) {
    await chrome.tabs.update(run.farmTabId, { url: DM.ORIGIN + DM.homePath(s) })
      .then(() => DM.log(`achat[sw]: onglet ${run.farmTabId} relancé sur ${DM.homePath(s)}`))
      .catch((e) => DM.log('achat[sw]: relance de l’onglet impossible', e.message));
  } else {
    DM.log(`achat[sw]: pas de relance (pilote ${s.enabled ? 'ON' : 'OFF'}, onglet pilote ${s.ownerTabId}, demandeur ${run.farmTabId})`);
  }
}

// Onglet d'achat bloqué : on le ferme (la demande sera refaite par le pilote après BUY_RETRY_MS).
async function buyWatchdog() {
  const { energyBuy } = await DM.getAll();
  if (!energyBuy || Date.now() - energyBuy.at < BUY_TAB_MAX_MS) return;
  DM.log(`achat[sw]: onglet d’achat ${energyBuy.tabId} sans réponse depuis 2 min, fermé`);
  await chrome.storage.local.set({ energyBuy: null });
  chrome.tabs.remove(energyBuy.tabId).catch(() => {});
  await discord('⚠️ Achat d’énergie auto : l’onglet d’achat ne répond pas, fermé. Nouvel essai dans 10 min.', undefined, 'errors');
}

// Onglet du pilote qui ne répond plus : page qui ne finit jamais de charger (le script de l'extension n'y est pas
// encore injecté), page d'erreur réseau de Chrome, onglet gelé… → on le recharge (au plus une fois par PONG_MAX_MS).
const PONG_MAX_MS = 90 * 1000;
async function pilotWatchdog() {
  const s = await DM.getAll();
  if (!s.enabled || s.ownerTabId == null) return;
  const tabId = s.ownerTabId, now = Date.now();
  const alive = await chrome.tabs.sendMessage(tabId, { type: 'ping' }).then((r) => !!r?.ok, () => false);
  const { pilotPong } = await chrome.storage.session.get('pilotPong');
  if (alive || pilotPong?.tabId !== tabId) return chrome.storage.session.set({ pilotPong: { tabId, at: now } });
  if (now - pilotPong.at < PONG_MAX_MS) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.pendingUrl || tab?.url || '';
  if (!url.startsWith(DM.ORIGIN)) return;   // l'utilisateur a quitté le jeu dans cet onglet : on n'y touche pas
  await chrome.storage.session.set({ pilotPong: { tabId, at: now } });
  DM.log(`anti-blocage[sw]: onglet ${tabId} sans réponse depuis ${Math.round((now - pilotPong.at) / 1000)} s → rechargement`);
  await chrome.storage.local.set({ status: 'Page sans réponse — rechargement…' });
  chrome.tabs.reload(tabId, { bypassCache: true }).catch(() => {});
}

async function tickTabs() {
  const tabs = await chrome.tabs.query({ url: DM.ORIGIN + '/*' });
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'tick' }).catch(() => {});
}

async function setEnabled(on, preferTabId) {
  if (!on) {
    await chrome.storage.local.set({ enabled: false, paused: false, bossRun: null, status: 'Arrêté' });
    return;
  }
  let tabId = preferTabId;
  if (tabId == null) {
    const tabs = await chrome.tabs.query({ url: DM.ORIGIN + '/*' });
    tabId = (tabs.find((t) => t.active) || tabs[0])?.id;
    if (tabId == null) tabId = (await chrome.tabs.create({ url: DM.ORIGIN + DM.homePath(await DM.getAll()) })).id;
  }
  await chrome.storage.local.set({ enabled: true, ownerTabId: tabId, pauseReason: null, paused: false, lossStreak: 0, bossRun: null, status: 'Démarrage…' });
  chrome.tabs.sendMessage(tabId, { type: 'tick' }).catch(() => {});
}

function ensureAlarm() {
  chrome.alarms.create('main', { periodInMinutes: 0.5 });
}

// Nouvelle version sur GitHub ? (au plus une requête toutes les `updateCheckMin` minutes ; 0 = jamais, sauf force)
async function checkUpdate(force = false) {
  const { updateCheckedAt = 0, updateCheckMin } = await DM.getAll();
  const every = Math.max(0, Number(updateCheckMin) || 0) * 60000;
  if (!force && (!every || Date.now() - updateCheckedAt < every)) return;
  try {
    const r = await DM.fetchT(DM.UPDATE_MANIFEST, { cache: 'no-store' }, 15000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { version } = await r.json();
    await chrome.storage.local.set({ updateVersion: version, updateCheckedAt: Date.now() });
  } catch (e) {
    await chrome.storage.local.set({ updateCheckedAt: Date.now() });
    DM.log(`mise à jour : vérification impossible (${e.message})`);
  }
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  ensureAlarm();
  checkUpdate(true);
  // Nouvelle version : les onglets du jeu tournent encore l'ancien script (déconnecté) → on les recharge.
  if (reason === 'update') {
    for (const t of await chrome.tabs.query({ url: DM.ORIGIN + '/*' })) chrome.tabs.reload(t.id).catch(() => {});
  }
  chrome.storage.local.remove(['fastForward', 'ffArmAt', 'ffTries']);   // ancienne « avance rapide » des combats (retirée en 1.34.0)
});
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); checkUpdate(); });

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'main') return;
  checkUpdate();
  await bossCheck();
  await buyWatchdog();
  await pilotWatchdog();
  await tickTabs();
  await updateBadge();
});

chrome.storage.onChanged.addListener((ch) => {
  if ('enabled' in ch || 'paused' in ch) updateBadge();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { ownerTabId, enabled, bossRun } = await DM.getAll();
  if (bossRun?.phase === 'fighting' && bossRun.bossTabId === tabId) return bossFinish('onglet du boss fermé', { closeTab: false });
  if (enabled && ownerTabId === tabId) {
    await chrome.storage.local.set({ enabled: false, paused: false, status: 'Arrêté : onglet du jeu fermé' });
  }
});

// Onglet du jeu dans l'autre contexte que `tab` (un compte en navigation normale, l'autre en navigation privée).
async function tradePeerTab(tab) {
  if (!tab) return null;
  const tabs = (await chrome.tabs.query({ url: DM.ORIGIN + '/*' })).filter((t) => t.incognito !== tab.incognito);
  return tabs.find((t) => t.active) || tabs[0] || null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'whoami': return sender.tab?.id ?? null;
      case 'discord': return discord(msg.text, msg.embeds, msg.kind);
      case 'toggle': {
        const { enabled } = await DM.getAll();
        await setEnabled(!enabled, msg.fromPage ? sender.tab?.id : undefined);
        return !enabled;
      }
      case 'refreshBoss': await refreshBoss(); return true;
      case 'checkUpdate': {   // msg.force : bouton « Vérifier maintenant » ; sinon (ouverture de la popup) seulement si la vérif auto est active
        const { updateCheckMin } = await DM.getAll();
        if (msg.force || updateCheckMin > 0) await checkUpdate(true);
        return true;
      }
      case 'reloadExtension': setTimeout(() => chrome.runtime.reload(), 100); return true;
      case 'openUpdate': await chrome.tabs.create({ url: chrome.runtime.getURL('update.html') }); return true;
      case 'bossGo': return bossGo(sender.tab?.id);
      case 'bossDone': return bossFinish(msg.result);
      case 'buyEnergy': return buyStart(sender.tab?.id);
      case 'buyDone': return buyDone(msg, sender.tab?.id);
      case 'claim': {   // lien « attaque directe » ouvert dans un nouvel onglet : le pilote actif passe sur cet onglet
        const { enabled } = await DM.getAll();
        if (sender.tab?.id == null || (!enabled && !msg.start)) return false;
        if (!enabled) await setEnabled(true, sender.tab.id);   // « Attaquer » sur un avis : démarre le pilote
        await chrome.storage.local.set({ ownerTabId: sender.tab.id, paused: false, pauseReason: null, botFight: false,
          status: 'Avis de recherche : attaque du groupe…' });
        chrome.tabs.sendMessage(sender.tab.id, { type: 'tick' }).catch(() => {});
        return true;
      }
      case 'peerGear':    // optimiseur de build : inventaire du compte « banque » (autre contexte)
      case 'tradePeer':   // échange HDV : on relaie à un onglet du jeu de l'autre contexte (normal ↔ navigation privée)
      case 'tradeBuy':
      case 'tradeVerify': {   // l'autre compte a-t-il bien reçu l'objet ?
        const peer = await tradePeerTab(sender.tab);
        if (!peer) {
          return { ok: false, retry: false, error: sender.tab?.incognito
            ? 'Aucun onglet DofusMasters ouvert en navigation normale'
            : 'Aucun onglet DofusMasters en navigation privée (l’extension doit y être autorisée)' };
        }
        // onglet en cours de (re)chargement : il répondra dans un instant → le vendeur réessaie
        return chrome.tabs.sendMessage(peer.id, { ...msg, type: msg.type === 'tradePeer' ? 'tradePing' : msg.type })
          .catch(() => ({ ok: false, retry: true, error: 'onglet de l’autre compte en cours de chargement' }));
      }
      case 'autosell': {
        // La server action doit partir de la page du jeu (contrôle d'origine Next.js) : on passe par un onglet.
        const tabs = await chrome.tabs.query({ url: DM.ORIGIN + '/*' });
        const tab = tabs.find((t) => t.active) || tabs[0];
        if (!tab) return { ok: false, error: 'Ouvre un onglet DofusMasters' };
        return chrome.tabs.sendMessage(tab.id, { type: 'autosell', dryRun: msg.dryRun })
          .catch(() => ({ ok: false, error: 'Recharge l’onglet DofusMasters' }));
      }
    }
  })().then(sendResponse);
  return true;
});
