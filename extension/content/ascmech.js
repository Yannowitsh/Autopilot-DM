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
    try { localStorage.setItem(MECH_KEY, JSON.stringify(mechCache)); } catch { /* stockage plein */ }
    return list;
  } catch (e) {
    DM.log(`mécaniques des boss : ${e.message}${mechCache?.list ? ' — dernière copie utilisée' : ''}`);
    return mechCache?.list || [];
  }
}

// Texte d'une mécanique → règle exploitable.
function parseMechanic(m) {
  const x = m.x || '', num = (re) => { const r = x.match(re); return r ? +r[1] : null; };
  switch (m.n) {
    case 'Fureur': return { k: 'fureur', max: num(/plus de (\d+) cartes/) ?? 3, mult: +(x.match(/×(\d+(?:,\d+)?)/)?.[1] || '2').replace(',', '.') };
    case 'Peau dure': return { k: 'shield', pass: num(/seuls (\d+) ?%/) ?? 50 };
    case 'Onde de choc': return { k: 'onde', pct: num(/(\d+) ?% de tes PV/) ?? 25 };
    case 'Malédiction des soins': return { k: 'curse', from: num(/tour (\d+)/) ?? 1, half: /divisés par deux/.test(x) };
    case 'Sceau': return { k: 'seal' };
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
function fightMechanics(st, list, floor) {
  const out = [];
  for (const f of Object.values(st.fighters || {})) {
    if (f.team === st.fighters.p?.team || !f.isBoss) continue;
    const b = list.find((x) => +x.id === +f.monsterId) || list.find((x) => x.n === f.name);
    if (!b) continue;
    const asc = b.m.filter((m) => ascRanges(m.w).length);
    let picked = floor ? asc.filter((m) => ascRanges(m.w).some(([a, z]) => floor >= a && floor <= z)) : asc;
    // Cauchemar : la deuxième mécanique s'ajoute
    const nightmare = picked.some((m) => ascRanges(m.w).some(([a, z]) => z === Infinity && floor >= a));
    if (nightmare || !floor) picked = [...picked, ...b.m.filter((m) => /deuxième mécanique/.test(m.w))];
    for (const m of picked) out.push({ boss: f.id, bossName: f.name, name: m.n, text: m.x, ...parseMechanic(m) });
  }
  return out;
}

// ---------- Estimations (même formule que la tierlist) ----------
const fighterStat = (f) => (k) => (+f.stats?.[k] || 0) + (f.buffs || []).reduce((s, b) => s + (b.stat === k ? +b.value || 0 : 0), 0);
// Dégâts moyens d'une carte sur une cible (résistances comprises), et ce qu'elle rend en PV au lanceur (vols, soins).
function cardEffect(card, p, tgt) {
  const S = fighterStat(p);
  const lines = damageLines(card, S);
  const critP = +card.cc > 0 ? Math.min(1, Math.max(0, (+card.cc + S('critique')) / 100)) : 0;
  const pct = 1 + S('dmgPctSorts') / 100;
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
  for (const e of card.eff || []) {
    if (e?.tgt !== 'self') continue;
    if (e.k === 'healPct') heal += (+e.min || 0) / 100 * (+p.maxHp || 0);
    else if (e.k === 'heal') {
      const el = Number.isInteger(e.el) ? e.el : 0;
      heal += ((+e.min || 0) + (+(e.max ?? e.min) || 0)) / 2 * (1 + (S(EL_STAT[el]) + S('puissance')) / 100);
    }
  }
  return { dmg, self: steal + heal };
}

// ---------- Plan du tour ----------
// cand : cartes jouables [{ c, key, weapon, w, ap }] ; rules : fightMechanics(...). Renvoie la 1re carte de la meilleure
// suite { pick, target } (ou null = finir le tour) et les mécaniques en jeu ce tour (texte court).
function planTurn(st, cand, rules) {
  const p = st.fighters.p, round = +st.round || +p.turnNo || 1;
  const enemies = Object.values(st.fighters).filter((f) => f.team !== p.team && f.alive && f.id !== 'p');
  const alive = new Set(enemies.map((f) => f.id));
  const R = rules.filter((r) => alive.has(r.boss));
  const has = (k) => R.filter((r) => r.k === k);
  const notes = [];
  const fureur = has('fureur').reduce((m, r) => Math.min(m, r.max), Infinity);
  if (fureur < Infinity) notes.push(`Fureur > ${fureur} cartes`);
  const onde = has('onde').length > 0;
  if (onde) notes.push('Onde : alterner');
  const curse = has('curse').some((r) => round >= r.from && !r.half);
  if (curse) notes.push('soins = dégâts');
  const shieldRule = has('shield')[0];
  const shieldUp0 = (p.shields || []).some((s) => (+s.v || +s.value || +s.amount || 1) > 0);
  if (shieldRule && !shieldUp0) notes.push(`Peau dure ${shieldRule.pass} %`);
  const mirrored = new Set(has('mirror').filter((r) => round >= r.from && round <= r.to).map((r) => r.boss));
  if (mirrored.size) notes.push(`Miroir : ne pas frapper ${[...mirrored].map((id) => st.fighters[id]?.name).join(', ')}`);
  const apRule = has('apExact').find((r) => r.turn === round);
  if (apRule) notes.push(`finir à ${apRule.ap} PA`);
  const swapProt = new Set(has('swap').filter((r) => round < r.turn).map((r) => r.boss));
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
  const safety = enemies.reduce((t, f) => t + incomingOf(f), 0) + maxHp * 0.05;
  const ondePct = Math.max(0, ...has('onde').map((r) => r.pct));
  const fureurRules = has('fureur');
  let best = null;
  const n = Math.min(info.length, 9);
  // Recherche en profondeur : ordre des cartes, cible de chacune, PV des ennemis et du joueur estimés au fil de la suite.
  // Score en PV : dégâts utiles infligés (sans l'excédent), + bonus par ennemi tué (son attaque ne viendra plus),
  // − SELF_W × PV perdus par nous-mêmes (onde de choc, soins maudits, coups renvoyés, Fureur).
  const dfs = (seq, used, ap, lastEl, count, hp, ehp, shieldUp, score) => {
    const allDead = enemies.every((f) => ehp[f.id] <= 0);
    let s = score;
    if (apRule) s -= Math.abs(ap - apRule.ap) * 1e6;   // PA comptés : sinon il nous pulvérise
    // Fureur : au-delà de N cartes, la prochaine attaque du boss (s'il vit encore) est multipliée
    if (!allDead) for (const r of fureurRules) if (count > r.max && ehp[r.boss] > 0) s -= SELF_W * incomingOf(st.fighters[r.boss]) * ((r.mult || 2) - 1);
    if (!best || s > best.s + 1e-6 || (Math.abs(s - best.s) <= 1e-6 && seq.length < best.seq.length)) best = { s, seq };
    if (allDead) return;
    for (let i = 0; i < n; i++) {
      if (used & (1 << i)) continue;
      const x = info[i];
      if (x.ap > ap) continue;
      let target = null, gain = 0, self = 0;
      const nh = { ...ehp };
      if (x.isDmg || needsTarget(x.c)) {
        // cible : vivante, pas sous Miroir, et pas à ménager (Échange de vie) si le coup la fait passer sous nos PV %
        const myPct = hp / maxHp;
        const ok = enemies.filter((f) => nh[f.id] > 0 && !mirrored.has(f.id)).filter((f) => {
          if (!swapProt.has(f.id)) return true;
          return (nh[f.id] - cardEffect(x.c, p, f).dmg) / (+f.maxHp || 1) >= myPct + 0.05;
        });
        if (!ok.length) continue;
        target = ok.sort((a, b) => nh[a.id] - nh[b.id])[0];
        const pass = shieldRule && !shieldUp ? shieldRule.pass / 100 : 1;
        const hit = (f, part) => {
          const e = cardEffect(x.c, p, f);
          const d = e.dmg * part * pass;
          if (mirrored.has(f.id)) { self += d; return e; }   // Miroir : le coup nous revient
          const before = nh[f.id];
          nh[f.id] -= d;
          gain += Math.min(before, d);
          if (nh[f.id] <= 0) {
            // Deuxième souffle : il se relève une fois avec x % de ses PV
            if (reviveAt[f.id] && !nh[`r:${f.id}`]) { nh[f.id] = (+f.maxHp || 0) * reviveAt[f.id] / 100; nh[`r:${f.id}`] = 1; }
            else gain += incomingOf(f) + (+f.atk || 0);   // une attaque de moins à encaisser
          }
          return e;
        };
        const eff = hit(target, 1);
        if (x.zone) for (const f of enemies) if (f !== target && (nh[f.id] > 0 || mirrored.has(f.id))) hit(f, ZONE_FALLOFF);
        if (curse) self += eff.self;   // vols et soins blessent
        else if (!x.isDmg) gain += x.w * 5;
      } else if (cardKind(x.c) === 'heal') {
        if (curse) continue;
        gain += Math.min(maxHp - hp, x.w * 20);
      } else gain += x.w * 5;   // buff, bouclier… : valeur tirée de son poids
      if (x.shield && shieldRule && !shieldUp) gain += 5000;   // Peau dure : le bouclier d'abord
      const wave = ondePct > 0 && x.isDmg && !x.weapon && lastEl != null && x.firstEl === lastEl;
      if (wave) self += maxHp * ondePct / 100;
      // jamais en dessous de ce que les boss vont nous infliger à leur tour (sauf si la suite les tue tous)
      const left = hp - self;
      const killsAll = enemies.every((f) => nh[f.id] <= 0);
      if (self > 0 && left < safety && !(killsAll && left > 0)) continue;
      dfs([...seq, { x, target }], used | (1 << i), ap - x.ap, x.isDmg && !x.weapon ? x.lastEl : lastEl, count + (x.weapon ? 0 : 1),
        left, nh, shieldUp || x.shield, score + gain - SELF_W * self);
    }
  };
  dfs([], 0, +p.ap || 0, startLast, cardsDone, +p.hp || 0, Object.fromEntries(enemies.map((f) => [f.id, +f.hp || 0])), shieldUp0, 0);
  const first = best?.seq[0];
  return { pick: first?.x || null, target: first?.target || null, plan: best?.seq || [], notes };
}
planTurn.lastEl = null;   // élément de la dernière ligne du dernier sort joué (si le jeu ne le donne pas)

// Étage d'Ascension lu sur un bouton (« Affronter l’étage 12 »).
const floorOf = (label) => +(label || '').match(/étage (\d+)/i)?.[1] || null;
