// Autopilot-DM — content script : optimiseur de build : optimizeBuild.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

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
      setName: it.setName, two: it.two, eff: fusedStats(it.st, it.s, 0), baseEff: it.st || {}, src: 'drop' })));
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
  // Comparaison toujours en T1 : stats de base de chaque objet (+ prestige et forge), quel que soit le tier de ton
  // exemplaire ou de l'annonce — un objet moyen déjà en T4 ne passe pas devant un meilleur objet encore en T1.
  // realEff = stats réelles (contrôle du modèle sur la fiche du jeu).
  const simTier = 1;
  pool = pool.map((c) => {
    const base = c.baseEff || unfusedStats(c.eff, c.type, c.fusion || 0);
    return { ...c, realEff: withPrestige(c.eff), eff: withPrestige(fusedStats(base, c.type, 0)) };
  });
  // En T1, deux exemplaires d'un même objet se valent : une seule entrée par objet — porté, sinon inventaire (le tier
  // le plus haut), banque, HDV (l'annonce la moins chère), à looter. Les annonces HDV de chaque tier y sont jointes
  // (hdvOffers) : on peut acheter un tier plus haut, les stats affichées restent celles du T1.
  const SRC_RANK = { worn: 0, inv: 1, bank: 2, hdv: 3, drop: 4 };
  const offersById = new Map();
  for (const c of pool) {
    if (c.src !== 'hdv') continue;
    if (!offersById.has(c.id)) offersById.set(c.id, []);
    offersById.get(c.id).push({ fusion: c.fusion || 0, price: c.price, listingId: c.listingId, seller: c.seller });
  }
  for (const list of offersById.values()) list.sort((a, b) => a.fusion - b.fusion || a.price - b.price);
  const better = (a, b) => SRC_RANK[a.src] - SRC_RANK[b.src] || (a.src === 'hdv' ? a.price - b.price : (b.fusion || 0) - (a.fusion || 0));
  const keep = new Map();
  for (const c of pool) if (c.src !== 'worn' && (!keep.has(c.id) || better(c, keep.get(c.id)) < 0)) keep.set(c.id, c);
  const wornIds = new Set(pool.filter((c) => c.src === 'worn').map((c) => c.id));
  const poolSize = pool.length;
  pool = pool.filter((c) => c.src === 'worn' || (!wornIds.has(c.id) && keep.get(c.id) === c))
    .map((c, i) => ({ ...c, uid: i, hdvOffers: offersById.get(c.id) || [] }));
  const banned = new Set(Object.keys(buildBlacklist()).map(Number));
  const budget = opts.hdv && +opts.budget > 0 ? +opts.budget : 0;   // 0 = pas de limite

  // cible à résistances : chaque élément pèse (1 − % rés.) — les dégâts d'un élément étant linéaires en B et N,
  // réduire le profil du sort revient à appliquer la résistance à chaque coup
  const goal = BUILD_GOALS[opts.goal] || (opts.krala ? BUILD_GOALS.krala : BUILD_GOALS.dps);   // opts.krala : ancienne case à cocher
  // objectif « cible » : % rés. (plafonnés à 100), rés. fixes par élément et PV saisis dans l'optimiseur
  const tg = opts.tgt || {};
  // Ascension : boss de l'étage (dernier essai connu) ; cible = leurs résistances moyennes pondérées par les PV
  let asc = null;
  if (goal.asc) {
    say('Boss de l’étage (essais enregistrés)…');
    asc = await ascOptimizerData(+opts.ascFloor || +cfg.ascFloor);
    const tot = asc.bosses.reduce((t, b) => t + b.maxHp, 0) || 1;
    asc.target = { name: `étage ${asc.floor}`, resPct: [0, 1, 2, 3, 4].map((i) => asc.bosses.reduce((t, b) => t + b.res[i] * b.maxHp, 0) / tot), rf: [0, 0, 0, 0, 0] };
    asc.avgRes = asc.target.resPct.reduce((t, x) => t + x, 0) / 5 / 100;
  }
  const target = asc ? asc.target : goal.custom ? { name: tg.name || 'la cible', resPct: [0, 1, 2, 3, 4].map((i) => Math.min(100, +tg.rp?.[i] || 0)),
    rf: [0, 1, 2, 3, 4].map((i) => +tg.rf?.[i] || 0), pv: Math.max(0, +tg.pv || 0) } : goal.target || null;
  const goalStat = goal.stat || null;
  const goalKeys = goalStat ? [goalStat, ...(goal.also || [])] : [];
  const vsTarget = (pf) => (!pf || !target ? pf
    : { ...pf, B: pf.B.map((b, el) => b * (1 - target.resPct[el] / 100)), BC: pf.BC.map((b, el) => b * (1 - target.resPct[el] / 100)),
      FW: pf.FW * (1 - target.resPct[pf.F] / 100), N: pf.N.map((n, el) => n * (1 - target.resPct[el] / 100)),
      R: target.rf?.some(Boolean) ? target.rf : null });
  const spells = sp.spells.filter((x) => !opts.deckOnly || sp.activeDeck.has(x.id))
    .map((x) => ({ ...x, pf: vsTarget(spellProfile(x.card)) })).filter((x) => x.pf);
  if (!spells.length) throw new Error(opts.deckOnly ? 'Aucun sort de dégâts dans ton deck actif' : 'Aucun sort de dégâts');
  // PA offensifs (option) : les PA du tour qui servent à taper, le reste allant aux buffs/shield. Vide = tous les PA.
  // Sorts conseillés (deckN) : affichage seulement, ne change pas les objets choisis.
  const paOff = Math.max(0, Math.min(15, Math.round(+opts.paOff || 0)));
  const deckN = Math.max(1, Math.min(8, +opts.deckN || 4));
  const pvMin = +opts.pvMin || 0;
  const paMin = +opts.paMin || 0;
  const slots = state.slots;

  // utile = stats offensives, PA/PO, vitalité si PV minimum, ou panoplie
  const useful = (c) => c.src === 'worn' || c.setName || OFFENSE_KEYS.some((k) => (c.eff[k] || 0) > 0)
    || (pvMin && ((c.eff.vitalite || 0) > 0 || (c.eff.pv || 0) > 0)) || goalKeys.some((k) => (c.eff[k] || 0) > 0)
    || (asc && SURVIVAL_KEYS.some((k) => (c.eff[k] || 0) > 0));
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
      for (let el = 0; el < 5; el++) w[EL_STAT[el]] += (x.pf.B[el] * (1 - p) + x.pf.BC[el] * p) * pct / 100;
    }
    return w;
  };
  // Répartition des points (option « redistribuer ») : Vitalité pour le PV minimum, puis chaque point là où il rapporte
  // le plus de dégâts par point dépensé (paliers de coût compris) ; recalcul des sorts du tour jusqu'à stabilité.
  // vitShare (Ascension) : part du capital mise d'abord en Vitalité, avant la répartition pour les dégâts
  const allocate = (gear, vitShare = 0) => {
    const alloc = Object.fromEntries(POINT_STATS.map((k) => [k, 0]));
    const S0 = { ...gear };
    let R0 = planCapital;
    // achat de points par paliers entiers (coût constant jusqu'au palier suivant) : au plus `max` points de k ; renvoie le reste
    const nextTier = (k, v) => (sheet.tiers[k] || ELEM_POINT_TIERS).reduce((u, [th]) => (th > v && th < u ? th : u), Infinity);
    const buy = (S, al, k, R, max = Infinity) => {
      const tiers = sheet.tiers[k] || ELEM_POINT_TIERS;
      while (max > 0) {
        const v = al[k], c = pointCost(tiers, v);
        const n = Math.min(nextTier(k, v) - v, Math.floor(R / c), max);
        if (!(n > 0)) break;
        al[k] += n; S[k] = (S[k] || 0) + n; R -= n * c; max -= n;
      }
      return R;
    };
    if (pvMin && pvOf(S0) < pvMin) R0 = buy(S0, alloc, 'vitalite', R0, pvMin - pvOf(S0));   // 1 point de Vitalité = 1 PV
    if (vitShare > 0) R0 = buy(S0, alloc, 'vitalite', R0, Math.floor(R0 * vitShare));
    if (goal.points) {   // objectif Sagesse, Prospection : tout le reste du capital dans la stat qui la donne
      const R = buy(S0, alloc, goal.points, R0);
      buy(S0, alloc, 'vitalite', R);
      return { S: S0, alloc, turn: turnOf(S0) };
    }
    let refS = S0, refTurn = turnOf(S0), best = null;
    for (let it = 0; it < 3; it++) {
      const w = pointWeights(refTurn.used, refS);
      const S = { ...S0 }, al = { ...alloc };
      let R = R0;
      if (OFF_POINT_STATS.some((k) => w[k] > 0)) {
        // les poids étant fixes, la stat choisie reste la meilleure jusqu'à son palier suivant : achetée d'un bloc
        for (;;) {
          let pick = null, ratio = 0;
          for (const k of OFF_POINT_STATS) {
            const c = pointCost(sheet.tiers[k] || ELEM_POINT_TIERS, al[k]);
            if (w[k] > 0 && c <= R && w[k] / c > ratio) { ratio = w[k] / c; pick = k; }
          }
          if (!pick) break;
          R = buy(S, al, pick, R, nextTier(pick, al[pick]) - al[pick]);
        }
      }
      R = buy(S, al, 'vitalite', R);   // reste → Vitalité
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
    if (asc) {   // Ascension : plus ou moins de Vitalité, on garde la meilleure marge de survie
      let best = null;
      for (const share of [0, 0.25, 0.5, 0.75, 1]) {
        const a = allocate(st.S, share);
        const v = ascSurvival(a.S, pvOf(a.S), a.turn.dmg, asc, asc.avgRes).ratio;
        if (!best || v > best.v) best = { a, v };
      }
      return { S: best.a.S, active: st.active, alloc: best.a.alloc, turn: best.a.turn };
    }
    const a = allocate(st.S);
    return { S: a.S, active: st.active, alloc: a.alloc, turn: a.turn };
  };
  // score mémorisé par build (les recherches repassent souvent par les mêmes) ; evals = builds différents évalués
  let evals = 0, hits = 0;
  const memo = new Map();
  const score = (build) => {
    const key = slots.map((s) => build[s.slot]?.uid ?? '-').join(',');
    const known = memo.get(key);
    if (known !== undefined) { hits++; return known; }
    const v = scoreRaw(build);
    if (memo.size < 2e6) memo.set(key, v);
    return v;
  };
  const scoreRaw = (build) => {
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
    // Ascension : marge de survie (PV effectifs ÷ dégâts encaissés pour tout tuer) ; à égalité, les dégâts
    if (asc) return ascSurvival(ev.S, pv, ev.turn.dmg, asc, asc.avgRes).ratio * 1e6 + ev.turn.dmg * 1e-3;
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

  let lastYield = Date.now();   // rend la main à la page toutes les 50 ms (affichage de la progression)
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
        if (Date.now() - lastYield > 50) { lastYield = Date.now(); await sleep(0); }
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
        if (Date.now() - lastYield > 50) { lastYield = Date.now(); await sleep(0); }
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
        c.hdvOffers = offers.filter((x) => x.id === c.id).map((o) => ({ fusion: o.fusion || 0, price: o.price, listingId: o.listingId, seller: o.seller }))
          .sort((a, b) => a.fusion - b.fusion || a.price - b.price);
        const o = [...c.hdvOffers].sort((a, b) => a.price - b.price)[0];
        if (o) c.offer = o;
      }
    }
  }
  // actuel : équipement et points tels quels ; proposé : nouvel équipement (+ points redistribués si l'option est active)
  const cur = evalBuild(current, false), nxt = evalBuild(final);
  const curTurn = cur.turn, nxtTurn = nxt.turn;
  // contrôle du modèle : stats calculées pour l'équipement actuel (fusions réelles) vs fiche du jeu
  const realS = evalBuild(Object.fromEntries(Object.entries(current).map(([k, c]) => [k, c && { ...c, eff: c.realEff }])), false).S;
  const checks = [
    ['PV', buildPvOf(level)(realS), sheet.pv], ['PA', buildPaOf(level, sheet.prestige)(realS), sheet.pa],   // fiche = niveau actuel
    ...Object.keys(sheet.bonus).map((k) => [STAT_LABELS[k] || k, realS[k] || 0, (sheet.base[k] || 0) + sheet.bonus[k]]),
  ].filter(([, a, b]) => Number.isFinite(b));
  // deck conseillé : deckN sorts offensifs (ceux du tour d'abord, les plus forts ; complétés par les plus forts du build)
  const ranked = spells.filter((x) => x.usable).map((x) => ({ sp: x, v: profileAvg(x.pf, nxt.S) })).sort((a, b) => b.v - a.v);
  const deck = [...nxtTurn.used].sort((a, b) => b.v - a.v).map((u) => u.sp).slice(0, deckN);
  for (const { sp: x } of ranked) { if (deck.length >= deckN) break; if (!deck.includes(x)) deck.push(x); }
  // cartes non offensives déjà dans le deck 3 (buffs, soins…) : conservées, c'est toi qui les choisis
  const dmgIds = new Set(sp.spells.map((x) => x.id));
  const keepCards = sp.deckIds(DECK_TARGET).filter((id) => !dmgIds.has(id) && !deck.some((x) => x.id === id)).slice(0, DECK_CARDS - deck.length);
  const ascRes = asc ? { ...asc, cur: ascSurvival(cur.S, pvOf(cur.S), curTurn.dmg, asc, asc.avgRes), nxt: ascSurvival(nxt.S, pvOf(nxt.S), nxtTurn.dmg, asc, asc.avgRes) } : null;
  return { asc: ascRes, simTier, gearMult, sheet, slots, current, final, cur, nxt, curTurn, nxtTurn, pvOf, paOf, checks, evals, hits, poolSize, poolKept: pool.length, paOff, deckN, planLevel, statLevel, planCapital, setFx, hdv: opts.hdv, target, goal, bestiary,
    ownTol, ownKept, ownLoss: ownKept && bestFound > 0 ? (1 - top.best / bestFound) * 100 : 0,
    pvMin, pvShort: pvMin && pvOf(nxt.S) < pvMin, paMin, paShort: paMin && paOf(nxt.S) < paMin, bank, budget, hdvFailed, realloc: opts.realloc !== false, cost: costOf(final), deck: deck.map((x) => ({ sp: x, v: profileAvg(x.pf, nxt.S) })),
    deckChunks: sp.chunks, keepCards };
}
