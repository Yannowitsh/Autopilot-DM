// Autopilot-DM — content script : passifs de classe (bonus de dégâts, soins, dégâts subis) selon la classe du joueur.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.
//
// La classe vient de l'état du combat (fighters.p.breedId) : chaque joueur (toi, ton ami) a la sienne. La page /personnage
// liste toutes les classes avec leur passif (props « classes » : { id, n, passive: { name, desc } }) ; on y relit les
// textes une fois par jour et l'auto-diagnostic signale tout changement (les chiffres ci-dessous seraient à revoir).
// Un « traqueur » rejoue le combat (journal) et donne, pour chaque sort lancé, le multiplicateur de dégâts du passif ;
// le même traqueur sert au test du calcul, au plan du tour (Ascension) et, en moyenne, à l'optimiseur.
// Si le jeu annonce lui-même son passif dans le journal (t: 'passive', « Mots 3/5 : +12 % de dégâts »), sa valeur prime.
const CLASSES_KEY = 'dmClasses';
// sort de soin / bouclier : vérifié sur les annonces « Mots » (Vertu, Fermentation, Évolution, Mot Interdit) ; les vols de
// vie (Tromperie, Runification, Drain Élémentaire) n'en sont pas, même avec une ligne de soin
const isHealShield = (c) => (c.eff || []).some((e) => e?.tgt === 'self' && /heal|shield/i.test(e.k || '')) && !(c.eff || []).some((e) => e?.k === 'steal');
const PASSIVES_SINCE = Date.parse('2026-10-08T01:20:00Z');   // arrivée des passifs de classe (1re annonce « Mots »)
const isResBuff = (c) => (c.eff || []).some((e) => e?.tgt === 'self' && e.k === 'buff' && /^res/.test(e.stat || ''));
const isDmgCard = (c) => (c.eff || []).some((e) => e && DMG_FIXED.has(e.k));
const apTaken = (c) => (c.eff || []).reduce((t, e) => t + (e?.tgt === 'enemy' && /apRemove|apSteal/.test(e.k || '') ? Math.abs(+e.min || 0) || Math.abs(+e.max || 0) || 1 : 0), 0);

// Modèles par classe (breedId) : stack(c) = charges gagnées par le lancer ; max ; dmg(st, ctx) = multiplicateur de dégâts ;
// heal(st) ; taken(st, round) = multiplicateur des dégâts subis ; avg = multiplicateur moyen sur un combat (optimiseur).
const CLASS_PASSIVES = {
  1: { name: 'Armure Féca', max: 5, stack: (c) => (isHealShield(c) || isResBuff(c) ? 1 : 0), dmg: (s) => 1 + 0.02 * s.stacks, taken: (s) => 1 - 0.03 * s.stacks, avg: 1.08, avgTaken: 0.88 },
  2: { name: 'Dompteur', dmg: () => 1, avg: 1 },   // invocations : non gérées
  3: { name: 'Avarice', max: 6, stack: (c) => ((+c.ap || 0) <= 2 ? 1 : 0), dmg: (s) => 1 + 0.03 * s.stacks, avg: 1.12 },
  4: { name: 'Assassinat', dmg: (s, x) => (x.tgtPct < 0.25 ? 1.35 : x.tgtPct < 0.5 ? 1.2 : 1), avg: 1.12 },
  5: { name: 'Distorsion temporelle', max: 8, stack: (c) => apTaken(c), dmg: (s) => 1 + 0.02 * s.stacks, avg: 1.1 },
  6: { name: 'Chance d’Ecaflip', dmg: () => 1 + 0.18 - 0.05 * 0.5, avg: 1.155, random: true },   // espérance : ×2 à 18 %, ×0,5 à 5 %
  7: { name: 'Mots', max: 5, stack: (c) => (isHealShield(c) ? 1 : 0), dmg: (s) => 1 + 0.04 * s.stacks, heal: (s) => 1 + 0.05 * s.stacks, avg: 1.15 },
  8: { name: 'Enchaînement', dmg: (s) => 1 + Math.min(0.45, 0.15 * s.turnCasts), avg: 1.22 },
  9: { name: 'Œil de lynx', spectral: 18, dmg: () => 1, avg: 1.12 },
  10: { name: 'Puissance sylvestre', dmg: () => 1, avg: 1.05 },   // poison de 1 % des PV max par tour (boss 3 % au plus)
  11: { name: 'Souffrance', dmg: (s, x) => 1 + Math.min(0.18, 0.02 * Math.floor((1 - x.selfPct) * 10)), avg: 1.08 },
  12: { name: 'Ivresse', max: 4, stack: () => 1, dmg: (s) => 1 + 0.03 * s.stacks, regen: (s) => 0.01 * s.stacks, avg: 1.1 },
  13: { name: 'Artificier', dmg: (s) => 1 + Math.min(0.15, 0.05 * s.bombs), avg: 1.05 },
  14: { name: 'Masques', dmg: (s) => [1.1, 1.25, 1][(s.myTurns - 1) % 3] || 1, taken: (s) => [0.9, 1, 0.75][(s.myTurns - 1) % 3] || 1, avg: 1.12, avgTaken: 0.88 },
  15: { name: 'Évolution', dmg: (s) => 1 + 0.02 * Math.max(0, Math.min(5, s.myTurns - 1)), avg: 1.06 },
  16: { name: 'Portails', dmg: (s) => ((s.fightDmgCasts + 1) % 3 === 0 ? 1.25 : 1), avg: 1.083 },
  17: { name: 'Runes élémentaires', dmg: (s) => 1 + 0.04 * Math.min(4, s.runes.size), avg: 1.13 },
  18: { name: 'Proie', dmg: (s, x) => 1 + (s.prey === x.tgtId ? Math.min(0.2, 0.04 * s.preyHits) : 0), avg: 1.12 },
  20: { name: 'Lance projetée', dmg: (s) => (s.turnDmgCasts === 0 ? 1.2 : 1), avg: 1.07 },
};
const classOf = (breed) => CLASS_PASSIVES[+breed] || null;
const PASSIVE_WEAPON = new Set([2, 4, 13, 14, 15]);   // passifs qui comptent aussi l'arme (« ses sorts et son arme » ; Masques vérifié)

// Traqueur : état du passif au fil du combat. cast(card, { tgtId, el }) après chaque lancer ; mult(card, ctx) avant.
function classTracker(breed, at = Date.now()) {
  const cp = at && at < PASSIVES_SINCE ? null : classOf(breed);   // combat antérieur aux passifs : aucun
  const s = { stacks: 0, turnCasts: 0, turnDmgCasts: 0, fightDmgCasts: 0, myTurns: 0, runes: new Set(), prey: null, preyHits: 0, bombs: 0, logged: null };
  return {
    cp, s,
    // l'annonce vaut pour le tour : Masques change chaque tour (« Masque Pleutre : −25 % de dégâts subis » = aucun bonus)
    turn() { s.myTurns++; s.turnCasts = 0; s.turnDmgCasts = 0; s.logged = null; },
    passiveLog(text) {
      const m = String(text).match(/\+(\d+(?:[.,]\d+)?) ?% de dégâts(?! subis)/);
      if (m) s.logged = +m[1].replace(',', '.');
      else if (/% de dégâts subis/.test(text)) s.logged = 0;
    },
    // multiplicateur de dégâts du prochain lancer ; ctx : { tgtId, tgtPct, selfPct }
    mult(card, ctx = {}) {
      if (s.logged != null) return 1 + s.logged / 100;   // valeur annoncée par le jeu
      if (!cp || !isDmgCard(card) || (card.weapon && !PASSIVE_WEAPON.has(+breed))) return 1;
      return cp.dmg(s, { tgtPct: 1, selfPct: 1, ...ctx });
    },
    heal() { return cp?.heal ? cp.heal(s) : 1; },
    taken() { return cp?.taken ? cp.taken(s) : 1; },
    cast(card, ctx = {}) {
      if (cp?.stack) s.stacks = Math.min(cp.max || 99, s.stacks + cp.stack(card));
      const dmg = isDmgCard(card);
      s.turnCasts++;
      if (dmg) {
        s.turnDmgCasts++; s.fightDmgCasts++;
        for (const e of card.eff || []) if (e && DMG_FIXED.has(e.k) && Number.isInteger(e.el)) s.runes.add(e.el);
        if (ctx.tgtId) { if (s.prey === ctx.tgtId) s.preyHits++; else { s.prey = ctx.tgtId; s.preyHits = 1; } }
      }
      if ((card.eff || []).some((e) => e?.k === 'bomb' || e?.k === 'detonate')) s.bombs++;
    },
    clone() { const c = classTracker(breed, at); Object.assign(c.s, { ...s, runes: new Set(s.runes) }); return c; },
  };
}
// Traqueur rejoué sur le journal d'un combat (cartes du joueur : fighters.p.cards / weaponCard).
function classTrackerFromLog(st, at = Date.now()) {
  const p = st?.fighters?.p;
  const tr = classTracker(p?.breedId, at);
  if (!p) return tr;
  const byName = new Map([...Object.values(p.cards || {}), p.weaponCard].filter(Boolean).map((c) => [c.name, c]));
  for (const L of st.log || []) {
    if (L.t === 'turn' && L.who === 'p') tr.turn();
    if (L.t === 'passive' && L.who === 'p') tr.passiveLog(L.text);
    if (L.t === 'play' && L.who === 'p') { const c = byName.get(L.card); if (c && !c.weapon) tr.cast(c, { tgtId: L.target }); }
  }
  return tr;
}

// Textes des passifs (page Personnage) : gardés un jour ; un texte qui change est signalé (modèle à revoir).
async function checkClassPassives() {
  let prev = null;
  try { prev = JSON.parse(localStorage.getItem(CLASSES_KEY) || 'null'); } catch { /* rien */ }
  if (prev && Date.now() - prev.at < 86400000) return prev.list;
  const { flight } = await fetchFlight('/personnage');
  const { rows, props } = rscProps(flight, (x) => Array.isArray(x.classes) && x.classes[0]?.passive);
  const list = props ? rscDeep(rows, props.classes).map((c) => ({ id: c.id, n: c.n, name: c.passive?.name, desc: c.passive?.desc })) : [];
  if (!list.length) { selfIssue('page:classes', 'passifs de classe illisibles (page Personnage)', 'liste « classes » introuvable'); return prev?.list || []; }
  for (const c of list) {
    const old = prev?.list?.find((x) => x.id === c.id);
    if (old && old.desc !== c.desc) selfIssue(`passive:${c.id}`, `passif de classe modifié : ${c.n} (${c.name})`, `avant : ${old.desc}\nmaintenant : ${c.desc}`);
    if (!CLASS_PASSIVES[c.id]) selfIssue(`passive:${c.id}`, `classe inconnue de l’extension : ${c.n} (${c.name})`, c.desc);
  }
  try { localStorage.setItem(CLASSES_KEY, JSON.stringify({ at: Date.now(), list })); } catch { /* rien */ }
  return list;
}
