// Autopilot-DM — content script : boucle principale.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

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
        await dropSyncInventory();   // toutes les 5 min : objets arrivés par d'autres moyens (coffres…)
        if (!dropOn()) return;
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
      if (g === false) return dropGoZone(`plus de groupe utile dans ${dropZoneName(cfg.huntZone)}`);
      if (cfg.huntGroup !== g) await save({ huntGroup: g });
    }
    const group = targetGroup();
    if (!group) return;   // page pas encore chargée
    // Groupe d'avis de recherche choisi à la main, renouvelé depuis (combat perdu au rechargement…) :
    // attaquer le nouveau groupe n'a pas de sens → arrêt.
    const t = cfg.huntTarget;
    const isTarget = (m) => targetMatch(m, ALL_KINDS);
    if (!dropOn() && cfg.huntGroup && t?.zone === cfg.huntZone && t.group === cfg.huntGroup && t.monsters?.some(isTarget)) {
      const now = groupMonsters(group);
      if (now.length && now.join('|') !== t.monsters.join('|')) {
        await save({ enabled: false, paused: false, botFight: false, huntTarget: null,
          status: 'Arrêté : le groupe ciblé (avis / archi) a été renouvelé' });
        notify('wanted', `⏹️ Le groupe ciblé (${t.monsters.filter(isTarget).join(', ')}) a été renouvelé dans **${cfg.huntZoneName || 'zone ' + cfg.huntZone}** : pilote auto arrêté.`);
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
