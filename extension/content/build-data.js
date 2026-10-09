// Autopilot-DM — content script : optimiseur de build : données (stats, panoplies, bestiaire, forge, fiche perso, HDV).
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

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
  cible: { label: '🎯 Dégâts sur une cible', custom: true },   // résistances et PV saisis (opts.tgt)
  prospection: { label: '💰 Prospection', stat: 'prospection', points: 'chance', also: ['chance'],
    value: (S) => 100 + (S.prospection || 0) + Math.floor((S.chance || 0) / 10) },
  sagesse: { label: '📚 Sagesse', stat: 'sagesse', points: 'sagesse', value: (S) => S.sagesse || 0 },
  asc: { label: '🏔️ Ascension (survie)', asc: true },   // marge de survie contre les boss d'un étage (ascOptimizerData)
};
// Ascension : stats qui comptent pour la survie (en plus des dégâts)
const SURVIVAL_KEYS = ['vitalite', 'pv', 'resPctNeutre', 'resPctTerre', 'resPctFeu', 'resPctEau', 'resPctAir', 'resNeutre', 'resTerre', 'resFeu', 'resEau', 'resAir'];
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
// Plafond de PA : 12, 13 dès le Prestige 2, 14 au P5, 15 au P8 (patch 2.3).
const paCap = (p) => 12 + [2, 5, 8].filter((n) => (p || 0) >= n).length;
const buildPaOf = (level, prestige = 0) => (S) => Math.min(paCap(prestige), 6 + prestigePa(prestige) + (S.pa || 0));
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
  return JSON.parse(JSON.stringify({ ...rest, goalKey, bestiary: r.bestiary ? { count: r.bestiary.count, at: r.bestiary.at, zones } : null },
    (k, v) => (k === 'baseEff' || k === 'realEff' ? undefined : v)));
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
      const res = actionResult(text);
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
    if (c?.v === 3 && Date.now() - c.at < BESTIARY_MS) return c;
  } catch { /* copie absente ou illisible */ }
  say?.('Import du bestiaire (copie locale absente ou de plus d’un jour)…');
  const { flight } = await fetchFlight('/bestiaire');
  const { props } = rscProps(flight, (x) => Array.isArray(x.monsters) && Array.isArray(x.items));
  if (!props) throw new Error('Bestiaire illisible');
  // zones : id (le même que /chasse?zone=) → [nom (région), niveau min, niveau max]
  const zones = Object.fromEntries((props.zones || []).map((z) => [z.id, [z.area && z.area !== z.n ? `${z.n} (${z.area})` : z.n, z.min, z.max]]));
  const items = props.items.filter((it) => it?.id).map((it) => ({ id: it.id, n: it.n, lvl: it.lvl, s: it.s, icon: it.icon, r: it.r,
    st: it.st || {}, setName: it.setName || null, two: !!it.w?.twoHanded }));
  const drops = {};   // id objet → [[monstre, niveau min, niveau max, ta chance %, ids de zones, chance de base %]], meilleure chance d'abord
  for (const m of props.monsters) {
    for (const [id, base, mine] of Array.isArray(m.d) ? m.d : []) {
      (drops[id] ||= []).push([m.n, m.lo, m.hi, +mine || 0, m.z || [], +base || 0]);
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
  const out = { v: 3, at: Date.now(), items, drops, boss, zones };
  try { localStorage.setItem(BESTIARY_KEY, JSON.stringify(out)); } catch (e) { DM.log(`bestiaire : copie locale impossible (${e.message})`); }
  DM.log(`bestiaire : ${items.length} objets, ${props.monsters.length} monstres importés`);
  return out;
}

// Multiplicateur de l'équipement = 1 + Prestige (+25 % par niveau) + Bouclier de forge (forgeBonusPct du jeu), appliqué
// aux objets ET aux bonus de panoplie, arrondi objet par objet, hors PA/PM/PO/invocations (ex. P3 + forge niv. 98 :
// 1 + 0,75 + 0,132 = ×1,882, relevé au point près sur la fiche). Contrôlé sur la fiche (bonus des points de
// caractéristiques = Σ arrondi(stat × m) des objets portés et des panoplies actives) ; recalé seulement s'il ne colle pas.
const FORGE = { maxLevel: 200 };
const forgeBonusPct = (lvl) => {   // même calcul que le site depuis le 08/10 : 150^((niv − 1) / 199) % (+150 % au niv. 200), arrondi
  if (!(lvl > 0)) return 0;
  const v = 150 ** ((Math.min(FORGE.maxLevel, lvl) - 1) / (FORGE.maxLevel - 1));
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
  // objets éternels (un par Prestige) : { prestige, n, fusion } — Rayonnant +5 à vie, jamais rabaissés par le tier simulé
  const eternal = (res(info.eternal) || []).map(res).filter((e) => e?.n);
  return { level: +info.level || 1, prestige: +info.prestige || 0, forge, forgePct: forgeBonusPct(forge), base, bonus, tiers, pointsFree, capital,
    pv: tile('PV'), pa: tile('PA'), crit: tile('% Critique'), sets, eternal, ascensionBest: +info.ascensionBest || 0 };
}

// Signature de dégâts d'une carte : par élément, base moyenne cumulée normale (B) et critique (BC), nombre de coups
// (N, pour les résistances fixes) ; F = élément de la 1re ligne de dégâts, qui seule reçoit les Dommages fixes (poids FW).
function spellProfile(card) {
  const B = [0, 0, 0, 0, 0], BC = [0, 0, 0, 0, 0], N = [0, 0, 0, 0, 0];
  let F = null, FW = 0;
  for (const { e, c, el, first } of damageLines(card)) {
    const n = e.k === 'poison' ? Math.max(1, +(e.turns || e.dur) || 1) : 1;
    const w = e.chance != null && +e.chance < 100 ? Math.max(0, +e.chance) / 100 : 1;
    const avg = ((+e.min || 0) + (+(e.max ?? e.min) || 0)) / 2;
    B[el] += w * n * avg;
    BC[el] += w * n * (c ? ((+c.min || 0) + (+(c.max ?? c.min) || 0)) / 2 : avg * CRIT_MULT);
    N[el] += w * n;
    if (first) { F = el; FW = w; }
  }
  return F != null ? { B, BC, N, F, FW, cc: +card.cc || 0 } : null;
}
// Dégâts moyens d'un sort avec ces stats (même formule que spellDamage, en version rapide).
// pf.R (cible à résistances fixes) : retirées à chaque coup, après les % Dommages ; B, BC, N et FW portent déjà (1 − % rés.).
function profileAvg(pf, S) {
  const pct = 1 + (S.dmgPctSorts || 0) / 100, spectral = 1 + (S.po || 0) * SPECTRAL_PER_PO / 100;
  const p = pf.cc > 0 ? Math.min(1, Math.max(0, (pf.cc + (S.critique || 0)) / 100)) : 0;
  let tot = 0;
  for (let el = 0; el < 5; el++) {
    if (!pf.N[el]) continue;
    const m = 1 + ((S[EL_STAT[el]] || 0) + (S.puissance || 0)) / 100;
    let v = (pf.B[el] * (1 - p) + pf.BC[el] * p) * m;
    if (el === pf.F) v += pf.FW * ((S.dommages || 0) + (S[EL_DMG[el]] || 0) + p * (S.dommagesCritiques || 0));
    v *= pct;
    tot += pf.R ? Math.max(0, v - pf.N[el] * pf.R[el]) : v;
  }
  return tot * spectral;
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
        baseEff: rscResolve(rows, it.st) || {}, src: 'hdv', price: +l.price || 0, listingId: l.id, seller: l.seller });
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
        setName: e.setName, two: e.two, eff: e.eff, baseEff: e.baseEff }));
    return { ok: true, name: myName(), entries, bound: state.entries.length - entries.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
