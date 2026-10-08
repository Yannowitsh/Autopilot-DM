// Autopilot-DM — content script : farm de drop.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

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
// Monstres utiles dans une zone : nom normalisé → meilleure chance (0 = objet bonus de victoire, chance non publiée).
function dropTargetMap(zone, run = cfg.dropRun) {
  const m = new Map();
  for (const it of dropLeft(run)) {
    for (const s of it.srcs) if ((s.z || []).includes(zone)) { const k = normName(s.m); m.set(k, Math.max(m.get(k) ?? 0, s.p || 0)); }
  }
  return m;
}
const dropTargets = (zone, run = cfg.dropRun) => new Set(dropTargetMap(zone, run).keys());
// Intérêt d'un groupe : nombre de monstres qui lâchent un objet voulu (chaque monstre compte), puis leurs chances.
function dropGroupScore(names, targets) {
  let n = 0, p = 0;
  for (const nm of names) { const k = normName(nm); if (targets.has(k)) { n++; p += targets.get(k); } }
  return n ? n + Math.min(p, 99) / 100 : 0;
}

// Groupe à attaquer sur la page de la zone : le plus intéressant ; false si aucun ; null si la page n'est pas chargée.
function dropPickGroup() {
  const cards = groupCards();
  if (!cards.length) return null;
  const targets = dropTargetMap(cfg.huntZone);
  let best = null;
  for (const p of cards) {
    const s = dropGroupScore(groupMonsters(p), targets);
    if (s && (!best || s > best.s)) best = { g: groupNumber(p), s };
  }
  return best ? best.g : false;
}

// Zone suivante : toutes les zones utiles sont scannées (groupes du moment) et on va au groupe le plus intéressant,
// toutes zones confondues. Refait à chaque changement de zone (les groupes se renouvellent toutes les ~3 min).
async function dropGoZone(why) {
  if (!cfg.dropRun?.active) return;
  await dropSyncInventory(true);   // coffres, achats… depuis la dernière relecture
  const run = cfg.dropRun;
  if (!run?.active) return;
  if (!dropLeft(run).length) return dropFinish();
  const zones = dropZones(run).map(([z]) => z);
  if (!zones.length) return dropStop(`plus aucune zone possible (${run.skipped?.length || 0} abandonnée(s) après ${DROP_MAX_DEFEATS} défaites). Objets manquants : ${dropLeft(run).map((it) => it.name).join(', ')}`);
  setStatus(`Farm de drop : ${why} — recherche des meilleurs groupes (${zones.length} zone(s))…`);
  progress();
  let best = null, done = 0;
  const queue = [...zones];
  const worker = async () => {
    for (let z = queue.shift(); z != null; z = queue.shift()) {
      try {
        const { groups } = await scanZone(z);
        const targets = dropTargetMap(z, run);
        for (const g of groups) {
          const s = dropGroupScore(g.monsters.map((m) => m.name), targets);
          if (s && (!best || s > best.s)) best = { z, g: g.n, s, names: g.monsters.map((m) => m.name) };
        }
      } catch { /* zone sans groupe ou illisible */ }
      done++;
      if (done % 4 === 0) { setStatus(`Farm de drop : recherche des meilleurs groupes (${done}/${zones.length})…`); progress(); }
      await sleep(150);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, zones.length) }, worker));
  if (!cfg.dropRun?.active) return;
  if (!best) {
    return dropStop(`aucun groupe avec les monstres voulus dans les ${zones.length} zone(s) possible(s) en ce moment. Objets manquants : ${dropLeft(run).map((it) => it.name).join(', ')}`);
  }
  const z = best.z;
  DM.log(`farm de drop : ${why} → ${dropZoneName(z)}, groupe ${best.g} (${Math.floor(best.s)} monstre(s) utile(s) : ${best.names.join(', ')})`);
  await save({ dropRun: { ...cfg.dropRun, zone: z, tried: [] }, huntZone: z, huntZoneName: dropZoneName(z), huntGroup: best.g, huntTarget: null, lossStreak: 0 });
  setStatus(`Farm de drop : ${dropZoneName(z)}, groupe ${best.g} (${Math.floor(best.s)} monstre(s) utile(s))…`);
  progress();
  if (isOwner()) location.assign(`/chasse?zone=${z}`);
}

// Relecture de l'inventaire pendant le farm (coffres, HDV, échanges… arrivent aussi) : reçus = possédés maintenant −
// possédés au lancement (équivalents T1, inventaire + porté). Toutes les DROP_SYNC_MS entre deux combats, et à chaque
// changement de zone. Le butin de fin de combat reste compté tout de suite entre deux relectures.
const DROP_SYNC_MS = 5 * 60000;
async function dropSyncInventory(force = false) {
  const run = cfg.dropRun;
  if (!run?.active || (!force && Date.now() - (run.syncAt || 0) < DROP_SYNC_MS)) return;
  let st;
  try { st = await fetchEquipState(); } catch (e) { DM.log(`farm de drop : inventaire illisible (${e.message})`); return; }
  const owned = new Map();
  for (const e of st.entries) owned.set(e.id, (owned.get(e.id) || 0) + e.qty * 3 ** (e.fusion || 0));
  for (const s of st.slots) if (s.cur) owned.set(s.cur.id, (owned.get(s.cur.id) || 0) + 3 ** (s.cur.fusion || 0));
  const cur = cfg.dropRun;
  if (!cur?.active) return;
  const items = cur.items.map((it) => {
    if (it.startOwned == null) return it;   // farm lancé avant cette version : pas de point de départ
    const got = Math.max(0, Math.min(it.need, (owned.get(it.id) || 0) - it.startOwned));
    if (got > it.got) DM.log(`farm de drop : ${it.name} ${it.got} → ${got}/${it.need} (inventaire)`);
    return { ...it, got };
  });
  const before = cur.items.filter((it) => it.got < it.need).length;
  await save({ dropRun: { ...cur, items, syncAt: Date.now() } });
  if (cfg.dropAutoFuse !== false) {   // 3 exemplaires → tier suivant, jusqu'au tier voulu (objets de la liste seulement)
    const n = await fuseTowards(new Map(items.map((it) => [it.id, it.tier || 1])));
    if (n) DM.log(`farm de drop : ${n} fusion(s) vers les tiers voulus`);
  }
  for (const it of items) {
    const old = cur.items.find((x) => x.id === it.id);
    if (it.got >= it.need && old && old.got < old.need) notify('drop', `🐉 **${it.name}** : ${it.got}/${it.need} ✔ (trouvé dans l’inventaire)`);
  }
  if (before && !dropLeft().length) await dropFinish();
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
// fuse = false : remplacé par une autre activité, on ne la fait pas attendre (fusions faites toutes les 5 min pendant le farm)
async function dropEnd(status, msg, fuse = true) {
  const run = cfg.dropRun;
  if (!run) return;
  if (fuse && cfg.dropAutoFuse !== false) {
    try { await fuseTowards(new Map(run.items.map((it) => [it.id, it.tier || 1]))); } catch { /* fusion facultative */ }
  }
  const prev = run.prev || {};
  await save({ dropRun: { ...run, active: false, endedAt: Date.now() }, enabled: false, paused: false, botFight: false, status,
    mode: prev.mode || cfg.mode, huntZone: prev.huntZone ?? null, huntZoneName: prev.huntZoneName || '', huntGroup: prev.huntGroup ?? null, huntTarget: null });
  notify('drop', msg);
}
const dropFinish = () => dropEnd('Farm de drop terminé ✔',
  `✅ **Farm de drop terminé** : tout est droppé (${(cfg.dropRun?.items || []).map((it) => `${it.name} ×${it.need}`).join(', ')}). Pilote arrêté.`);
const dropStop = (reason, fuse = true) => dropEnd(`Farm de drop arrêté : ${reason}`.slice(0, 200), `⏹️ **Farm de drop arrêté** : ${reason}`, fuse);

// Lancement depuis l'optimiseur : items = [{ id, name, icon, tier, srcs }], zoneNames = { id: libellé }.
async function startDropFarm(items, zoneNames) {
  if (sampleOn()) await sampleStop('remplacé par 🐉 Farm de drop');
  const run = {
    active: true, startedAt: Date.now(), syncAt: Date.now(), zoneNames, tried: [], skipped: [], zone: null,
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
    ...(cfg.dropCart || []).map((c) => ({ ...c, from: 'cart' })),   // liste de courses gardée d'une fois sur l'autre
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
  // liste de courses : celle gardée (cfg.dropCart), modifiée au fil des coches
  const inCart = new Set((cfg.dropCart || []).map((c) => c.id));
  const cart = new Set(items.map((x, i) => (inCart.has(x.c.id) && x.srcs.length ? i : -1)).filter((i) => i >= 0));
  const saveCart = () => save({ dropCart: [...cart].map((i) => ({ id: items[i].c.id, name: items[i].c.name, icon: items[i].c.icon })) });
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
      <input type="checkbox" data-i="${i}" ${srcs.length ? '' : 'disabled'}${cart.has(i) ? ' checked' : ''}>
      ${icon(c)}
      <span style="flex:1;min-width:0"><b>${esc(c.name)}</b> <span style="font-size:11px;color:${c.from === 'fav' ? '#ff5c7a' : c.from === 'cart' ? '#f0c04a' : '#c99bff'}">${c.from === 'fav' ? '❤️ favori' : c.from === 'cart' ? '🛒 liste' : '🧬 build'}</span>${have ? ` <span style="font-size:11px;color:#6fcf7a">🎒 ${haveTxt(have)}</span>` : ''}<br><span style="color:#8a7d66;font-size:12px">${!srcs.length ? 'pas obtenable en chasse (boss du Chemin ou de chasse…)'
        : best > 0 ? `meilleure chance ${pct(best)} · ${new Set(srcs.flatMap((s) => s.z)).size} zone(s) · ${esc(srcs.slice().sort((a, b) => b.p - a.p).slice(0, 2).map((s) => `${s.m} (${pct(s.p)})`).join(', '))}`
        : `objet bonus de victoire (chance non publiée) · ${esc([...new Set(srcs.flatMap((s) => s.z))].map((z) => zones[z]?.[0] || `zone ${z}`).slice(0, 3).join(', '))}`}</span></span>
    </label>`).join('') || '<div style="color:#b9a98c">Aucun objet : lance l’optimiseur (ses objets apparaissent ici) ou ajoute des favoris ❤️ avec le cœur ♡.</div>'}</div>
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
    if (t.dataset.i != null) { if (t.checked) cart.add(+t.dataset.i); else cart.delete(+t.dataset.i); saveCart(); renderCart(); }
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
      saveCart();
      renderCart();
      return;
    }
    const rm = e.target.closest('[data-rm]');
    if (rm) { cart.delete(+rm.dataset.rm); const cb = $(`[data-i="${rm.dataset.rm}"]`); if (cb) cb.checked = false; saveCart(); renderCart(); return; }
    if (!e.target.closest('[data-a="go"]') || !cart.size) return;
    const pick = [...cart].filter((i) => needOf(i) > 0).map((i) => ({ ...items[i], i }));
    if (!pick.length) { $('[data-k="msg"]').textContent = 'Tous les tiers voulus sont déjà atteints avec tes objets.'; return; }
    const zoneNames = {};
    for (const { srcs } of pick) for (const s of srcs) for (const z of s.z) zoneNames[z] = zones[z]?.[0] || `Zone ${z}`;
    try {
      $('[data-k="msg"]').textContent = 'Lancement…';
      await startDropFarm(pick.map(({ c, srcs, have, i }) => ({ id: c.id, name: c.name, icon: c.icon, tier: tierOf(i), need: needOf(i), startOwned: have || 0, srcs })), zoneNames);
      close();
      document.querySelector('.dm-picker')?.remove();
    } catch (err) {
      $('[data-k="msg"]').textContent = `❌ ${err.message}`;
    }
  });
}
