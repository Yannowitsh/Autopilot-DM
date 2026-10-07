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
// Dégâts réels (option « Avec mes stats ») — formule des infobulles du jeu, vérifiée sur les journaux de combat :
// par ligne : (base × (1 + (stat de l'élément + Puissance) / 100) + Dommages + Dommages <élément>) × (1 + % Dommages aux sorts).
// Neutre et Terre = Force, Feu = Intelligence, Eau = Chance, Air = Agilité. Critique : chance de la carte + % Critique
// (seulement si la carte peut critiquer), coup ×1,25 (estimé sur les journaux) + Dommages Critiques.
// Vision spectrale : 0,4 % par point de PO qu'un sort de dégâts frappe deux fois (compté en moyenne).
// Cible (option) : chaque coup devient (x − rés. fixe de l'élément) × (1 − % rés. de l'élément), plancher 0 — même
// formule que le test du calcul ; la rés. fixe pèse plus sur les sorts à petites lignes multiples.
const EL_STAT = ['force', 'force', 'intelligence', 'chance', 'agilite'];
const EL_DMG = ['dommagesNeutre', 'dommagesTerre', 'dommagesFeu', 'dommagesEau', 'dommagesAir'];
const CRIT_MULT = 1.25;
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
    if (obj.rewards && st?.status && st.status !== 'ongoing') { dropOnRewards(obj.rewards, `${st.kind}|${st.logCount}`); farmOnRewards(st, obj.rewards); }
    if (!st?.fighters?.p?.stats || !st.log?.some((L) => L.t === 'play' && L.who === 'p')) return;
    const fighters = Object.fromEntries(Object.entries(st.fighters).map(([id, f]) => [id,
      { id, name: f.name, kind: f.kind, team: f.team, level: f.level, maxHp: f.maxHp, stats: f.stats, resCap: f.resCap, buffs: f.buffs }]));
    const all = JSON.parse(localStorage.getItem(LAST_FIGHT_KEY) || '{}');
    all[fightAcct()] = { at: Date.now(), kind: st.kind, status: st.status, fighters, log: st.log };
    localStorage.setItem(LAST_FIGHT_KEY, JSON.stringify(all));
  } catch { /* état illisible ou stockage plein */ }
});
// Résistances d'un combattant (état de combat) au format `tg` de spellDamage, % plafonnés par son resCap.
function fighterTarget(f) {
  const st = f.stats || {};
  return { name: f.name, pv: +f.maxHp || 0,
    rp: EL_RES_PCT.map((k) => Math.min(+f.resCap || 100, (+st[k] || 0) + (+st.resPctAll || 0))), rf: EL_RES.map((k) => +st[k] || 0) };
}
const lastFight = () => { try { return JSON.parse(localStorage.getItem(LAST_FIGHT_KEY) || '{}')[fightAcct()] || null; } catch { return null; } };
let favActionId = null;

// Dégâts d'une carte : total min / max / moyen, détail par élément, zone ou cible unique.
// `stats` (caractéristiques du personnage) : dégâts estimés avec ses bonus, critique et vision spectrale compris.
// `tg` (cible) : { rp: % rés. [Neutre, Terre, Feu, Eau, Air], rf: rés. fixes [idem] }, appliquées à chaque coup.
function spellDamage(card, stats = null, tg = null) {
  const S = (k) => +stats?.[k] || 0;
  const pct = (1 + S('dmgPctSorts') / 100);
  const critP = stats && +card.cc > 0 ? Math.min(1, Math.max(0, (+card.cc + S('critique')) / 100)) : 0;
  // valeur d'un coup de base `v` dans l'élément `el` : [normal, critique]
  const vsTg = (x, el) => (tg ? Math.max(0, (x - (+tg.rf?.[el] || 0)) * (1 - (+tg.rp?.[el] || 0) / 100)) : x);
  const hitVal = (v, el) => {
    if (!stats) return [vsTg(v, el), vsTg(v, el)];
    const mult = 1 + (S(EL_STAT[el]) + S('puissance')) / 100, fixed = S('dommages') + S(EL_DMG[el]);
    return [vsTg((v * mult + fixed) * pct, el), vsTg((v * CRIT_MULT * mult + fixed + S('dommagesCritiques')) * pct, el)];
  };
  let min = 0, max = 0, zone = false, variable = false, delayed = false, fixed = false, random = false;
  let rndAvg = 0, rndMax = 0, sure = 0;
  const byEl = {};
  for (const e of card.eff || []) {
    if (DMG_VARIABLE.has(e.k)) { variable = true; continue; }
    if (!DMG_FIXED.has(e.k)) continue;
    fixed = true;
    const n = e.k === 'poison' ? Math.max(1, +(e.turns || e.dur) || 1) : 1;   // poison : dégâts à chaque tour
    const el = Number.isInteger(e.el) ? e.el : 0;
    const [loN, loC] = hitVal(+e.min || 0, el), [hiN, hiC] = hitVal(+(e.max ?? e.min) || 0, el);
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
    const dmg = spellDamage({ ...card, eff });
    if (!dmg) {
      if (eff.some((e) => DMG_VARIABLE.has(e?.k))) variableOnly.push(card.n);
      continue;
    }
    const ap = +card.ap || 0;
    spells.push({ id: card.id, key: ent.key, usable: ent.usable !== false, name: card.n, desc: card.d || '', icon: card.icon, ap, rarity: card.r,
      fusion: +card.f || 0, card: { ...card, eff }, ...dmg, perAp: ap ? dmg.avg / ap : Infinity });
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
// appariées dans l'ordre aux lignes de la carte du même élément. Observé = v + absorbé (bouclier).
// Estimation « sans rés. » = formule de la tierlist ; « avec rés. » = (x − rés. fixe) × (1 − % rés.) de la cible.
// Zone : seule la cible visée prend 100 % ; les autres cibles touchées prennent ~60 % (vérifié sur un récap de combat).
const ZONE_FALLOFF = 0.6;
const EL_RES_PCT = ['resPctNeutre', 'resPctTerre', 'resPctFeu', 'resPctEau', 'resPctAir'];
const EL_RES = ['resNeutre', 'resTerre', 'resFeu', 'resEau', 'resAir'];
function damageTest(fight, spells) {
  const stats = fight.fighters.p.stats;
  const S = (k) => +stats[k] || 0;
  const pct = 1 + S('dmgPctSorts') / 100;
  const byName = new Map(spells.map((sp) => [sp.name, sp.card]));
  const rows = [];
  let buffed = false;
  const log = fight.log;
  for (let i = 0; i < log.length; i++) {
    const L = log[i];
    if (L.t === 'buff' && L.who === 'p') buffed = true;
    if (L.t !== 'play' || L.who !== 'p') continue;
    const card = byName.get(L.card);
    const lines = (card?.eff || []).filter((e) => DMG_FIXED.has(e.k) && !(e.chance != null && +e.chance < 100));
    const used = new Set();
    for (let j = i + 1; j < log.length && !['play', 'turn', 'round'].includes(log[j].t); j++) {
      const D = log[j];
      if (D.t !== 'dmg') continue;
      const tg = fight.fighters[D.who];
      if (!tg || tg.team === fight.fighters.p.team) continue;   // coups sur soi / les alliés (zones) ignorés
      const li = lines.findIndex((e, k) => !used.has(k) && (Number.isInteger(e.el) ? e.el : 0) === D.el);
      if (li >= 0 && !lines[li].zone) used.add(li);
      const e = lines[li];
      const crit = !!(D.crit ?? L.crit);
      const fatal = log[j + 1]?.t === 'death' && log[j + 1].who === D.who;
      const secondary = !!L.target && D.who !== L.target;   // autre cible touchée par la zone
      const row = { card: L.card, ap: card?.ap, target: tg.name, el: D.el, v: (+D.v || 0) + (+D.absorbed || 0), crit, fatal, buffed,
        secondary };
      if (e) {
        const n = e.k === 'poison' ? Math.max(1, +(e.turns || e.dur) || 1) : 1;
        const mult = 1 + (S(EL_STAT[D.el]) + S('puissance')) / 100, fixed = S('dommages') + S(EL_DMG[D.el]);
        const val = (b) => (crit ? b * CRIT_MULT * mult + fixed + S('dommagesCritiques') : b * mult + fixed) * pct;
        const zf = secondary ? ZONE_FALLOFF : 1;
        row.lo = val(+e.min || 0) * n * zf; row.hi = val(+(e.max ?? e.min) || 0) * n * zf;
        const rp = Math.min(+tg.resCap || 100, (+tg.stats?.[EL_RES_PCT[D.el]] || 0) + (+tg.stats?.resPctAll || 0));
        const rf = +tg.stats?.[EL_RES[D.el]] || 0;
        const adj = (x) => Math.max(0, (x - rf) * (1 - rp / 100));
        row.rp = rp; row.rf = rf; row.loR = adj(row.lo); row.hiR = adj(row.hi);
        row.ratio = row.v / ((row.loR + row.hiR) / 2 || 1);
      }
      rows.push(row);
    }
  }
  return { rows, stats };
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
  const { rows, stats } = damageTest(fight, spells);
  const EL = (el) => ELEMENTS[el]?.name || '?';
  const r1 = (x) => Math.round(x);
  const statLine = Object.entries(stats).filter(([, v]) => +v).map(([k, v]) => `${k} ${v}`).join(', ');
  const text = [
    `Test calcul dégâts — combat ${fight.kind || ''} du ${new Date(fight.at).toLocaleString('fr-FR')} (${fight.status || ''})`,
    `Stats : ${statLine}`,
    ...rows.map((r) => `${r.card} (${r.ap ?? '?'} PA) → ${r.target} : ${r.v} ${EL(r.el)}${r.crit ? ' CRIT' : ''}${r.secondary ? ' [zone ×0,6]' : ''}${r.fatal ? ' (coup fatal)' : ''}${r.buffed ? ' [buff]' : ''}`
      + (r.lo != null ? ` | estimé ${r1(r.lo)}-${r1(r.hi)} sans rés. | ${r1(r.loR)}-${r1(r.hiR)} avec rés. (${r.rp} %, ${r.rf} fixe) | ratio ${r.ratio.toFixed(2)}` : ` | ${card(r)}`)),
  ].join('\n');
  const okRows = rows.filter((r) => r.lo != null && !r.fatal && !r.buffed);
  function card(r) { return r.ap == null ? 'arme ou carte hors collection : non gérée' : 'ligne de la carte introuvable'; }
  const inRange = okRows.filter((r) => r.v >= Math.floor(r.loR) - 1 && r.v <= Math.ceil(r.hiR) + 1).length;
  ov.innerHTML = box(`
    <div style="display:flex;gap:8px;align-items:center"><b style="flex:1;font-size:15px">🧪 Test du calcul — dernier combat (${esc(new Date(fight.at).toLocaleString('fr-FR'))})</b>
      <button data-a="copy" style="${btn};background:#2e6fbf">📋 Copier le récap</button><button data-a="close" style="${btn}">✕</button></div>
    <div style="color:#b9a98c;font-size:12px">Stats du combat : ${esc(statLine) || 'aucun bonus'}</div>
    <div style="font-size:12px">${okRows.length ? `<b>${inRange} / ${okRows.length}</b> coups dans la fourchette estimée (hors coups fatals, plafonnés par la vie restante, et coups sous buff).` : 'Aucun coup comparable.'}</div>
    <div style="overflow:auto">
      <table style="border-collapse:collapse;width:100%;font-size:12px">
        <tr style="color:#b9a98c;text-align:left"><th>Sort</th><th>Cible</th><th>Élément</th><th style="text-align:right">Observé</th><th style="text-align:right">Estimé sans rés.</th><th style="text-align:right">Avec rés. cible</th><th style="text-align:right">Ratio</th></tr>
        ${rows.map((r) => {
          const ok = r.lo != null && r.v >= Math.floor(r.loR) - 1 && r.v <= Math.ceil(r.hiR) + 1;
          const col = r.lo == null || r.fatal || r.buffed ? '#b9a98c' : ok ? '#6fcf7a' : '#ff7b6b';
          return `<tr style="border-top:1px solid #3a3024">
            <td>${esc(r.card)}${r.crit ? ' <b style="color:#f0c04a">CRIT</b>' : ''}${r.secondary ? ' <span title="Autre cible touchée par la zone : estimation ×0,6">[zone ×0,6]</span>' : ''}${r.buffed ? ' <span title="Un buff était actif : les stats ont pu changer">[buff]</span>' : ''}${r.lo == null ? ` <span style="color:#8a7d66">(${esc(card(r))})</span>` : ''}</td>
            <td>${esc(r.target)}${r.fatal ? ' ☠' : ''}</td>
            <td style="color:${ELEMENTS[r.el]?.color || '#888'}">${EL(r.el)}</td>
            <td style="text-align:right;font-weight:700;color:${col}">${r.v}</td>
            <td style="text-align:right">${r.lo != null ? `${r1(r.lo)} – ${r1(r.hi)}` : '—'}</td>
            <td style="text-align:right">${r.lo != null ? `${r1(r.loR)} – ${r1(r.hiR)} <span style="color:#8a7d66">(${r.rp} %)</span>` : '—'}</td>
            <td style="text-align:right">${r.ratio != null ? r.ratio.toFixed(2) : '—'}</td></tr>`;
        }).join('') || '<tr><td colspan="7" style="padding:10px;color:#b9a98c">Aucun coup de sort dans ce combat.</td></tr>'}
      </table>
    </div>
    <div style="color:#8a7d66;font-size:11px">Vert = dans la fourchette, rouge = hors fourchette, gris = non comparable (coup fatal ☠ plafonné par la vie, buff actif, ligne inconnue). « Copier le récap » puis colle-le moi.</div>`);
  ov.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a="copy"]');
    if (!b) return;
    try { await navigator.clipboard.writeText(text); b.textContent = '✔ Copié'; } catch { b.textContent = '❌ Copie impossible'; }
  });
  document.body.appendChild(ov);
}
