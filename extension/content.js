// Autopilot-DM — content script : init (chargé en dernier).
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- Init ----------
chrome.storage.onChanged.addListener((ch) => {
  if (dead) return;
  if (Object.keys(ch).every((k) => k === 'debugLog')) return;   // journal : rien à mettre à jour
  for (const k in ch) cfg[k] = ch[k].newValue;
  if (ch.enabled?.newValue) progress();
  if (ch.dropCart || ch.dropLockCart) scheduleLockSync();   // liste de drops verrouillée : suit ses changements
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
  // cadenas du jeu : synchro toutes les LOCK_SYNC_MS (un seul onglet par compte s'en charge, cf. syncLocks)
  const lockTick = () => { if (!dead) syncLocks({ ifStale: true, reload: true }).catch((e) => DM.log(`verrous : ${e.message}`)); };
  lockTimer = setInterval(lockTick, 60000);
  setTimeout(lockTick, 4000 + Math.random() * 4000);
  tick();
})();
