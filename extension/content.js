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
  // Fin d'un combat d'Ascension : boutons propres aux étages (« Suivant en auto » / « Réessayer en auto » existent aussi).
  const ASC_END = /^(Étage suivant|Réessayer l.étage|Voir l.Ascension)$/;
  const ASC_START = /^Affronter l.étage \d+$/;   // bouton de /ascension
  const home = () => DM.homePath(cfg);
  const onHome = () => location.pathname + location.search === home()
    || (isAsc() ? location.pathname.startsWith('/ascension') : !isHunt() && location.pathname.startsWith('/aventure'));
  // Fin d'un combat de chasse : le jeu affiche le lien « Autres groupes de la zone ».
  const huntEnd = () => [...document.querySelectorAll('a')].some((a) => /Autres groupes de la zone/.test(a.textContent));

  const groupNumber = (panel) => +(panel?.querySelector('.title')?.textContent.trim().match(/^Groupe\s*(\d+)$/)?.[1] || 0);

  // Panneau du groupe visé sur /chasse?zone=… : celui choisi à la main (cfg.huntGroup),
  // sinon le plus dur (« Groupe 3 », ou le numéro le plus élevé).
  function targetGroup() {
    let best = null, bestN = -1;
    for (const p of document.querySelectorAll('.panel')) {
      const n = groupNumber(p);
      if (!n) continue;
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
    const group = groupNumber(b.closest('.panel'));
    if (!zone || !group) return;
    const name = document.querySelector('h1')?.textContent.trim() || cfg.huntZoneName;
    const monsters = groupMonsters(b.closest('.panel'));
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
    m = t.match(/coût\s*\d+\s*Énergie\s*\(tu en as\s*(\d+)\)/);    // /aventure « coût 1 Énergie (tu en as 76) »
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
      const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
      const m = doc.body.textContent.match(/Énergie\s*(\d+)\s*\/\s*(\d+)/);
      if (!m) return { error: 'énergie introuvable sur /jeu' };
      await save({ energy: +m[1], energyMax: +m[2], energyAt: Date.now() });
      return +m[1];
    } catch (e) {
      return { error: 'réseau' };
    }
  }

  // ---------- Achat d'énergie automatique ----------
  // L'onglet du pilote demande l'achat au service worker, qui ouvre /aventure?dmBuy=1 dans un onglet à part.
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

  // Onglet d'achat (/aventure?dmBuy=1) : achète puis rend compte au service worker (« buyDone »).
  async function runBuyTab() {
    if (!location.pathname.startsWith('/aventure') || !new URLSearchParams(location.search).has('dmBuy')) return;
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
      const { flight } = await fetchFlight('/aventure');
      const m = flight.match(/"energy":(\d+),"kamas":(\d+),"left":(\d+)/);
      if (!m) throw new Error('widget d’achat introuvable sur /aventure');
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
            // Aventure : on réessaie l'étape jusqu'à MAX_PATH_RETRIES défaites d'affilée. Chasse : arrêt immédiat.
            const streak = (cfg.lossStreak || 0) + 1;
            const stop = isHunt() || streak > MAX_PATH_RETRIES;
            await save({ botFight: false, losses: (cfg.losses || 0) + 1, lossStreak: stop ? 0 : streak });
            if (stop) {
              await save({ enabled: false, paused: false, status: 'Arrêté : combat perdu' });
              const where = isHunt() ? ` en chasse (${cfg.huntZoneName || 'zone ' + cfg.huntZone})`
                : ` en ${isAsc() ? 'ascension' : 'aventure'} (${streak} défaites d’affilée)`;
              notify('defeat', `❌ **Combat perdu**${where} sur DofusMasters. Pilote auto arrêté.${hint() ? `\n> 💡 ${hint()}` : ''}\n${DM.ORIGIN}${home()}`);
              return;
            }
          }
          if (isHunt() || !cfg.lossStreak) return;   // défaite d'un combat lancé à la main : on n'y touche pas

          // Réessai de l'étape (Auto de préférence)
          if (!(await gate())) return progress();
          if (++endRetries > 2) { endRetries = 0; return goHome(); }   // bouton sans effet : on repasse par /aventure
          setStatus(`Défaite — nouvel essai ${cfg.lossStreak}/${MAX_PATH_RETRIES}…`);
          await sleep(humanDelay());
          if (!isOwner()) return;
          const autoRetry = findBtn(/^Réessayer en auto$/i);
          const retry = autoRetry || findBtn(isAsc() ? /^Réessayer l.étage$/i : /^Réessayer l.étape$/i);
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

        if (cfg.botFight) await save({ botFight: false, wins: (cfg.wins || 0) + 1, lossStreak: 0 });
        if (!(await gate())) return progress();
        // Relance refusée (groupes renouvelés…) : on repasse par la page de la zone.
        if (++endRetries > 2) { endRetries = 0; return goHome(); }

        setStatus(isHunt() ? 'Victoire ✔ — on relance le groupe en auto…' : isAsc() ? 'Victoire ✔ — étage suivant en auto…' : 'Victoire ✔ — combat suivant en auto…');
        await sleep(humanDelay());
        if (!isOwner()) return;
        // Bouton « en auto » de préférence ; sinon relance simple, le mode Auto sera activé dans le combat.
        const autoNext = findBtn(AUTO_NEXT);
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

      if (!cfg.botFight) {   // combat lancé à la main : on n'y touche pas
        setStatus('Combat manuel en cours — le pilote attend', true);
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
      const group = targetGroup();
      if (!group) return;   // page pas encore chargée
      // Groupe d'avis de recherche choisi à la main, renouvelé depuis (combat perdu au rechargement…) :
      // attaquer le nouveau groupe n'a pas de sens → arrêt.
      const t = cfg.huntTarget;
      if (cfg.huntGroup && t?.zone === cfg.huntZone && t.group === cfg.huntGroup && t.monsters?.some(wantedMatch)) {
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
      setStatus(`Chasse : attaque du groupe ${cfg.huntGroup || groupNumber(group)} (${cfg.huntZoneName || 'zone ' + cfg.huntZone})…`);
      await sleep(humanDelay());
      const btn = isOwner() && attack();
      if (!btn) return;
      rememberHuntTarget(btn.closest('.panel'));
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
  const SELL_ACTION_FALLBACK = '406e0b152d7eeb65f891df20554b9d310fd5dfd04c';
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
  async function fetchFlight(path) {
    const r = await DM.fetchT(path, { credentials: 'same-origin', cache: 'no-store' });
    if (r.redirected && /connexion/.test(r.url)) throw new Error('Déconnecté');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    let flight = '';
    for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) flight += JSON.parse(m[1]);
    const chunks = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/[^"'\\\s]+?\.js(?:\?[^"'\\\s]*)?/g)].map((m) => m[0]))];
    return { flight, chunks };
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
    const tree = encodeURIComponent(JSON.stringify(['', { children: [segment, { children: ['__PAGE__', {}, null, null, 4096] }, null, null, 4096] }, null, null, 4112]));
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
  async function fetchSellable() {
    const { flight, chunks } = await fetchFlight('/hdv?onglet=vendre');
    const { rows, props } = rscProps(flight, (x) => Array.isArray(x.inventory) && Array.isArray(x.mine));
    if (!props) throw new Error('Inventaire de l’HDV introuvable');
    const entries = props.inventory.map((e) => {
      const item = rscResolve(rows, e.item) || {};
      return { id: item.id, name: item.n, lvl: item.lvl, slot: item.s, rarity: item.r, icon: item.icon, fusion: e.fusion, qty: e.qty, boundUntil: e.boundUntil };
    }).filter((e) => Number.isInteger(e.id));
    return { entries, chunks, mine: props.mine, maxListings: props.maxListings };
  }

  // ID de l'annonce à 1 kamas qu'on vient de créer, lu dans la page renvoyée avec le résultat de listItem.
  function findMyListing(text, itemId, fusion) {
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
    const sell = await fetchSellable();
    if (sell.maxListings && sell.mine.length >= sell.maxListings) throw new Error(`HDV plein (${sell.mine.length}/${sell.maxListings} ventes en cours)`);
    await Promise.all([hdvAction('listItem', sell.chunks), hdvAction('cancelListing', sell.chunks)]);
    return { to: peer.name || 'l’autre compte', entries: sell.entries };
  }

  // Objet vendable correspondant à { name, lvl, fusion } (non lié, quantité restante > 0).
  function tradeResolve(ctx, it) {
    const matches = ctx.entries.filter((e) => e.name === it.name && (!it.lvl || e.lvl === it.lvl) && e.fusion === it.fusion);
    if (!matches.length) throw new Error(`${it.name} introuvable parmi les objets vendables (équipé ?)`);
    if (new Set(matches.map((e) => e.id)).size > 1) throw new Error(`Plusieurs objets s’appellent ${it.name} : échange annulé`);
    const free = matches.filter((e) => !e.boundUntil || new Date(e.boundUntil) <= Date.now());
    if (!free.length) throw new Error(`${it.name} est lié jusqu’au ${new Date(matches[0].boundUntil).toLocaleString('fr-FR')}`);
    const entry = free.find((e) => e.qty > 0);
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
  const tradeErr = (message, extra) => Object.assign(new Error(message), extra);
  const tradeStopped = () => !!queueRun?.stop;

  // Attend que l'autre compte réponde (onglet joignable, session valide, serveur du jeu disponible).
  async function peerReady(say) {
    const t0 = Date.now();
    for (let i = 0; ; i++) {
      const p = await send({ type: 'tradePeer' }).catch((e) => ({ ok: false, error: e.message, retry: true }));
      if (p?.ok) {
        if (p.name && p.name === myName()) throw tradeErr('L’autre onglet est connecté au même personnage');
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
  async function cancelTradeListing(listingId, entry) {
    let id = listingId, last = null;
    for (let i = 0; i < CANCEL_TRIES; i++) {
      try {
        if (!id) id = findMyListing(JSON.stringify((await fetchSellable()).mine), entry.id, entry.fusion);
        if (!id) return { gone: true, error: 'annonce introuvable' };
        await hdvCall('cancelListing', [id], '?onglet=vendre');
        return { ok: true };
      } catch (e) {
        if (e.game) return { gone: true, error: e.message };   // « Cette vente n'existe plus »
        last = e;
        await sleep(300 + i * 300);
      }
    }
    return { error: last?.message || 'retrait impossible' };
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
    const listingId = findMyListing(text, entry.id, entry.fusion);
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
    if (r?.ok) return done(r);

    // Échec, ou pas de confirmation à temps : on retire l'annonce tout de suite, sans attendre la réponse.
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
    const ms = await tradeWithRetry(ctx, tradeResolve(ctx, it), say, true, Date.now());
    return `✔ ${it.name} → ${ctx.to} (${ms} ms)`;
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
      let ms = 0;
      while (!queueRun.stop) {
        const it = tradeQueue()[0];
        if (!it) break;
        let entry;
        try {
          entry = tradeResolve(ctx, it);
        } catch (e) {
          // Objet introuvable / lié / plus assez d'exemplaires : on le sort de la file et on passe au suivant.
          skipped.push(e.message);
          await recordTrade(runId, ctx, it, 'skipped', e.message.replace(`${it.name} `, ''), null, it.qty);
          queueRun.total -= it.qty;
          await setTradeQueue(tradeQueue().filter((x) => !sameItem(x, it)));
          continue;
        }
        const last = queueRun.done + 1 >= queueRun.total;
        ms += await tradeWithRetry(ctx, entry, (t) => say(`${queueRun.done + 1}/${queueRun.total} · ${t}`), last, runId);
        queueRun.done++;
        await setTradeQueue(tradeQueue().map((x) => (sameItem(x, it) ? { ...x, qty: x.qty - 1 } : x)));
        renderQueue();
        if (!last) await sleep(250 + Math.random() * 350);
      }
      ok = true;
      const avg = queueRun.done ? Math.round(ms / queueRun.done) : 0;
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
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:#000a;display:grid;place-items:center;padding:16px;font:13px system-ui,sans-serif;color:#eee';
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
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:#000a;display:grid;place-items:center;padding:16px;font:13px system-ui,sans-serif;color:#eee';
    ov.innerHTML = '<div style="background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:16px">Chargement des objets…</div>';
    document.body.appendChild(ov);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => e.stopPropagation());   // pas de raccourcis du jeu pendant la saisie

    let entries;
    try {
      entries = (await fetchSellable()).entries;
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
        <div style="display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:15px">📋 Sélection d’objets à échanger${DM.tip("Tous tes objets vendables (les objets équipés n’apparaissent pas). Coche ceux à envoyer ; Maj + clic coche une plage ; pour un objet en plusieurs exemplaires, choisis la quantité à droite.")}</b><button data-a="x" style="${btn};background:transparent">✕</button></div>
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

  let lockScanQueued = false;
  const domObserver = new MutationObserver(() => {
    if (dead || lockScanQueued) return;
    lockScanQueued = true;
    requestAnimationFrame(() => { lockScanQueued = false; scanLockButtons(); scanTradeButtons(); highlightWanted(); });
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


  // ---------- Auto-équipement : meilleurs objets pour 3 caractéristiques par ordre de priorité ----------
  // Server action « equipItem(itemId, fusion, emplacement) » sur /inventaire → {} ou { error }.
  // Emplacements (props.slots de /inventaire) : chapeau, cape, amulette, anneau1-2, ceinture, bottes, arme, bouclier,
  // familier, dofus1-6 ; chacun « accepte » un type d'objet (champ s de l'objet). Les objets portés ne sont pas dans entries.
  const EQUIP_ACTION_FALLBACK = '706383ea472542e23da3f7d81239188959e316dda0';
  // Poids des 3 stats choisies : la 1re décide, les 2 autres départagent / ajoutent un peu de valeur.
  const EQUIP_WEIGHTS = [1, 0.35, 0.15];
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
      return { id: it.id, name: it.n, lvl: it.lvl, type, rarity: it.r, icon: it.icon, fusion: fusion || 0,
        two: !!res(it.w)?.twoHanded, eff: fusedStats(res(it.st), type, fusion || 0) };
    };
    const entries = props.entries.map((e) => ({ ...norm(e.item, e.fusion), qty: e.qty })).filter((e) => Number.isInteger(e.id) && e.qty > 0);
    const slots = props.slots.map((s) => ({ slot: s.slot, label: s.label, accepts: s.accepts, cur: s.item ? norm(s.item, s.fusion) : null }));
    return { entries, slots, level: +props.level || 0, chunks };
  }

  // Plan d'équipement : pour chaque type d'emplacement activé, les meilleurs objets (distincts) selon les stats choisies.
  // Un objet déjà porté et retenu reste à sa place ; seuls les emplacements qui gagnent au change sont modifiés.
  // `exclude` : clés « id|fusion » d'objets de l'inventaire à ignorer (refusés dans la proposition automatique).
  function equipPlan(state, statKeys, enabled, exclude = null) {
    const stats = statKeys.filter(Boolean);
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
    const score = (c) => (c ? stats.reduce((n, k, i) => n + EQUIP_WEIGHTS[i] * (c.eff[k] || 0) / (best[`${c.type}|${k}`] || 1), 0) : -Infinity);
    const rank = (a, b) => score(b) - score(a) || b.lvl - a.lvl || b.rarity - a.rarity || b.fusion - a.fusion;
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
        if (p && score(p) > Math.max(score(s.cur), 0) + EPS) {
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
      try {
        await callAction('inventaire', equipActionId, [c.to.id, c.to.fusion, c.slot]);
      } catch (e) {
        if (!e.game) equipActionId = null;   // ID peut-être périmé : relu au prochain essai
        throw new Error(`${c.label} (${c.to.name}) : ${e.message}`);
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
  const markLaunch = () => { if (!launchAt) launchAt = Date.now(); };

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
    for (const p of doc.querySelectorAll('.panel')) {
      const n = groupNumber(p);
      if (!n) continue;
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
      } while (cfg.wantedLoop && !scanStop);
    } catch (e) {
      scanMsg = `❌ ${e.message}`;
    } finally {
      scanRunning = false;
      renderUi();
    }
  }

  // Lien « ⚔️ Attaquer direct » reçu sur Discord : /chasse?zone=Z&dmAttack=N[&dmUntil=t].
  // Le groupe N devient la cible de chasse ; si le pilote tourne, cet onglet le prend en main (Auto + relance en boucle),
  // sinon on lance juste ce combat. Si les groupes ont été renouvelés depuis (dmUntil dépassé), on n'attaque pas.
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
    await save({ mode: 'chasse', huntZone: zone, huntZoneName: name, huntGroup: group, pauseReason: null });
    if (cfg.enabled) {
      await send({ type: 'claim' }).catch(() => {});   // le pilote passe sur cet onglet et attaque
      return;
    }
    const btn = [...targetGroupByNumber(group)?.querySelectorAll('button') || []]
      .find((b) => !b.disabled && /^Attaquer$/.test(b.textContent.trim()));
    btn?.click();
  }
  const targetGroupByNumber = (n) => [...document.querySelectorAll('.panel')].find((p) => groupNumber(p) === n);

  // Sur une page de zone, on met en évidence les monstres d'avis de recherche.
  function highlightWanted() {
    if (!location.pathname.startsWith('/chasse')) return;
    for (const li of document.querySelectorAll('.panel li')) {
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

  // ---------- Bulle en bas à gauche + menu (pilote, chasse, autosell) ----------
  // Shadow DOM : le CSS du site (Tailwind) ne déteint pas sur le menu, et inversement.
  const MENU_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, sans-serif; }
    .bubble { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; width: 44px; height: 44px; border-radius: 50%;
      display: grid; place-items: center; font-size: 22px; cursor: pointer; user-select: none;
      background: #262a31; border: 3px solid var(--st, #666); box-shadow: 0 2px 10px rgba(0,0,0,.5); transition: transform .15s; }
    .bubble:hover { transform: scale(1.08); }
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
        </div>
        <div class="sec">
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
        <div class="sec">
          <div class="head"><span>✨ Fusion${DM.tip("3 exemplaires d’un même objet au même tier → 1 exemplaire du tier suivant (+10 % de stats), jusqu’au tier Rayonnant. Les objets portés ne sont pas touchés.")}</span><span class="muted">3 identiques → tier +1</span></div>
          <div class="row">
            <button data-k="fuseScan" style="flex:1" data-tip="Liste les objets que tu peux fusionner, avec le résultat des fusions en cascade.">Chercher les doublons</button>
            <button data-k="fuseAll" data-tip="Fusionne tout ce qui est listé, en cascade (3 base → 1 T2, 3 T2 → 1 T3…).">Tout fusionner</button>
          </div>
          <div class="status" data-k="fuseMsg"></div>
          <ul class="fuse" data-k="fuseList"></ul>
        </div>
        <div class="sec">
          <div class="head"><span>🛡️ Auto-équipement${DM.tip("Équipe automatiquement les meilleurs objets de ton inventaire selon 3 caractéristiques par ordre de priorité. La 1re compte pleinement, la 2e pour 35 % et la 3e pour 15 % : elles départagent les objets proches. Chaque stat est comparée au meilleur objet du même type (ex. meilleur chapeau). Les bonus de panoplie ne sont pas pris en compte.")}</span></div>
          <div class="seg eqmode">
            <button data-eqmode="off" data-tip="Pas de vérification automatique : utilise Aperçu / Équiper ci-dessous.">Off</button>
            <button data-eqmode="semi" data-tip="Toutes les 3 min, vérifie l’inventaire. Si un objet ferait mieux, une fenêtre le propose avec l’écart de stats : ✔ pour l’équiper, ✖ pour ne plus jamais le proposer.">Semi</button>
            <button data-eqmode="auto" data-tip="Toutes les 3 min, équipe directement les meilleurs objets (hors objets refusés en mode Semi).">Auto</button>
          </div>
          <div class="row" style="align-items:center;justify-content:space-between" data-k="eqDeclBox">
            <span class="muted" data-k="eqDecl"></span>
            <button data-k="eqDeclReset" data-tip="Oublier les objets refusés : ils pourront de nouveau être proposés." style="padding:2px 7px;font-size:12px">↺ Oublier</button>
          </div>
          <div class="eqstats">
            ${[1, 2, 3].map((n) => `<b>${n}</b><select data-k="eqS${n}"></select>`).join('')}
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
        <div class="sec">
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
      <div class="bubble" title="Autopilot-DM">🤖</div>`;
    DM.installTips(root);
    const $ = (k) => root.querySelector(`[data-k="${k}"]`);
    const panel = root.querySelector('.panel');
    const bubble = root.querySelector('.bubble');

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
      const z = e.target.closest('li[data-zone]')?.dataset.zone;
      if (z) location.assign(`/chasse?zone=${z}`);   // il reste à cliquer « Attaquer » : le pilote relancera ce groupe
    });
    $('locks').addEventListener('click', (e) => {
      const k = e.target.closest('button[data-unlock]')?.dataset.unlock;
      if (!k) return;
      const lockedItems = { ...(cfg.lockedItems || {}) };
      delete lockedItems[k];
      save({ lockedItems });
    });

    for (const n of [1, 2, 3]) {
      const sel = $(`eqS${n}`);
      sel.add(new Option(n === 1 ? '— choisir —' : '— aucune —', ''));
      for (const k of STAT_ORDER) sel.add(new Option(STAT_LABELS[k] || k, k));
      sel.addEventListener('change', () => {
        const stats = [1, 2, 3].map((i) => $(`eqS${i}`).value);
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
  const equipStats = () => cfg.equipStats || ['', '', ''];
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
  // Toutes les EQUIP_CHECK_MS, on recalcule le meilleur équipement (mêmes stats et emplacements que le menu).
  // Auto : équipe directement. Semi : fenêtre de proposition, avec l'écart de stats ; « Non » = objet jamais reproposé
  // (cfg.equipDeclined, par personnage : le stockage est commun aux deux comptes). Jamais pendant un combat ni sur /inventaire.
  const EQUIP_CHECK_MS = 3 * 60000;
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
    if (dead || mode === 'off' || eqAutoBusy || equipBusy || !equipStats()[0] || eqAsk?.host.isConnected) return;
    const path = location.pathname;
    if (/^\/(inventaire|connexion)/.test(path) || (path.startsWith('/combat') && !endTitle())) return;
    if (!isOwner() && document.visibilityState !== 'visible') return;   // onglet du pilote, ou onglet affiché
    const acct = eqAcct(), now = Date.now();
    if (!force && now - (cfg.equipCheckAt?.[acct] || 0) < EQUIP_CHECK_MS) return;
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
    [1, 2, 3].forEach((n) => { const el = $(`eqS${n}`); if (ui.root.activeElement !== el) el.value = stats[n - 1] || ''; });
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
    if (ui.panel.hidden) return;

    const $ = ui.$;
    const hunt = cfg.mode === 'chasse';
    $('stats').textContent = `${cfg.wins || 0} V / ${cfg.losses || 0} D`;
    $('status').textContent = on ? (cfg.status || '—') : cfg.enabled ? 'Actif dans un autre onglet' : 'Arrêté';
    const tg = $('toggle');
    tg.textContent = cfg.enabled ? '■ Arrêter' : `▶ Démarrer (${DM.modeLabel(cfg)})`;
    tg.style.background = cfg.enabled ? '#a33' : '#2e7d32';
    $('energy').textContent = cfg.energy != null ? `⚡ ${cfg.energy}/${cfg.energyMax}` : '';

    for (const b of ui.root.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === cfg.mode);
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
      li.dataset.zone = f.zoneId;
      const old = f.rotateAt && now > f.rotateAt;
      if (old) li.className = 'old';
      li.title = old ? 'Groupes renouvelés depuis le scan : peut-être plus là' : 'Ouvrir la zone';
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
    if (ch.lockedItems) scanLockButtons();
    if (ch.tradeQueues || ch.tradeHistory || ch.tradeLastRun) renderQueue();
    renderUi();
  });
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'tick') tick();
    if (msg.type === 'ping') { sendResponse({ ok: !dead }); return; }   // le service worker vérifie que la page répond
    if (msg.type === 'autosell') { runAutosell(!!msg.dryRun).then(sendResponse); return true; }
    if (msg.type === 'tradePing') { tradeHealth().then(sendResponse); return true; }
    if (msg.type === 'tradeVerify') { tradeVerify(msg).then(sendResponse); return true; }
    if (msg.type === 'tradeBuy') { tradeBuy(msg).then(sendResponse); return true; }
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
