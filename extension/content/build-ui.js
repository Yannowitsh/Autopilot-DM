// Autopilot-DM — content script : optimiseur de build : fenêtres (optimiseur, favoris, sorts).
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

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
  delete o.simTier;   // ancienne option « Tier simulé » : tout est comparé en T1
  if (!BUILD_GOALS[o.goal]) o.goal = o.krala ? 'krala' : 'dps';   // ancienne case « Kralamoure »
  delete o.krala;
  const inp = 'background:#2a231a;border:1px solid #5a4a33;border-radius:8px;color:#eee;padding:5px 8px;font:13px system-ui,sans-serif';
  const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:6px 12px;color:#fff;cursor:pointer;font:600 13px system-ui,sans-serif;background:#2a231a';
  ov.innerHTML = `
    <div style="width:min(900px,100%);max-height:90vh;display:flex;flex-direction:column;gap:10px;background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:14px;box-shadow:0 10px 40px #000">
      <div style="display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:15px">🧬 Optimiseur de build${DM.tip("Cherche l’équipement qui maximise l’objectif choisi. Par défaut, tes dégâts sur un tour : le meilleur enchaînement de sorts de dégâts qui tient dans tes PA offensifs (tous tes PA si tu n’en fixes pas), sur une cible sans résistances. Prend en compte la fusion (réelle, ou le tier simulé choisi), prestige, Bouclier de forge, bonus de panoplie (dofusdb) et PA gagnés par l’équipement. Les PV minimum évitent un build trop fragile.")}</b><button data-a="x" style="${btn};background:transparent">✕</button></div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center">
        <label data-tip="Ce que l’optimiseur maximise.&#10;Dégâts par tour : sur une cible sans résistances.&#10;Kralamoure : contre le boss de guilde, ses résistances (20 % Neutre, Terre, Feu et Air, 30 % Eau) appliquées à chaque coup ; le combat dure 10 tours, seul le total de dégâts compte.&#10;Cible : contre les résistances que tu saisis (ou celles d’un ennemi de ton dernier combat) — chaque coup devient (dégât − rés. fixe) × (1 − % rés.), jamais sous 0 ; avec des PV, nombre de tours pour la tuer.&#10;Prospection : celle de l’équipement et des panoplies + 1 par 10 de Chance ; avec « Redistribuer mes points », tous tes points vont en Chance.&#10;Sagesse : idem, points en Sagesse.&#10;Seule cette stat compte (les dégâts et PV n’entrent pas en jeu, utilise PV / PA minimum pour un plancher) ; à égalité, l’objet que tu portes déjà est gardé.">Objectif <select data-o="goal" style="${inp}">${Object.entries(BUILD_GOALS).map(([k, g]) => `<option value="${k}">${g.label}</option>`).join('')}</select></label>
        <label data-tip="Ne propose que des objets jusqu’à ce niveau. Au-dessus de ton niveau actuel, c’est une prévision : PV, PA de base et points de caractéristiques (5 par niveau) de ce niveau-là ; les objets trop hauts pour toi aujourd’hui ne sont pas équipés et les points ne sont pas appliqués. Vide = ton niveau actuel.">Niveau max <input data-o="lvlMax" type="number" min="1" max="200" placeholder="le mien" style="${inp};width:70px"></label>
        <span style="color:#b9a98c;font-size:12px" data-tip="Tous les objets sont comparés avec leurs stats T1 (stats de base, prestige et Bouclier de forge compris), quel que soit le tier de ton exemplaire ou de l’annonce HDV : un objet moyen déjà fusionné en T4 ne passe pas devant un meilleur objet encore en T1. À l’HDV, tu peux acheter le tier que tu veux ; les stats affichées restent celles du T1.">Comparaison en T1 ⓘ</span>
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
      <div data-k="tgtBox" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px">
        <span data-tip="Résistances de la cible, appliquées à chaque coup : (dégât − rés. fixe de l’élément) × (1 − % rés. de l’élément), jamais sous 0 — même formule que 🧪 Tester le calcul (tierlist). La rés. fixe pèse surtout sur les sorts à plusieurs petites lignes. Avec des PV : nombre de tours pour tuer la cible.&#10;Ennemis de ton dernier combat capturé : résistances et PV relevés (PV : combats capturés depuis la 1.85.0). Modifier une valeur passe en « Personnalisée ».">🎯 Cible</span>
        <select data-t="key" style="${inp};padding:3px 6px"></select>
        ${ELEMENTS.map((E, i) => `<span style="display:flex;align-items:center;gap:3px;color:${E.color};font-weight:700" title="${esc(E.name)} : % de résistance, puis résistance fixe">${esc(E.name.slice(0, 3))}
          <input data-t="rp" data-i="${i}" type="number" step="1" max="100" style="${inp};width:48px;padding:3px 4px">%<input data-t="rf" data-i="${i}" type="number" step="1" style="${inp};width:48px;padding:3px 4px"></span>`).join('')}
        <label style="display:flex;align-items:center;gap:3px">PV <input data-t="pv" type="number" min="0" step="1" placeholder="—" style="${inp};width:80px;padding:3px 4px"></label>
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
  const syncOpts = () => {
    $('[data-k="budgetBox"]').style.display = o.hdv ? '' : 'none';
    $('[data-k="dropsOnlyBox"]').style.display = o.bestiary ? '' : 'none';
    $('[data-k="tgtBox"]').style.display = BUILD_GOALS[o.goal]?.custom ? 'flex' : 'none';
  };
  // Cible (objectif « 🎯 ») : o.tgt = { key, name, rp[5], rf[5], pv } ; un préréglage remplit les champs, une saisie passe en « Personnalisée »
  const presets = targetPresets();
  o.tgt = { key: 'custom', name: '', rp: [0, 0, 0, 0, 0], rf: [0, 0, 0, 0, 0], pv: 0, ...o.tgt };
  if (o.tgt.key !== 'custom' && !presets[o.tgt.key]) o.tgt.key = 'custom';   // ennemi d'un ancien combat : valeurs gardées
  const saveOpts = () => { try { localStorage.setItem(BUILD_OPTS_KEY, JSON.stringify(o)); } catch { /* idem */ } };
  $('[data-t="key"]').innerHTML = `<option value="custom">Personnalisée</option>${Object.entries(presets).map(([k, t]) => `<option value="${esc(k)}">${esc(t.name)}</option>`).join('')}`;
  const fillTgt = () => {
    $('[data-t="key"]').value = o.tgt.key;
    for (const el of ov.querySelectorAll('[data-t="rp"],[data-t="rf"]')) el.value = o.tgt[el.dataset.t][+el.dataset.i] || 0;
    $('[data-t="pv"]').value = o.tgt.pv || '';
  };
  $('[data-t="key"]').addEventListener('change', (e) => {
    const k = e.target.value, p = presets[k];
    o.tgt = p ? { key: k, name: p.name.replace(/ — combat de .*$/, ''), rp: [...p.rp], rf: [...p.rf], pv: p.pv || 0 } : { ...o.tgt, key: 'custom', name: '' };
    fillTgt(); saveOpts();
  });
  for (const el of ov.querySelectorAll('[data-t="rp"],[data-t="rf"],[data-t="pv"]')) {
    el.addEventListener('input', () => {
      const t = el.dataset.t, v = +el.value || 0;
      if (t === 'pv') o.tgt.pv = Math.max(0, v); else o.tgt[t] = o.tgt[t].map((x, i) => (i === +el.dataset.i ? v : x));
      if (o.tgt.key !== 'custom') { o.tgt.key = 'custom'; o.tgt.name = ''; $('[data-t="key"]').value = 'custom'; }
      saveOpts();
    });
  }
  fillTgt();
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
      const c = Object.values(result.final).find((x) => x && ['hdv', 'drop'].includes(x.src) && offersOf(x).some((o) => String(o.listingId) === buy.dataset.buy));
      if (!c) return;
      const offer = offersOf(c).find((o) => String(o.listingId) === buy.dataset.buy);
      const price = offer.price, listingId = offer.listingId;
      const label = buy.textContent;
      if (armed !== buy) {   // 1er clic : confirmation
        disarm();
        armed = buy;
        buy.textContent = `⚠️ Confirmer ${fmt(price)} K`;
        armTimer = setTimeout(() => { if (armed === buy) { buy.textContent = label; disarm(); } }, 6000);
        return;
      }
      disarm();
      buy.disabled = true;
      buy.textContent = 'Achat…';
      try {
        await hdvCall('buyListing', [listingId]);
        Object.assign(c, { src: 'inv', bought: true, fusion: offer.fusion });   // possédé : « Équiper ce build » le prendra
        DM.log(`optimiseur : achat HDV ${c.name} ${tierName(offer.fusion)} (${price} K, annonce ${listingId})`);
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
        say(`Terminé : ${result.evals} builds testés${result.hits ? ` (+ ${result.hits} déjà vus)` : ''} en ${((Date.now() - t0) / 1000).toFixed(1)} s${result.poolSize > result.poolKept ? ` — ${result.poolKept} objets distincts sur ${result.poolSize} exemplaires` : ''}.`);
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
  const tierName = (f) => (f >= FUSION_MAX ? 'Rayonnant' : `T${(f || 0) + 1}`);
  // stats affichées = T1 ; le tier de ton exemplaire (porté, inventaire, banque) en petit
  const t1Label = (c) => `${esc(c.name)}${c.fusion && !['hdv', 'drop'].includes(c.src) ? ` <span style="color:#8a7d66;font-size:11px">(ton exemplaire : ${tierName(c.fusion)})</span>` : ''}`;
  // annonces HDV de l'objet, une par tier (la moins chère) : un bouton d'achat chacune
  const offersOf = (c) => c.hdvOffers?.length ? c.hdvOffers : c.src === 'hdv' ? [{ fusion: c.fusion || 0, price: c.price, listingId: c.listingId, seller: c.seller }] : [];
  const offerBtns = (c, sbtn) => offersOf(c).map((o) => `<button data-buy="${esc(o.listingId)}" style="${sbtn};background:#8a5a1a" title="Acheter l’annonce ${tierName(o.fusion)} (vendeur : ${esc(o.seller)}) — 2e clic pour confirmer">🛒 ${tierName(o.fusion)} ${fmt(o.price)} K</button>`).join('');
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
    hover.innerHTML = `<div style="font-weight:800">${t1Label(c)} <span style="color:#ffd76a;font-size:11px">stats T1</span></div>
      <div style="color:#8a7d66;font-size:11px">Niveau ${c.lvl ?? '?'}${c.setName ? ` · ${esc(c.setName)}` : ''}${c.src === 'hdv' ? ` · HDV : ${offersOf(c).map((o) => `${tierName(o.fusion)} ${fmt(o.price)} K`).join(', ')}` : c.src === 'worn' ? ' · porté' : c.src === 'bank' ? ` · banque (${esc(c.bankName)})` : c.src === 'drop' ? ' · à looter (bestiaire)' : ' · inventaire'}${c.two ? ' · deux mains' : ''}</div>
      <div style="margin-top:4px">${keys(c.eff).map((k) => statLine(k, c.eff[k])).join('') || '<i>aucune stat</i>'}</div>
      ${other !== c ? `<div style="margin-top:6px;border-top:1px solid #3a3024;padding-top:4px;color:#b9a98c">${side === 'new' ? `Par rapport à ${other ? esc(other.name) : 'l’emplacement vide'}` : `En passant à ${other ? esc(other.name) : 'vide'}`} :</div>
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
    const killTurns = (dmg) => (dmg > 0 ? Math.ceil(r.target.pv / dmg) : '∞');
    const gs = r.goal.stat, gA = gs ? r.goal.value(r.cur.S) : 0, gB = gs ? r.goal.value(r.nxt.S) : 0;
    const heart = (c, slot, side) => `<button data-fav="${esc(slot)}|${side}" title="${buildFavs()[c.id] ? 'Retirer des favoris' : 'Ajouter aux favoris (bulle ❤️ en bas à gauche)'}" style="background:none;border:0;cursor:pointer;padding:0 2px;font-size:13px;color:${buildFavs()[c.id] ? '#ff5c7a' : '#8a7d66'}">${buildFavs()[c.id] ? '❤' : '♡'}</button>`;
    const item = (c, slot, side) => (c ? `${heart(c, slot, side)}<span data-hover="${esc(slot)}|${side}" style="cursor:help">${c.icon ? `<img src="/img/items/${+c.icon}.png" alt="" style="width:26px;height:26px;object-fit:contain;vertical-align:middle">` : ''} ${t1Label(c)}${c.src === 'hdv' ? ` <span style="color:#f0c04a">🛒 dès ${fmt(c.price)} K</span>` : ''}${c.src === 'bank' ? ` <span style="color:#8fb8ee">🏦 ${esc(c.bankName)}</span>` : ''}${c.src === 'drop' ? ` <span style="color:#c99bff">🐉 à looter</span>${c.offer ? ` <span style="color:#f0c04a">· en vente dès ${fmt(c.offer.price)} K</span>` : ''}` : ''}${c.bought ? ' <span style="color:#6fcf7a">✔ acheté</span>' : ''}</span>` : '<i style="color:#8a7d66">vide</i>');
    const sbtn = 'border:1px solid #5a4a33;border-radius:6px;padding:2px 7px;color:#fff;cursor:pointer;font:600 11px system-ui,sans-serif;background:#2a231a;margin-left:4px';
    const tools = (c) => (!c ? '' : `${c.src === 'bank' ? (c.queued ? '<span style="color:#6fcf7a;margin-left:4px">✔ en file d’échange</span>' : `<button data-bankq="${esc(c.uid)}" style="${sbtn};background:#2e6fbf" title="Ajoute cet objet à la file d’échange de ${esc(c.bankName)} : lance « Tout échanger » depuis son onglet, puis équipe-le">📦 File d’échange</button>`) : ''}${c.src === 'hdv' || c.src === 'drop' ? offerBtns(c, sbtn) : ''}<button data-ban="${+c.id}" data-name="${esc(c.name)}" style="${sbtn}" title="Mettre en liste noire : ne plus jamais proposer cet objet">🚫</button>`);
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
  : `<div>Dégâts par tour${r.target ? ` sur ${esc(r.target.name)} (résistances comprises)` : ''} : <b>${fmt(r.curTurn.dmg)}</b> → <b style="font-size:17px;color:#6fcf7a">${fmt(r.nxtTurn.dmg)}</b> ${gain > 0.5 ? `<span style="color:#6fcf7a">(+${fmt(gain)}, +${(gain / Math.max(1, r.curTurn.dmg) * 100).toFixed(1)} %)</span>` : '<span style="color:#b9a98c">(ton build est déjà le meilleur trouvé)</span>'}</div>
        ${r.target?.pv > 0 ? `<div title="Tours moyens pour vider ses ${fmt(r.target.pv)} PV, à dégâts par tour constants (sans soins, boucliers ni buffs)">☠️ Tours pour tuer : ${killTurns(r.curTurn.dmg)} → <b style="color:#6fcf7a">${killTurns(r.nxtTurn.dmg)}</b></div>` : ''}`}
        ${hdvCost ? `<div style="color:#f0c04a">🛒 Achats HDV restants : ${fmt(hdvCost)} K${r.budget ? ` / budget ${fmt(r.budget)} K` : ''}</div>` : r.budget ? `<div style="color:#b9a98c">Budget ${fmt(r.budget)} K : aucun achat nécessaire</div>` : ''}
      </div>
      ${r.planLevel && r.planLevel !== r.sheet.level ? `<div style="font-size:12px;color:#8fd4ee">📅 ${ahead ? `Prévision au niveau ${r.planLevel} (tu es niveau ${r.sheet.level}) : objets jusqu’au niveau ${r.planLevel}, PV, PA et ${fmt(r.planCapital)} points de caractéristiques de ce niveau. Les objets au-dessus de ton niveau actuel ne seront pas équipés.` : `Objets limités au niveau ${r.planLevel} (tu es niveau ${r.sheet.level}).`}</div>` : ''}
      ${r.bestiary ? `<div style="font-size:12px;color:#c99bff">🐉 Bestiaire : ${r.bestiary.count} objet(s) lootable(s) à ton niveau que tu n’as pas, pris en compte (copie du ${new Date(r.bestiary.at).toLocaleString('fr-FR')})${drops.length ? ` — ${drops.length} à looter dans le build proposé${drops.some((c) => c.offer) ? `, dont ${drops.filter((c) => c.offer).length} en vente à l’HDV` : ''}` : ''}.</div>` : ''}
      ${r.bank ? `<div style="font-size:12px;color:#8fb8ee">🏦 Banque ${esc(r.bank.name)} : ${r.bank.count} objet(s) disponible(s)${r.bank.bound ? `, ${r.bank.bound} lié(s) ignoré(s)` : ''}.</div>` : ''}
      ${r.target?.rf ? `<div style="font-size:12px;color:#b9a98c">🎯 ${esc(r.target.name)} : ${ELEMENTS.map((E, i) => `${E.name} ${r.target.resPct[i]} %${r.target.rf[i] ? ` + ${r.target.rf[i]}` : ''}`).join(' · ')}${r.target.pv ? ` · ${fmt(r.target.pv)} PV` : ''}</div>` : ''}
      <div style="font-size:12px;color:#ffd76a">⚗️ Comparaison en T1 : stats de base de chaque objet (prestige et forge compris), quel que soit le tier de ton exemplaire ou de l’annonce HDV — un tier plus haut ne fera que les augmenter.</div>
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
    <div style="display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:15px">❤️ Favoris${DM.tip('Builds enregistrés avec 💾 dans l’optimiseur : « Ouvrir » les réaffiche sans relancer la recherche. Objets ajoutés avec le cœur ♡ de l’optimiseur de build. Clique sur un objet pour voir les boss et monstres qui le lâchent, avec tes chances ; clique sur une zone pour ouvrir ses groupes de chasse.')}</b><button data-a="clear" style="${btn}" title="Retirer tous les objets favoris (les builds enregistrés sont gardés) — 2e clic pour confirmer">🗑️ Vider tout</button><button data-a="x" style="${btn};background:transparent">✕</button></div>
    <div data-k="msg" style="font-size:12px;color:#b9a98c"></div>
    <div style="overflow-y:auto;display:flex;flex-direction:column;gap:10px">
      <div data-k="saves" style="display:flex;flex-direction:column;gap:4px"></div>
      <div data-k="cart" style="display:flex;flex-direction:column;gap:4px"></div>
      <b style="font-size:13px">❤️ Objets favoris</b>
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
      <button data-open-save="${esc(x.id)}" style="${btn};background:#2e6fbf">📂 Ouvrir</button></div>`).join('')}` : '';
    // liste de courses du farm de drop (même liste que la fenêtre 🐉 Aller dropper)
    const cart = cfg.dropCart || [];
    let tiers = {};
    try { tiers = JSON.parse(localStorage.getItem(DROP_TIERS_KEY) || '{}'); } catch { /* stockage indisponible */ }
    const inCart = new Set(cart.map((c) => c.id));
    $('[data-k="cart"]').innerHTML = `<div style="display:flex;align-items:center;gap:8px"><b style="font-size:13px;flex:1">🛒 Liste de courses${cart.length ? ` (${cart.length})` : ''}</b>
        ${cart.length ? `<label style="font-size:12px;color:#b9a98c;display:flex;align-items:center;gap:4px" title="Pendant le farm de drop (toutes les 5 min, entre deux combats) et à la fin : 3 exemplaires d’un objet de la liste → tier suivant, jusqu’au tier voulu. Les autres objets ne sont jamais fusionnés."><input type="checkbox" data-a="autoFuse"${cfg.dropAutoFuse !== false ? ' checked' : ''}> fusion auto</label>
        <label style="font-size:12px;color:#b9a98c;display:flex;align-items:center;gap:4px" title="Verrouille d’office (cadenas du jeu) les objets de la liste, tous tiers confondus : ni vendus, ni brisés, ni mis à l’HDV. Un objet retiré de la liste est déverrouillé, sauf s’il était verrouillé à la main ou fait partie d’un équipement enregistré. La fusion auto les déverrouille le temps de fusionner."><input type="checkbox" data-a="lockCart"${cfg.dropLockCart !== false ? ' checked' : ''}> 🔒 verrouiller</label>
        <button data-a="fuseCart" style="${btn}" title="Fusionne maintenant les objets de la liste jusqu’à leur tier voulu (seulement ceux-là)">⚡ Fusionner la liste</button>` : ''}
        <button data-a="drop" style="${btn};background:#6a3fa0" title="Ouvre la liste de courses complète : objets du build et favoris, tiers voulus, exemplaires déjà possédés, puis lancer le farm">🐉 ${cart.length ? 'Modifier / lancer le farm' : 'Composer la liste'}</button></div>`
      + (cart.length ? cart.map((c) => `<div style="display:flex;gap:8px;align-items:center;background:#241e16;border:1px solid #3a3024;border-radius:8px;padding:4px 8px">
        ${c.icon ? `<img src="/img/items/${+c.icon}.png" alt="" style="width:24px;height:24px;object-fit:contain">` : ''}
        <span style="flex:1">${esc(c.name)}</span><span style="color:#f0c04a;font-size:12px">T${tiers[c.id] || 1}${(tiers[c.id] || 1) === 5 ? ' (Rayonnant)' : ''}</span>
        <button data-uncart="${+c.id}" style="${btn}" title="Retirer de la liste de courses">✕</button></div>`).join('')
        : '<div style="color:#8a7d66;font-size:12px">Vide : ajoute des objets avec 🛒 sur un favori, ou depuis 🐉 Aller dropper.</div>');
    const favs = Object.entries(buildFavs()).sort((x, y) => (y[1].lvl || 0) - (x[1].lvl || 0));
    $('[data-a="clear"]').style.display = favs.length ? '' : 'none';
    $('[data-k="list"]').innerHTML = favs.length ? favs.map(([id, f]) => `<details style="background:#241e16;border:1px solid #3a3024;border-radius:8px;padding:6px 8px">
      <summary style="cursor:pointer;display:flex;align-items:center;gap:6px">${f.icon ? `<img src="/img/items/${+f.icon}.png" alt="" style="width:26px;height:26px;object-fit:contain">` : ''}
        <b style="flex:1">${esc(f.name)}</b><span style="color:#8a7d66;font-size:12px">${esc(SLOT_NAMES[f.type] || f.type || '')}${f.lvl ? ` · niv. ${f.lvl}` : ''}${f.setName ? ` · ${esc(f.setName)}` : ''}</span>
        ${f.type ? `<a href="/hdv?emplacement=${encodeURIComponent(f.type)}" target="_blank" style="${btn};text-decoration:none" title="Ouvrir l’HDV sur cet emplacement (nouvel onglet)">HDV</a>` : ''}
        <button data-tocart="${esc(id)}" style="${btn};${inCart.has(+id) ? 'background:#6a5a1a' : ''}" title="${inCart.has(+id) ? 'Dans la liste de courses (cliquer pour retirer)' : 'Ajouter à la liste de courses (farm de drop)'}">${inCart.has(+id) ? '🛒 ✔' : '🛒 +'}</button>
        <button data-unfav="${esc(id)}" style="${btn}" title="Retirer des favoris">✕</button></summary>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;font-size:12px">${sources(+id)}</div></details>`).join('')
      : '<div style="color:#b9a98c">Aucun objet favori : dans l’optimiseur de build, clique sur le cœur ♡ à côté d’un objet.</div>';
  };
  render();
  ov.addEventListener('change', (e) => {
    if (e.target.dataset.a === 'autoFuse') save({ dropAutoFuse: e.target.checked });
    if (e.target.dataset.a === 'lockCart') save({ dropLockCart: e.target.checked });
  });
  ov.addEventListener('click', async (e) => {
    if (e.target.closest('[data-a="x"]')) return close();
    if (e.target.closest('[data-a="drop"]')) {
      close();
      let r = null;
      try { const last = lastBuild(); if (last) r = unpackBuild(last.data); } catch { /* pas de dernière recherche */ }
      openDropFarm(r);
      return;
    }
    const fz = e.target.closest('[data-a="fuseCart"]');
    if (fz) {
      let tiers = {};
      try { tiers = JSON.parse(localStorage.getItem(DROP_TIERS_KEY) || '{}'); } catch { /* idem */ }
      fz.disabled = true;
      fz.textContent = 'Fusion…';
      try {
        const n = await fuseTowards(new Map((cfg.dropCart || []).map((c) => [c.id, tiers[c.id] || 1])));
        say(n ? `⚡ ${n} fusion(s) faite(s) vers les tiers voulus.` : 'Rien à fusionner : pas 3 exemplaires d’un même tier en dessous du tier voulu.');
      } catch (err) { say(`❌ ${err.message}`); }
      fz.disabled = false;
      fz.textContent = '⚡ Fusionner la liste';
      return;
    }
    const unc = e.target.closest('[data-uncart]');
    if (unc) { await save({ dropCart: (cfg.dropCart || []).filter((c) => c.id !== +unc.dataset.uncart) }); render(); return; }
    const toc = e.target.closest('[data-tocart]');
    if (toc) {
      e.preventDefault();
      const id = +toc.dataset.tocart, f = buildFavs()[id];
      const cart = cfg.dropCart || [];
      await save({ dropCart: cart.some((c) => c.id === id) ? cart.filter((c) => c.id !== id) : [...cart, { id, name: f?.name || `Objet ${id}`, icon: f?.icon }] });
      render();
      return;
    }
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
