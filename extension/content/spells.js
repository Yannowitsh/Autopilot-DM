// Autopilot-DM — content script : tierlist des sorts + test du calcul.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

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
// Dégâts réels (option « Avec mes stats ») — formule vérifiée coup par coup sur les combats enregistrés (129/129, 2 builds) :
// chaque ligne : base × (1 + (stat de l'élément + Puissance) / 100), base tirée à part pour chaque ligne ;
// + Dommages + Dommages <élément de la ligne> (+ Dommages Critiques si critique) UNE fois par lancer, sur la 1re ligne de dégâts ;
// le tout × (1 + % Dommages aux sorts) (non vérifié). Neutre et Terre = Force, Feu = Intelligence, Eau = Chance, Air = Agilité.
// Critique : chance de la carte + % Critique (seulement si la carte peut critiquer) ; le coup utilise les lignes critiques
// de la carte (champ `crit` de l'état de combat, appris en combat : /deck ne les donne pas), sinon base × CRIT_MULT.
// Les buffs de stats (Runification, Drain Élémentaire…) s'ajoutent aux stats pendant leur durée. Zone : les autres cibles
// prennent les mêmes dégâts. Vision spectrale : 0,4 % par point de PO qu'un sort de dégâts frappe deux fois (en moyenne).
const EL_STAT = ['force', 'force', 'intelligence', 'chance', 'agilite'];
const EL_DMG = ['dommagesNeutre', 'dommagesTerre', 'dommagesFeu', 'dommagesEau', 'dommagesAir'];
const CRIT_MULT = 1.2;   // repli seulement (lignes critiques inconnues) : de +5 à ×1,6 selon la carte
// Lignes critiques des cartes, apprises dans les états de combat : { idCarte: [lignes] } (localStorage de la page).
const CARD_CRIT_KEY = 'dmCardCrit';
let cardCritCache = null;
const cardCrits = () => {
  if (!cardCritCache) { try { cardCritCache = JSON.parse(localStorage.getItem(CARD_CRIT_KEY) || '{}'); } catch { cardCritCache = {}; } }
  return cardCritCache;
};
function learnCardCrits(st) {
  const p = st?.fighters?.p;
  if (!p) return;
  const known = cardCrits();
  let changed = false;
  for (const c of [...Object.values(p.cards || {}), p.weaponCard]) {
    if (!c?.id || !Array.isArray(c.crit) || JSON.stringify(known[c.id]) === JSON.stringify(c.crit)) continue;
    known[c.id] = c.crit;
    changed = true;
  }
  if (changed) { try { localStorage.setItem(CARD_CRIT_KEY, JSON.stringify(known)); } catch { /* stockage plein */ } }
}
const critLinesOf = (card) => (Array.isArray(card?.crit) ? card.crit : cardCrits()[card?.id]) || null;
// Lignes de dégâts d'une carte : { e: ligne normale, c: ligne critique (même rang dans `crit`) ou null, el, first }.
function damageLines(card) {
  const crit = critLinesOf(card);
  const pair = Array.isArray(crit) && crit.length === (card.eff || []).length;
  const out = [];
  (card.eff || []).forEach((e, i) => {
    if (!e || !DMG_FIXED.has(e.k)) return;
    const c = pair && crit[i]?.k === e.k ? crit[i] : null;
    out.push({ e, c, el: Number.isInteger(e.el) ? e.el : 0, first: !out.length });
  });
  return out;
}
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
    learnCardCrits(st);
    if (obj.rewards && st?.status && st.status !== 'ongoing') { dropOnRewards(obj.rewards, `${st.kind}|${st.logCount}`); farmOnRewards(st, obj.rewards); }
    if (st?.status && st.status !== 'ongoing') combatOnEnd(st, obj.rewards);
    if (!st?.fighters?.p?.stats || !st.log?.some((L) => L.t === 'play' && L.who === 'p')) return;
    const fighters = Object.fromEntries(Object.entries(st.fighters).map(([id, f]) => [id,
      { id, name: f.name, kind: f.kind, team: f.team, level: f.level, maxHp: f.maxHp, stats: f.stats, resCap: f.resCap, buffs: f.buffs,
        ...(id === 'p' ? { cards: f.cards, weaponCard: f.weaponCard } : {}) }]));
    const all = JSON.parse(localStorage.getItem(LAST_FIGHT_KEY) || '{}');
    all[fightAcct()] = { at: Date.now(), kind: st.kind, status: st.status, fighters, log: st.log };
    localStorage.setItem(LAST_FIGHT_KEY, JSON.stringify(all));
  } catch { /* état illisible ou stockage plein */ }
});
const lastFight = () => { try { return JSON.parse(localStorage.getItem(LAST_FIGHT_KEY) || '{}')[fightAcct()] || null; } catch { return null; } };
// Cibles toutes faites (cible de l'optimiseur) : boss connus et ennemis du dernier combat capturé.
// { clé: { name, rp: % rés. [Neutre, Terre, Feu, Eau, Air] (plafonnés par le resCap du monstre), rf: rés. fixes, pv: PV max } }
function targetPresets() {
  const out = Object.fromEntries(Object.entries(BUILD_TARGETS).map(([k, t]) => [k, { name: t.name, rp: [...t.resPct], rf: [0, 0, 0, 0, 0], pv: 0 }]));
  const fight = lastFight();
  for (const f of Object.values(fight?.fighters || {})) {
    if (f.id === 'p' || f.team === fight.fighters.p?.team) continue;
    const st = f.stats || {};
    out[`f:${f.name}`] = { name: `${f.name}${f.level ? ` (niv. ${f.level})` : ''} — combat de ${DM.hhmm(fight.at)}`, pv: +f.maxHp || 0,
      rp: EL_RES_PCT.map((k) => Math.min(+f.resCap || 100, (+st[k] || 0) + (+st.resPctAll || 0))), rf: EL_RES.map((k) => +st[k] || 0) };
  }
  return out;
}
let favActionId = null;

// Dégâts d'une carte : total min / max / moyen, détail par élément, zone ou cible unique.
// `stats` (caractéristiques du personnage) : dégâts estimés avec ses bonus, critique et vision spectrale compris.
function spellDamage(card, stats = null) {
  const S = (k) => +stats?.[k] || 0;
  const pct = (1 + S('dmgPctSorts') / 100);
  const critP = stats && +card.cc > 0 ? Math.min(1, Math.max(0, (+card.cc + S('critique')) / 100)) : 0;
  // valeur d'un coup de base `v` (normal) / `vc` (critique) dans l'élément `el` : [normal, critique] ;
  // Dommages (+ élément, + critiques) seulement sur la 1re ligne de dégâts du sort
  const hitVal = (v, vc, el, first) => {
    if (!stats) return [v, v];
    const mult = 1 + (S(EL_STAT[el]) + S('puissance')) / 100, fixed = first ? S('dommages') + S(EL_DMG[el]) : 0;
    return [(v * mult + fixed) * pct, (vc * mult + fixed + (first ? S('dommagesCritiques') : 0)) * pct];
  };
  let min = 0, max = 0, zone = false, fixed = false, random = false;
  const variable = (card.eff || []).some((e) => DMG_VARIABLE.has(e?.k));
  let delayed = false, rndAvg = 0, rndMax = 0, sure = 0;
  const byEl = {};
  for (const { e, c, el, first } of damageLines(card)) {
    fixed = true;
    const n = e.k === 'poison' ? Math.max(1, +(e.turns || e.dur) || 1) : 1;   // poison : dégâts à chaque tour
    const eMin = +e.min || 0, eMax = +(e.max ?? e.min) || 0;
    const cMin = c ? +c.min || 0 : eMin * CRIT_MULT, cMax = c ? +(c.max ?? c.min) || 0 : eMax * CRIT_MULT;
    const [loN, loC] = hitVal(eMin, cMin, el, first), [hiN, hiC] = hitVal(eMax, cMax, el, first);
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
    const dmg = spellDamage({ ...card, eff, crit: critLinesOf(card) });
    if (!dmg) {
      if (eff.some((e) => DMG_VARIABLE.has(e?.k))) variableOnly.push(card.n);
      continue;
    }
    const ap = +card.ap || 0;
    spells.push({ id: card.id, key: ent.key, usable: ent.usable !== false, name: card.n, desc: card.d || '', icon: card.icon, ap, rarity: card.r,
      fusion: +card.f || 0, card: { ...card, eff, crit: critLinesOf(card) }, ...dmg, perAp: ap ? dmg.avg / ap : Infinity });
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
// appariées dans l'ordre aux lignes de la carte du même élément (lignes critiques si le coup est critique).
// Observé = v + absorbé (bouclier). Stats = stats du combat + buffs du joueur encore actifs (journal « buff », durée en tours).
// Estimation « sans rés. » = formule de la tierlist ; « avec rés. » = (x − rés. fixe) × (1 − % rés.) de la cible.
// Zone : les autres cibles touchées prennent les mêmes dégâts (vérifié sur les combats enregistrés).
const EL_RES_PCT = ['resPctNeutre', 'resPctTerre', 'resPctFeu', 'resPctEau', 'resPctAir'];
const EL_RES = ['resNeutre', 'resTerre', 'resFeu', 'resEau', 'resAir'];
function damageTest(fight, spells) {
  const P = fight.fighters.p, stats = P.stats;
  const buffs = [], seen = new Set();   // seen : entrées « buff » déjà comptées (journal parcouru deux fois)
  const addBuff = (k, B) => { if (!seen.has(k) && B.who === 'p' && B.stat) { seen.add(k); buffs.push({ stat: B.stat, v: +B.v || 0, from: pTurn, turns: +B.turns || 1 }); } };
  let pTurn = 0;
  const S = (k) => (+stats[k] || 0) + buffs.reduce((s, b) => s + (b.stat === k && pTurn < b.from + b.turns ? b.v : 0), 0);
  const pct = 1 + S('dmgPctSorts') / 100;
  // cartes de l'état de combat (lignes critiques comprises), sinon celles de la collection
  const byName = new Map(spells.map((sp) => [sp.name, sp.card]));
  for (const c of [...Object.values(P.cards || {}), P.weaponCard]) if (c?.name) byName.set(c.name, { ...byName.get(c.name), ...c, n: c.name });
  const rows = [];
  const log = fight.log;
  for (let i = 0; i < log.length; i++) {
    const L = log[i];
    if (L.t === 'turn' && L.who === 'p') pTurn++;
    if (L.t === 'buff') addBuff(i, L);
    if (L.t !== 'play' || L.who !== 'p') continue;
    const card = byName.get(L.card);
    const lines = card ? damageLines(card).filter(({ e }) => !(e.chance != null && +e.chance < 100)) : [];
    const used = new Set();
    for (let j = i + 1; j < log.length && !['play', 'turn', 'round'].includes(log[j].t); j++) {
      const D = log[j];
      if (D.t === 'buff') addBuff(j, D);   // vol de stats en cours de sort
      if (D.t !== 'dmg') continue;
      const tg = fight.fighters[D.who];
      if (!tg || tg.team === P.team) continue;   // coups sur soi / les alliés (zones) ignorés
      const li = lines.findIndex((x, k) => !used.has(k) && x.el === D.el);
      if (li >= 0 && !lines[li].e.zone) used.add(li);
      const ln = lines[li];
      const crit = !!(D.crit ?? L.crit);
      const fatal = log[j + 1]?.t === 'death' && log[j + 1].who === D.who;
      const secondary = !!L.target && D.who !== L.target;   // autre cible touchée par la zone
      const buffed = S(EL_STAT[D.el]) - (+stats[EL_STAT[D.el]] || 0) + S('puissance') - (+stats.puissance || 0);
      const src = ln && (crit ? ln.c : ln.e);
      const row = { card: L.card, ap: card?.ap, target: tg.name, el: D.el, v: (+D.v || 0) + (+D.absorbed || 0), crit, fatal, buffed,
        secondary, pos: li >= 0 ? `${li + 1}/${lines.length}` : null, base: src ? `${src.min}-${src.max ?? src.min}${crit ? ' (crit)' : ''}`
          : ln ? `${ln.e.min}-${ln.e.max ?? ln.e.min} ×${CRIT_MULT} (crit inconnu)` : null };
      if (ln) {
        const e = ln.e, n = e.k === 'poison' ? Math.max(1, +(e.turns || e.dur) || 1) : 1;
        const mult = 1 + (S(EL_STAT[D.el]) + S('puissance')) / 100;
        const fixed = ln.first ? S('dommages') + S(EL_DMG[D.el]) + (crit ? S('dommagesCritiques') : 0) : 0;
        const b = (x) => (crit ? (ln.c ? +x || 0 : (+x || 0) * CRIT_MULT) : +x || 0);
        const val = (x) => (b(x) * mult + fixed) * pct;
        const s2 = crit && ln.c ? ln.c : e;
        row.lo = val(s2.min) * n; row.hi = val(s2.max ?? s2.min) * n;
        const rp = Math.min(+tg.resCap || 100, (+tg.stats?.[EL_RES_PCT[D.el]] || 0) + (+tg.stats?.resPctAll || 0));
        const rf = +tg.stats?.[EL_RES[D.el]] || 0;
        const adj = (x) => Math.max(0, (x - rf) * (1 - rp / 100));
        row.rp = rp; row.rf = rf; row.loR = adj(row.lo); row.hiR = adj(row.hi);
        row.ratio = row.v / ((row.loR + row.hiR) / 2 || 1);
      }
      rows.push(row);
    }
  }
  // détails bruts pour l'analyse : cartes jouées (lignes complètes) et buffs du journal / des combattants
  const played = [...new Set(log.filter((L) => L.t === 'play' && L.who === 'p').map((L) => L.card))];
  const cards = played.map((n) => [n, byName.get(n)]).filter(([, c]) => c)
    .map(([n, c]) => `${n} : ${c.ap} PA, cc ${c.cc ?? 0} % — ${JSON.stringify((c.eff || []).filter((e) => DMG_FIXED.has(e.k) || DMG_VARIABLE.has(e.k)))}`);
  const buffLog = log.filter((L) => L.t === 'buff').map((L) => JSON.stringify(L));
  const fbuffs = Object.values(fight.fighters).filter((f) => f.buffs && (!Array.isArray(f.buffs) || f.buffs.length)).map((f) => `${f.name} : ${JSON.stringify(f.buffs)}`);
  return { rows, stats, cards, buffs: buffLog, fbuffs };
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
  const { rows, stats, cards, buffs, fbuffs } = damageTest(fight, spells);
  const EL = (el) => ELEMENTS[el]?.name || '?';
  const r1 = (x) => Math.round(x);
  const statLine = Object.entries(stats).filter(([, v]) => +v).map(([k, v]) => `${k} ${v}`).join(', ');
  const text = [
    `Test calcul dégâts — combat ${fight.kind || ''} du ${new Date(fight.at).toLocaleString('fr-FR')} (${fight.status || ''})`,
    `Stats : ${statLine}`,
    ...rows.map((r) => `${r.card} (${r.ap ?? '?'} PA) → ${r.target} : ${r.v} ${EL(r.el)}${r.crit ? ' CRIT' : ''}${r.secondary ? ' [zone]' : ''}${r.fatal ? ' (coup fatal)' : ''}${r.buffed ? ` [buff +${r.buffed}]` : ''}`
      + (r.pos ? ` | ligne ${r.pos} base ${r.base}` : '') + (r.lo != null ? ` | estimé ${r1(r.lo)}-${r1(r.hi)} sans rés. | ${r1(r.loR)}-${r1(r.hiR)} avec rés. (${r.rp} %, ${r.rf} fixe) | ratio ${r.ratio.toFixed(2)}` : ` | ${card(r)}`)),
    '', 'Cartes jouées (lignes de dégâts) :', ...cards,
    '', `Buffs du journal : ${buffs.length ? '' : 'aucun'}`, ...buffs,
    ...(fbuffs.length ? ['Buffs des combattants (fin de combat) :', ...fbuffs] : []),
  ].join('\n');
  const okRows = rows.filter((r) => r.lo != null && !r.fatal);
  function card(r) { return r.ap == null ? 'arme ou carte hors collection : non gérée' : 'ligne de la carte introuvable'; }
  const inRange = okRows.filter((r) => r.v >= Math.floor(r.loR) - 1 && r.v <= Math.ceil(r.hiR) + 1).length;
  ov.innerHTML = box(`
    <div style="display:flex;gap:8px;align-items:center"><b style="flex:1;font-size:15px">🧪 Test du calcul — dernier combat (${esc(new Date(fight.at).toLocaleString('fr-FR'))})</b>
      <button data-a="copy" style="${btn};background:#2e6fbf">📋 Copier le récap</button><button data-a="close" style="${btn}">✕</button></div>
    <div style="color:#b9a98c;font-size:12px">Stats du combat : ${esc(statLine) || 'aucun bonus'}</div>
    <div style="font-size:12px">${okRows.length ? `<b>${inRange} / ${okRows.length}</b> coups dans la fourchette estimée (hors coups fatals, plafonnés par la vie restante).` : 'Aucun coup comparable.'}</div>
    <div style="overflow:auto">
      <table style="border-collapse:collapse;width:100%;font-size:12px">
        <tr style="color:#b9a98c;text-align:left"><th>Sort</th><th>Cible</th><th>Élément</th><th style="text-align:right">Observé</th><th style="text-align:right">Estimé sans rés.</th><th style="text-align:right">Avec rés. cible</th><th style="text-align:right">Ratio</th></tr>
        ${rows.map((r) => {
          const ok = r.lo != null && r.v >= Math.floor(r.loR) - 1 && r.v <= Math.ceil(r.hiR) + 1;
          const col = r.lo == null || r.fatal ? '#b9a98c' : ok ? '#6fcf7a' : '#ff7b6b';
          return `<tr style="border-top:1px solid #3a3024">
            <td>${esc(r.card)}${r.crit ? ' <b style="color:#f0c04a">CRIT</b>' : ''}${r.secondary ? ' <span title="Autre cible touchée par la zone">[zone]</span>' : ''}${r.buffed ? ` <span title="Buffs de stats actifs pendant ce coup (Runification, Drain…), comptés dans l'estimation">[buff +${r.buffed}]</span>` : ''}${r.lo == null ? ` <span style="color:#8a7d66">(${esc(card(r))})</span>` : ''}</td>
            <td>${esc(r.target)}${r.fatal ? ' ☠' : ''}</td>
            <td style="color:${ELEMENTS[r.el]?.color || '#888'}">${EL(r.el)}</td>
            <td style="text-align:right;font-weight:700;color:${col}">${r.v}</td>
            <td style="text-align:right">${r.lo != null ? `${r1(r.lo)} – ${r1(r.hi)}` : '—'}</td>
            <td style="text-align:right">${r.lo != null ? `${r1(r.loR)} – ${r1(r.hiR)} <span style="color:#8a7d66">(${r.rp} %)</span>` : '—'}</td>
            <td style="text-align:right">${r.ratio != null ? r.ratio.toFixed(2) : '—'}</td></tr>`;
        }).join('') || '<tr><td colspan="7" style="padding:10px;color:#b9a98c">Aucun coup de sort dans ce combat.</td></tr>'}
      </table>
    </div>
    <div style="color:#8a7d66;font-size:11px">Vert = dans la fourchette, rouge = hors fourchette, gris = non comparable (coup fatal ☠ plafonné par la vie, ligne inconnue). « Copier le récap » puis colle-le moi.</div>`);
  ov.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a="copy"]');
    if (!b) return;
    try { await navigator.clipboard.writeText(text); b.textContent = '✔ Copié'; } catch { b.textContent = '❌ Copie impossible'; }
  });
  document.body.appendChild(ov);
}
