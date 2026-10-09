// Autopilot-DM — content script : mécaniques des boss (Ascension) et plan du tour qui les respecte.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.
//
// Le bestiaire (/bestiaire?onglet=mecaniques, BossMechanicsGrid) liste pour chaque boss (id = monsterId du combat) ses
// mécaniques selon la difficulté : « Facile · Ascension, étages 1-2 », « Cauchemar · Ascension dès l’étage 9 », plus
// « Cauchemar · deuxième mécanique en même temps ». L'état du combat ne les donne pas : on les déduit des boss présents et
// de l'étage (cfg.ascFloor, noté au lancement). Étage inconnu : toutes les mécaniques d'Ascension du boss (prudent).
// En combat, planTurn cherche la meilleure suite de cartes du tour (ordre compris) sous ces contraintes ; le moteur
// joue sa première carte puis recalcule (pioche, morts, coups critiques…).
const MECH_KEY = 'dmBossMech';
const MECH_MAX_AGE = 12 * 3600000;
const SELF_W = 1.5;              // 1 PV perdu par nous-mêmes vaut 1,5 PV infligés (nos PV sont plus rares que ceux des boss)
const STEAL_HEAL_PART = 0.5;     // un vol de vie rend 50 % des dégâts infligés (journaux de combat)
let mechCache = null;

// Mécaniques de tous les boss : [{ id, n, m: [{ w, n, x }] }], gardées 12 h (localStorage de la page).
async function bossMechanics(force = false) {
  if (!mechCache) { try { mechCache = JSON.parse(localStorage.getItem(MECH_KEY) || 'null'); } catch { mechCache = null; } }
  if (!force && mechCache?.list?.length && Date.now() - mechCache.at < MECH_MAX_AGE) return mechCache.list;
  try {
    const { flight } = await fetchFlight('/bestiaire?onglet=mecaniques');
    const { rows, props } = rscProps(flight, (x) => Array.isArray(x.cards) && x.cards.length > 0 && x.cards.some((c) => c && typeof c === 'object' && 'm' in c));
    const list = props && rscDeep(rows, props.cards).filter((b) => b?.id && Array.isArray(b.m));
    if (!list?.length) throw new Error('liste des mécaniques introuvable');
    mechCache = { at: Date.now(), list };
    selfCheckMechanics(list);   // nouveaux types de mécaniques : signalés
    try { localStorage.setItem(MECH_KEY, JSON.stringify(mechCache)); } catch { /* stockage plein */ }
    return list;
  } catch (e) {
    DM.log(`mécaniques des boss : ${e.message}${mechCache?.list ? ' — dernière copie utilisée' : ''}`);
    selfIssue('page:bestiaire', 'mécaniques du bestiaire illisibles', e.message);
    return mechCache?.list || [];
  }
}

// Texte d'une mécanique → règle exploitable.
function parseMechanic(m) {
  const x = m.x || '', num = (re) => { const r = x.match(re); return r ? +r[1] : null; };
  switch (m.n) {
    // ×2,5 mesuré (2026-10-09, 29 coups « se déchaîne » ; ×1,375 quand le boss est Affaibli de 45 %)
    case 'Fureur': return { k: 'fureur', max: num(/plus de (\d+) cartes/) ?? 3, mult: +(x.match(/×(\d+(?:,\d+)?)/)?.[1] || '2.5').replace(',', '.') };
    case 'Peau dure': return { k: 'shield', pass: num(/seuls (\d+) ?%/) ?? 50 };
    case 'Onde de choc': return { k: 'onde', pct: num(/(\d+) ?% de tes PV/) ?? 25 };
    case 'Malédiction des soins': return { k: 'curse', from: num(/tour (\d+)/) ?? 1, half: /divisés par deux/.test(x) };
    case 'Sceau': return { k: 'seal', every: /chaque tour/.test(x) ? 1 : num(/Tous les (\d+) tours/) ?? 3 };
    case 'Deuxième souffle': return { k: 'revive', pct: num(/(\d+) ?% de ses PV/) ?? 30 };
    case 'Miroir': {
      const r = x.match(/tours? (\d+)(?: à (\d+))?/);
      return { k: 'mirror', from: r ? +r[1] : 3, to: r ? +(r[2] || r[1]) : 3 };
    }
    case 'PA comptés': return { k: 'apExact', turn: num(/tour (\d+)/) ?? 3, ap: num(/exactement (\d+) PA/) ?? 1 };
    case 'Rage': return { k: 'rage', turn: num(/tour (\d+)/) };
    case 'Vol de PA': return { k: 'apSteal' };
    case 'Échange de vie': return { k: 'swap', turn: num(/tour (\d+)/) ?? 5, half: /à moitié/.test(x) };
    default: return { k: 'none' };
  }
}
// Étages d'Ascension couverts par une ligne du bestiaire (« Ascension, étages 3-5 », « Ascension dès l’étage 9 »).
function ascRanges(w) {
  const out = [];
  for (const r of (w || '').matchAll(/Ascension, étages (\d+)-(\d+)/g)) out.push([+r[1], +r[2]]);
  for (const r of (w || '').matchAll(/Ascension dès l.étage (\d+)/g)) out.push([+r[1], Infinity]);
  return out;
}
// Mécaniques actives d'un combat : [{ boss: id du combattant, name, text, ...règle }].
// diff : difficulté affichée sur la page Ascension (« Cauchemar »…), prioritaire ; sinon déduite de l'étage.
function fightMechanics(st, list, floor, diff = null) {
  const out = [];
  for (const f of Object.values(st.fighters || {})) {
    if (f.team === st.fighters.p?.team || !f.isBoss) continue;
    const b = list.find((x) => +x.id === +f.monsterId) || list.find((x) => x.n === f.name);
    if (!b) continue;
    const asc = b.m.filter((m) => ascRanges(m.w).length);
    let picked = diff ? asc.filter((m) => m.w.split(' · ')[0].split(' et ').includes(diff))
      : floor ? asc.filter((m) => ascRanges(m.w).some(([a, z]) => floor >= a && floor <= z)) : asc;
    // Cauchemar : la deuxième mécanique s'ajoute
    const nightmare = diff ? diff === 'Cauchemar' : picked.some((m) => ascRanges(m.w).some(([a, z]) => z === Infinity && floor >= a));
    if (nightmare || (!diff && !floor)) picked = [...picked, ...b.m.filter((m) => /deuxième mécanique/.test(m.w))];
    for (const m of picked) out.push({ boss: f.id, bossName: f.name, name: m.n, text: m.x, ...parseMechanic(m) });
  }
  return out;
}

// ---------- Estimations (même formule que la tierlist) ----------
// buffs du combattant, sauf celui d'un Portail (empower : compté par le traqueur de classe sur la carte suivante)
const fighterStat = (f) => (k) => (+f.stats?.[k] || 0) + (f.buffs || []).reduce((s, b) => s + (b.stat === k && !empowerOf(f.cards?.[b.source]) ? +b.value || 0 : 0), 0);
// Dégâts moyens d'une carte sur une cible (résistances comprises), et ce qu'elle rend en PV au lanceur (vols, soins).
function cardEffect(card, p, tgt) {
  // mémorisé par combattant (mêmes stats) : le plan du tour et le conseiller de deck l'appellent des milliers de fois
  const memo = p._fx || (p._fx = new Map()), mk = `${card.id}|${card.uid || ''}|${tgt?.id || ''}`;
  if (memo.has(mk)) return memo.get(mk);
  const r = cardEffectRaw(card, p, tgt);
  memo.set(mk, r);
  return r;
}
function cardEffectRaw(card, p, tgt) {
  const S = fighterStat(p);
  const lines = damageLines(card, S);
  const critP = +card.cc > 0 ? Math.min(1, Math.max(0, (+card.cc + S('critique')) / 100)) : 0;
  const pct = dmgPctOf(card, S);   // le passif de classe est appliqué par le plan (classTracker)
  let dmg = 0, steal = 0;
  for (const { e, c, el, first } of lines) {
    if (e.chance != null && +e.chance < 100) continue;
    const mult = 1 + (S(EL_STAT[el]) + S('puissance')) / 100;
    const avg = (x) => ((+x.min || 0) + (+(x.max ?? x.min) || 0)) / 2;
    const fixed = first ? S('dommages') + S(EL_DMG[el]) : 0;
    const v = ((1 - critP) * (avg(e) * mult + fixed) + critP * ((c ? avg(c) : avg(e) * CRIT_MULT) * mult + fixed + (first ? S('dommagesCritiques') : 0))) * pct;
    const rp = tgt ? Math.min(+tgt.resCap || 100, (+tgt.stats?.[EL_RES_PCT[el]] || 0) + (+tgt.stats?.resPctAll || 0)) : 0;
    const rf = tgt ? +tgt.stats?.[EL_RES[el]] || 0 : 0;
    const d = Math.max(0, (v - rf) * (1 - rp / 100));
    dmg += d;
    if (e.k === 'steal') steal += d * STEAL_HEAL_PART;
  }
  let heal = 0;
  const learned = cardHeals()[card.id];
  if (learned?.n) heal = learned.r * (+p.maxHp || 0);   // soin mesuré en combat
  else for (const e of card.eff || []) {
    if (e?.tgt !== 'self') continue;
    if (e.k === 'healPct') heal += (+e.min || 0) / 100 * (+p.maxHp || 0);
    else if (e.k === 'heal') {
      const el = Number.isInteger(e.el) ? e.el : 0;
      heal += ((+e.min || 0) + (+(e.max ?? e.min) || 0)) / 2 * (1 + (S(EL_STAT[el]) + S('puissance')) / 100);
    }
  }
  return { dmg, self: steal + heal, steal, heal };
}

// Bouclier posé par une carte (PV) : shieldHp = % des PV max (Vertu 26 → 26 % des PV max) ; shieldLvl = % du niveau
// (Fermentation 247 ×2 au niveau 200 = 2 × 494 = 988). Avec beaucoup de PV, les boucliers en % des PV max l'emportent.
// dur : tours pendant lesquels il absorbe (son utilité est plafonnée par les dégâts reçus sur cette durée).
function shieldOf(card, p) {
  let v = 0, dur = 1;
  for (const e of card.eff || []) {
    if (e?.tgt !== 'self') continue;
    if (e.k === 'shieldHp') v += (+e.min || 0) / 100 * (+p.maxHp || 0);
    else if (e.k === 'shieldLvl') v += (+e.min || 0) / 100 * (+p.level || 200);
    else continue;
    dur = Math.max(dur, +e.dur || 1);
  }
  return { v, dur };
}
const apGainOf = (card) => (card.eff || []).reduce((t, e) => t + (e?.k === 'apGain' && e.tgt === 'self' ? +e.min || 0 : 0), 0);
const AP_REMOVE_CUT = 0.15;   // par PA retiré à l'ennemi : état Affaibli, sa prochaine attaque −15 % (Précipitation 3 PA → « weaken 45 », vérifié)
// Coût d'une mécanique pour nous, en part de nos PV max par tour (estimation) : sert à choisir l'ordre d'abattage, puisque
// seul le premier boss encore debout (le plus à gauche) impose ses mécaniques. Malédiction : selon la part de nos cartes
// qui soignent ou volent de la vie (elles deviennent des dégâts sur nous).
const MECH_PAIN = { apSteal: 0.1, fureur: 0.1, apExact: 0.1, swap: 0.1, onde: 0.05, seal: 0.05, shield: 0.05, mirror: 0.05 };
const LEAD_KILL_TURNS = 2;   // tours de mécaniques évités quand le meneur tombe (valeur du coup qui l'abat)

// ---------- Plan du tour ----------
// cand : cartes jouables [{ c, key, weapon, w, ap }] ; rules : fightMechanics(...). Renvoie la 1re carte de la meilleure
// suite { pick, target } (ou null = finir le tour) et les mécaniques en jeu ce tour (texte court).
function planTurn(st, cand, rules) {
  const p = st.fighters.p, round = +st.round || +p.turnNo || 1;
  const enemies = Object.values(st.fighters).filter((f) => f.team !== p.team && f.alive && f.id !== 'p');
  const alive = new Set(enemies.map((f) => f.id));
  // « Les mécaniques qui te visent viennent du premier boss encore debout : quand il tombe, le suivant prend le relais. »
  const order = (st.order || Object.keys(st.fighters)).filter((id) => alive.has(id));
  const lead = order.find((id) => rules.some((r) => r.boss === id)) ?? order[0];
  const R = rules.filter((r) => r.boss === lead);
  const has = (k) => R.filter((r) => r.k === k);
  const notes = [];
  // Ordre d'abattage : abattre le meneur passe la main au boss suivant (et à ses mécaniques). Plus ses mécaniques coûtent
  // par rapport à celles du suivant, plus on le vise ; s'il est le moins gênant, on vise d'abord les autres.
  const healShare = cand.length ? cand.filter((x) => (x.c.eff || []).some((e) => e?.k === 'steal' || /heal/i.test(e?.k || ''))).length / cand.length : 0;
  const painOf = (id) => rules.filter((r) => r.boss === id)
    .reduce((t, r) => t + (r.k === 'curse' ? (r.half ? 0.15 : 0.4) * healShare : MECH_PAIN[r.k] || 0), 0);
  const nextLead = order.filter((id) => id !== lead).find((id) => rules.some((r) => r.boss === id));
  const leadDelta = lead && nextLead ? painOf(lead) - painOf(nextLead) : 0;
  const leadW = (id) => (id !== lead || Math.abs(leadDelta) < 0.02 ? 1 : leadDelta > 0 ? 1 + 10 * leadDelta : 1 / (1 - 10 * leadDelta));
  if (leadDelta >= 0.02) notes.push(`abattre ${st.fighters[lead]?.name} d’abord (ses mécaniques coûtent plus que celles de ${st.fighters[nextLead]?.name})`);
  else if (leadDelta <= -0.02) notes.push(`garder ${st.fighters[lead]?.name} en vie (${st.fighters[nextLead]?.name} prendrait le relais, en pire)`);
  const fureur = has('fureur').reduce((m, r) => Math.min(m, r.max), Infinity);
  if (fureur < Infinity) notes.push(`Fureur > ${fureur} cartes`);
  const onde = has('onde').length > 0;
  if (onde) notes.push('Onde : alterner');
  const curse = has('curse').some((r) => round >= r.from && !r.half);
  const halfHeal = has('curse').some((r) => round >= r.from && r.half);   // « tes soins sont divisés par deux »
  if (curse) notes.push('soins = dégâts');
  const shieldRule = has('shield')[0];
  const shieldUp0 = (p.shields || []).some((s) => (+s.v || +s.value || +s.amount || 1) > 0);
  if (shieldRule && !shieldUp0) notes.push(`Peau dure ${shieldRule.pass} %`);
  const mirrored = new Set(has('mirror').filter((r) => round >= r.from && round <= r.to).map((r) => r.boss));
  if (mirrored.size) notes.push(`Miroir : ne pas frapper ${[...mirrored].map((id) => st.fighters[id]?.name).join(', ')}`);
  const apRule = has('apExact').find((r) => r.turn === round);
  if (apRule) notes.push(`finir à ${apRule.ap} PA`);
  // Échange de vie : boss à ménager avant son tour… sauf si on peut l'abattre d'ici là (plus d'échange, ni de ses
  // autres mécaniques : il ne mène plus). Nos tours jusqu'au sien compris (on joue avant lui) ; dégâts possibles par tour
  // sur lui : nos 4 meilleures cartes + l'arme.
  // Bouclier d'un boss (sa « garde », souvent pour 1 tour) : il absorbe chaque coup sauf la part de notre Perforation
  // (0,05 % par point de Fuite + Tacle, 25 % au plus : ~10 % vérifié à l'étage 36). Ce qu'il absorbe est perdu s'il expire
  // avant d'être cassé : dans la recherche, seuls les dégâts qui atteignent ses PV comptent.
  const enemyShield = (f) => (f.shields || []).reduce((t, x) => t + (+x.value || +x.v || +x.amount || 0), 0);
  const perfo = Math.min(0.25, ((fighterStat(p)('fuite') || 0) + (fighterStat(p)('tacle') || 0)) * 0.0005);
  const ehpOf = (f) => (+f.hp || 0) + enemyShield(f);
  // dégâts d qui atteignent les PV de f, bouclier restant sh : [vers les PV, bouclier après]
  const throughShield = (d, sh) => { const abs = sh > 0 ? Math.min(sh, d * (1 - perfo)) : 0; return [d - abs, sh - abs]; };
  for (const f of enemies) if (enemyShield(f) > 0) notes.push(`${f.name} sous bouclier (${Math.round(enemyShield(f))})`);
  const killableBy = (id, turns) => {
    const f = st.fighters[id];
    const per = cand.filter((x) => !x.weapon && damageLines(x.c, fighterStat(p)).length).map((x) => cardEffect(x.c, p, f).dmg).sort((a, b) => b - a)
      .slice(0, 4).reduce((t, d) => t + d, 0)   // 4 cartes : la Fureur se paie (bouclier), cf. Auto du jeu
      + cand.filter((x) => x.weapon).reduce((t, x) => t + cardEffect(x.c, p, f).dmg, 0);
    return ehpOf(f) <= per * turns;
  };
  const swapProt = new Set(has('swap').filter((r) => round < r.turn && !killableBy(r.boss, r.turn - round + 1)).map((r) => r.boss));
  const swapRush = has('swap').filter((r) => round < r.turn && !swapProt.has(r.boss));
  if (swapRush.length) notes.push(`abattre ${swapRush.map((r) => st.fighters[r.boss]?.name).join(', ')} avant le tour ${swapRush[0].turn}`);
  if (swapProt.size) notes.push(`Échange de vie : ménager ${[...swapProt].map((id) => st.fighters[id]?.name).join(', ')}`);
  // boss qui se relèvera encore (Deuxième souffle pas encore déclenché) : le tuer ne finit pas le combat
  const revived = new Set(st.log?.filter((L) => L.t === 'mechanic' && /se relève/.test(L.text || '')).map((L) => L.who));
  const reviveAt = Object.fromEntries(has('revive').filter((r) => !revived.has(r.boss)).map((r) => [r.boss, r.pct]));
  const willRevive = new Set(Object.keys(reviveAt));

  const info = cand.map((x) => {
    const dl = damageLines(x.c, fighterStat(p));
    const isDmg = dl.length > 0;
    const zone = (x.c.eff || []).some((e) => e?.zone || e?.k === 'bomb' || e?.k === 'detonate');
    const shield = (x.c.eff || []).some((e) => /shield|bouclier/i.test(e?.k || ''));
    return { ...x, isDmg, zone, shield, firstEl: isDmg ? dl[0].el : null, lastEl: isDmg ? dl[dl.length - 1].el : null };
  });
  const startLast = onde ? (p.lastEl ?? planTurn.lastEl ?? null) : null;
  const cardsDone = +p.cardsThisTurn || 0;
  const maxHp = +p.maxHp || 1;
  // dégâts annoncés par les boss pour leur prochain tour (intentions) : ne jamais se blesser en dessous
  const incomingOf = (f) => (['attack', 'heavy', 'drain', 'rage'].includes(f.intent?.k) ? +f.intent.value || +f.atk || 0 : 0);
  // coup brut d'un boss → PV qu'il nous retire : (brut − rés. fixe) × (1 − rés. % plafonnée à 50) (vérifié au point près)
  const hitOn = (f, raw) => {
    const el = Number.isInteger(f?.element) ? f.element : 1, S = fighterStat(p);
    return Math.max(0, raw - S(EL_RES[el])) * (1 - Math.min(+p.resCap || 50, S(EL_RES_PCT[el])) / 100);
  };
  // prochaine VRAIE attaque du boss, brute (intent.value compte déjà l'état Affaibli) : s'il se garde ou enrage ce tour-ci,
  // la suivante — par prudence une attaque lourde (×1,7). C'est elle que la Fureur amplifie (avant nos résistances).
  const rawNextOf = (f) => {
    if (['attack', 'heavy', 'drain'].includes(f.intent?.k) && +f.intent.value) return +f.intent.value;
    return (+f.atk || 0) * 1.7 * (1 - Math.min(0.6, +f.weaken || 0));
  };
  // passif de classe : rejoué sur le journal, puis suivi carte par carte dans la recherche (Iop, Forgelance, Enutrof…)
  const tr0 = classTrackerFromLog(st);
  const safety = enemies.reduce((t, f) => t + hitOn(f, incomingOf(f)), 0) * tr0.taken() + maxHp * 0.05;   // Féca, Zobal : dégâts subis réduits
  const ondePct = Math.max(0, ...has('onde').map((r) => r.pct));
  // Fureur déjà chargée : un tour précédent à plus de N cartes dont l'attaque amplifiée n'est pas encore venue (le boss s'est
  // gardé ou a enragé entre-temps, seq 2017 : « se déchaîne » après un tour à 2 cartes). Elle viendra quoi qu'on joue :
  // inutile de se brider ce tour-ci.
  const furyPending = (r) => {
    let pend = false, who = null, n = 0;
    for (const L of st.log || []) {
      if (L.t === 'turn') { if (who === 'p' && n > r.max) pend = true; who = L.who; n = 0; }
      if (L.t === 'play' && L.who === 'p') n++;
      if (L.t === 'mechanic' && L.who === r.boss && /se déchaîne/.test(L.text || '')) pend = false;
    }
    return pend;
  };
  const fureurRules = has('fureur').filter((r) => !furyPending(r));
  if (has('fureur').length > fureurRules.length) notes.push('Fureur déjà chargée');
  let best = null;
  const n = Math.min(info.length, 9);
  // Recherche en profondeur : ordre des cartes, cible de chacune, PV des ennemis et du joueur estimés au fil de la suite.
  // Score en PV : dégâts utiles infligés (sans l'excédent), + bonus par ennemi tué (son attaque ne viendra plus),
  // − SELF_W × PV perdus par nous-mêmes (onde de choc, soins maudits, coups renvoyés, Fureur).
  const dfs = (seq, used, ap, lastEl, count, hp, ehp, shieldUp, score, tr) => {
    const allDead = enemies.every((f) => ehp[f.id] <= 0);
    let s = score;
    if (apRule) s -= Math.abs(ap - apRule.ap) * 1e6;   // PA comptés : sinon il nous pulvérise
    // Fureur : au-delà de N cartes, la prochaine attaque du boss (s'il vit encore) est multipliée
    // Fureur : au-delà de N cartes, la prochaine attaque du boss (s'il vit encore) est multipliée ; interdit si elle nous tue
    if (!allDead) for (const r of fureurRules) {
      if (!(count > r.max && ehp[r.boss] > 0)) continue;
      const f = st.fighters[r.boss], boosted = hitOn(f, rawNextOf(f) * (r.mult || 2.5)) * tr0.taken();
      const shieldNow = (p.shields || []).reduce((t, x) => t + (+x.v || +x.value || +x.amount || 0), 0) + (seq.some((q) => q.x.shield) ? Math.max(...seq.filter((q) => q.x.shield).map((q) => shieldOf(q.x.c, p).v)) : 0);
      // surcoût de l'attaque amplifiée, en partie absorbé par le bouclier posé ce tour
      s -= boosted >= hp + shieldNow ? 1e9 : SELF_W * Math.max(0, boosted * (1 - 1 / (r.mult || 2)) - shieldNow / 2);
    }
    if (!best || s > best.s + 1e-6 || (Math.abs(s - best.s) <= 1e-6 && seq.length < best.seq.length)) best = { s, seq };
    if (allDead) return;
    for (let i = 0; i < n; i++) {
      if (used & (1 << i)) continue;
      const x = info[i];
      if (x.ap > ap) continue;
      let target = null, gain = 0, self = 0, healed = 0;
      const nh = { ...ehp };
      if (x.isDmg || needsTarget(x.c)) {
        // cible : vivante, pas sous Miroir, et pas à ménager (Échange de vie) si le coup la fait passer sous nos PV %
        const myPct = hp / maxHp;
        const ok = enemies.filter((f) => nh[f.id] > 0 && !mirrored.has(f.id)).filter((f) => {
          if (!swapProt.has(f.id)) return true;
          return (nh[f.id] - cardEffect(x.c, p, f).dmg) / (+f.maxHp || 1) >= myPct + 0.05;
        });
        if (!ok.length) continue;
        // cible : celle qu'on achève, sinon la plus menaçante par PV effectif (attaque × dégâts du coup / PV restants, un
        // boss qui se relèvera compte ses PV de résurrection en plus) — pas simplement la moins entamée
        const threat = (f) => {
          const raw = cardEffect(x.c, p, f).dmg, d = throughShield(raw, nh[`s:${f.id}`] || 0)[0];
          const waste = raw > 0 ? d / raw : 1;   // part du coup qui atteint ses PV (le reste se perd dans son bouclier)
          if (d >= nh[f.id] && !(reviveAt[f.id] && !nh[`r:${f.id}`])) return 1e12 + d;   // coup fatal
          const extra = reviveAt[f.id] && !nh[`r:${f.id}`] ? (+f.maxHp || 0) * reviveAt[f.id] / 100 : 0;
          const rush = swapRush.some((q) => q.boss === f.id) ? 10 : 1;   // à abattre avant son Échange de vie : en priorité
          return rush * leadW(f.id) * waste * Math.max(1, +f.atk || incomingOf(f) || 1) * d / Math.max(1, nh[f.id] + extra);
        };
        target = ok.sort((a, b) => threat(b) - threat(a))[0];
        const pass = shieldRule && !shieldUp ? shieldRule.pass / 100 : 1;
        const cm = tr.mult(x.c, { tgtId: target.id, tgtPct: nh[target.id] / Math.max(1, +target.maxHp || 1), selfPct: hp / maxHp });   // passif de classe
        const hit = (f, part) => {
          const e = cardEffect(x.c, p, f);
          const d = e.dmg * part * pass * cm;
          if (mirrored.has(f.id)) { self += d; return e; }   // Miroir : le coup nous revient
          const before = nh[f.id];
          const [toHp, shLeft] = throughShield(d, nh[`s:${f.id}`] || 0);
          nh[`s:${f.id}`] = shLeft;
          nh[f.id] -= toHp;
          gain += Math.min(before, toHp);
          if (nh[f.id] <= 0) {
            // Deuxième souffle : il se relève une fois avec x % de ses PV
            if (reviveAt[f.id] && !nh[`r:${f.id}`]) { nh[f.id] = (+f.maxHp || 0) * reviveAt[f.id] / 100; nh[`r:${f.id}`] = 1; }
            else {
              gain += incomingOf(f) + (+f.atk || 0);   // une attaque de moins à encaisser
              if (f.id === lead) gain += leadDelta * maxHp * LEAD_KILL_TURNS;   // ses mécaniques passent au suivant
            }
          }
          return e;
        };
        const eff = hit(target, 1);
        if (x.zone) for (const f of enemies) if (f !== target && (nh[f.id] > 0 || mirrored.has(f.id))) hit(f, ZONE_FALLOFF);
        if (curse) self += eff.self;   // vols et soins blessent
        else healed += (eff.steal + eff.heal) * (halfHeal ? 0.5 : 1);   // vol de vie : 50 % des dégâts rendus
        const apCut = (x.c.eff || []).reduce((t, e) => t + (e?.k === 'apRemove' && e.tgt === 'enemy' ? Math.abs(+e.min || 0) || 1 : 0), 0);
        // Affaibli se cumule jusqu'à 60 % (Comte Razof : 45 puis 60, seq 2024) ; le coup annoncé compte déjà l'état actuel
        if (apCut && target) {
          const w0 = Math.min(0.6, +target.weaken || 0), w1 = Math.min(0.6, w0 + AP_REMOVE_CUT * apCut);
          gain += (1 - (1 - w1) / (1 - w0)) * hitOn(target, rawNextOf(target)) * tr0.taken();
        }
      } else if (cardKind(x.c) === 'heal') {
        const h = cardEffect(x.c, p, null).heal;
        if (curse) self += h; else healed += h * (halfHeal ? 0.5 : 1);
      } else if (!x.shield && !apGainOf(x.c)) gain += x.w * 5;   // buff… : valeur tirée de son poids
      // bouclier : PV épargnés sur les attaques à venir (une seule fois par tour)
      // bouclier : PV épargnés, comptés comme nos PV (× SELF_W, comme les PV perdus) ; relancé, il remplace ce qui reste
      // du précédent (l'Auto du jeu relance Vertu chaque tour : 3 046 à chaque fois)
      if (x.shield && !seq.some((q) => q.x.shield)) {
        const sh = shieldOf(x.c, p), left = (p.shields || []).reduce((t, z) => t + (+z.v || +z.value || +z.amount || 0), 0);
        gain += SELF_W * Math.max(0, Math.min(sh.v, safety * sh.dur) - left);
      }
      if (x.shield && shieldRule && !shieldUp) gain += 5000;   // Peau dure : le bouclier d'abord
      const wave = ondePct > 0 && x.isDmg && !x.weapon && lastEl != null && x.firstEl === lastEl;
      if (wave) self += maxHp * ondePct / 100;
      // jamais en dessous de ce que les boss vont nous infliger à leur tour (sauf si la suite les tue tous)
      // soins (vols de vie compris) : PV rendus, plafonnés à ce qui manque, comptés comme nos PV (× SELF_W)
      const healUse = Math.max(0, Math.min(healed, maxHp - (hp - self)));
      gain += SELF_W * healUse;
      const left = hp - self + healUse;
      const killsAll = enemies.every((f) => nh[f.id] <= 0);
      if (self > 0 && left < safety && !(killsAll && left > 0)) continue;
      const tr2 = tr.clone();
      tr2.cast(x.c, { tgtId: target?.id });
      dfs([...seq, { x, target }], used | (1 << i), ap - x.ap + apGainOf(x.c), x.isDmg && !x.weapon ? x.lastEl : lastEl, count + (x.weapon ? 0 : 1),
        left, nh, shieldUp || x.shield, score + gain - SELF_W * self, tr2);
    }
  };
  dfs([], 0, +p.ap || 0, startLast, cardsDone, +p.hp || 0, Object.fromEntries(enemies.flatMap((f) => [[f.id, +f.hp || 0], [`s:${f.id}`, enemyShield(f)]])), shieldUp0, 0, tr0);
  const first = best?.seq[0];
  return { pick: first?.x || null, target: first?.target || null, plan: best?.seq || [], notes, score: best?.s || 0 };
}
planTurn.lastEl = null;   // élément de la dernière ligne du dernier sort joué (si le jeu ne le donne pas)

// Étage d'Ascension lu sur un bouton (« Affronter l’étage 12 »).
const floorOf = (label) => +(label || '').match(/étage (\d+)/i)?.[1] || null;

// ---------- Mécaniques observées dans les combats (les nôtres et ceux des amis, via le Worker) ----------
// Le combat ne liste pas les mécaniques actives, mais le journal les annonce quand elles se déclenchent (t: 'mechanic').
// On garde ces observations par étage : au prochain essai (ou quand on atteint l'étage d'un ami), elles complètent les
// règles du bestiaire (mécanique manquante, tour exact du Miroir / des PA comptés / de l'Échange de vie).
const MECH_TEXTS = [
  [/vous vole \d+ PA/i, 'Vol de PA'],
  [/soins vous blessent|soins sont divisés/i, 'Malédiction des soins'],
  [/se relève/i, 'Deuxième souffle'],
  [/renvoie le coup/i, 'Miroir'],
  [/scelle .* pour ce tour/i, 'Sceau'],
  [/échange sa vie/i, 'Échange de vie'],
  [/onde de choc/i, 'Onde de choc'],
  [/fureur|se déchaîne/i, 'Fureur'],   // « Koumiho se déchaîne ! » : plus de N cartes jouées dans le tour
  [/peau dure|sans bouclier/i, 'Peau dure'],
  [/perd patience|t.achève/i, 'Rage'],
  [/pulvérise .* d.un seul coup/i, 'PA comptés|Rage'],
];
// [{ monsterId, bossName, name (ou null : texte inconnu), round, text }]
function observedMechanics(st) {
  const out = [];
  let round = 0;
  for (const L of st.log || []) {
    if (L.t === 'round') round = +L.round || round;
    if (L.t !== 'mechanic' || !L.who || L.who === 'p') continue;
    const f = st.fighters?.[L.who];
    if (!f || f.team === st.fighters.p?.team) continue;
    const name = MECH_TEXTS.find(([re]) => re.test(L.text || ''))?.[1] || null;
    if (!out.some((o) => o.monsterId === +f.monsterId && o.name === name && o.round === round)) {
      out.push({ monsterId: +f.monsterId, bossName: f.name, name, round, text: L.text });
    }
  }
  return out;
}
// Cause probable d'une défaite : mécanique qui nous a achevés, sinon l'attaque d'un boss (et nos auto-dégâts du combat).
function ascFailCause(st) {
  const log = st.log || [];
  let round = 0, self = 0, last = null;
  for (let i = 0; i < log.length; i++) {
    const L = log[i];
    if (L.t === 'round') round = +L.round || round;
    if (L.t === 'dmg' && L.who === 'p' && L.el === 0) self += +L.v || 0;   // onde, soins maudits, coups renvoyés
    if (L.t === 'mechanic' && /pulvérise|achève|perd patience/i.test(L.text || '')) last = { round, text: L.text };
  }
  if (last) return `tour ${last.round} : ${last.text}`;
  if (log.some((L) => L.t === 'end' && L.reason === 'flee')) return `abandon au tour ${round}`;
  const boss = Object.values(st.fighters || {}).find((f) => f.team !== st.fighters.p?.team && f.alive);
  return `PV à zéro au tour ${round}${boss ? ` (${boss.name} encore debout)` : ''}${self ? ` — ${Math.round(self)} PV perdus par nos propres sorts` : ''}`;
}
// Règles du bestiaire + observations [{ monsterId, name, round }] : mécanique observée absente des règles → ajoutée (texte
// du bestiaire pour ce boss) ; Miroir / PA comptés / Échange de vie → au(x) tour(s) observé(s).
function mergeObserved(rules, st, seen, list) {
  const out = rules.map((r) => ({ ...r }));
  for (const f of Object.values(st.fighters || {})) {
    if (f.team === st.fighters.p?.team || !f.isBoss) continue;
    const obs = (seen || []).filter((o) => +o.monsterId === +f.monsterId && o.name);
    if (!obs.length) continue;
    const b = list.find((x) => +x.id === +f.monsterId);
    for (const o of obs) {
      let name = o.name;
      if (name === 'PA comptés|Rage') name = b?.m.some((m) => m.n === 'PA comptés') ? 'PA comptés' : 'Rage';
      let r = out.find((x) => x.boss === f.id && x.name === name);
      if (!r) {
        const m = b?.m.filter((x) => x.n === name).at(-1);
        if (!m) continue;
        r = { boss: f.id, bossName: f.name, name, text: m.x, ...parseMechanic(m), learned: true };
        out.push(r);
      }
      if (r.k === 'mirror' && o.round) { r.from = Math.min(r.from, o.round); r.to = Math.max(r.to, o.round); r.seenRound = true; }
      if (r.k === 'apExact' && o.round) { r.turn = o.round; r.seenRound = true; }
      if (r.k === 'swap' && o.round) { r.turn = o.round; r.seenRound = true; }
    }
  }
  return out;
}
// Observations gardées pour l'étage (les nôtres, localStorage) : { étage: [{ at, status, diff, seen, cause }] }.
const ASC_SEEN_KEY = 'dmAscSeen';
function ascSeenOwn(floor) { try { return JSON.parse(localStorage.getItem(ASC_SEEN_KEY) || '{}')[floor] || []; } catch { return []; } }
function ascRemember(asc) {
  try {
    const all = JSON.parse(localStorage.getItem(ASC_SEEN_KEY) || '{}');
    all[asc.floor] = [...(all[asc.floor] || []), asc].slice(-10);
    localStorage.setItem(ASC_SEEN_KEY, JSON.stringify(all));
  } catch { /* stockage plein */ }
}
// Observations d'un étage : les nôtres + celles des amis (Worker, via le service worker ; 5 min de cache).
const ascSharedCache = {};
async function ascSeenAll(floor) {
  const own = ascSeenOwn(floor).map((a) => ({ ...a, player: 'toi' }));
  let shared = ascSharedCache[floor];
  if (!shared || Date.now() - shared.at > 5 * 60000) {
    const r = await send({ type: 'ascShared', floor }).catch(() => null);
    shared = ascSharedCache[floor] = { at: Date.now(), rows: r?.ok ? r.rows : [] };
  }
  const me = myName();
  return [...own, ...shared.rows.filter((x) => x.p !== me).map((x) => ({ ...x.d, at: x.at, status: x.status, player: x.p }))];
}
