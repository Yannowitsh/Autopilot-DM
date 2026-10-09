// Autopilot-DM — content script : % de victoire estimé du combat en cours (popup et menu 🤖).
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.
//
// À chaque état de combat reçu (lancement, actions de l'Auto par poids, fin) : WIN_SIMS simulations de la suite du combat.
// - nous : dégâts et soins/boucliers par tour appris sur nos combats (journal, par moteur : Auto du jeu / par poids),
//   sinon estimés sur le deck (cardEffect) ; dès 2 tours joués, ce combat-ci compte pour 70 % ; les dégâts vont à
//   l'ennemi le plus faible, le surplus au suivant ;
// - chaque ennemi joue son cycle d'actions (pattern) depuis patternIdx : la 1re action est son intention annoncée
//   (intent.value), les suivantes atk × le rapport appris pour ce type d'action (attack, heavy, drain…) ;
// - hasard : ±25 % sur nos dégâts, ±15 % sur les leurs, 10 % de coups critiques ennemis (×1,5).
// Fin de combat : on apprend (moyennes mobiles, par personnage) et on note l'estimation du départ face à l'issue réelle
// (taux de pronostics justes, affiché). En Auto du jeu, le serveur renvoie tout le combat d'un coup : l'issue est connue
// dès le lancement, l'estimation de départ reste affichée à côté.
const WIN_SIMS = 300, WIN_MAX_ROUNDS = 40, WIN_LEARN_RATE = 0.2, WIN_MIN_FIGHTS = 3;
const WIN_KIND_DEFAULT = { attack: 1, heavy: 1.6, drain: 0.8 };   // dégâts / atk, avant apprentissage (rage, soins… : 0)
const WIN_HIT_KINDS = new Set(['attack', 'heavy', 'drain', 'rage']);   // intentions dont la valeur est un coup
// modèle par personnage et par moteur (l'Auto par poids ne frappe pas comme l'Auto du jeu)
const winAcct = () => `${fightAcct()}|${weightsOn() ? 'poids' : 'auto'}`;
const winModelOf = () => cfg.winModel?.[winAcct()] || {};
// Ce combat-ci, d'après son journal : nos dégâts et soins/boucliers par tour, dégâts des ennemis par type d'action.
function winObserve(st) {
  const F = st.fighters || {}, P = F.p;
  let turns = 0, dealt = 0, healed = 0, cur = null, intent = null;
  const kinds = {};
  for (const L of st.log || []) {
    if (L.t === 'turn') { cur = L.who; intent = null; if (cur === 'p') turns++; continue; }
    if (L.t === 'intent') { intent = { who: L.who, k: L.k }; continue; }
    if (cur === 'p') {
      if (L.t === 'dmg' && F[L.who] && F[L.who].team !== P.team) dealt += (+L.v || 0) + (+L.absorbed || 0);
      if ((L.t === 'heal' || L.t === 'shield') && L.who === 'p') healed += +L.v || 0;
    } else if (intent?.who === cur && L.t === 'dmg' && L.who === 'p' && +F[cur]?.atk > 0) {
      (kinds[intent.k] ||= []).push(((+L.v || 0) + (+L.absorbed || 0)) / +F[cur].atk);
    }
  }
  return { turns, dealt, healed, kinds };
}
const winKey = (st) => `${st.kind}|${Object.values(st.fighters || {}).filter((f) => f.id !== 'p').map((f) => f.name).join(',')}`;
const noise = (sd) => {   // 1 ± sd (loi normale, Box-Muller), jamais négatif
  const g = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  return Math.max(0, 1 + sd * g);
};

// Nos dégâts par tour d'après le deck : densité (dégâts / PA) des 3 meilleures cartes × PA du tour × 0,75 (main au hasard).
function winDeckDpt(p, tgt) {
  const dens = Object.values(p.cards || {}).filter((c) => c && cardKind(c) === 'dmg' && +c.ap > 0)
    .map((c) => cardEffect(c, p, tgt).dmg / +c.ap).sort((a, b) => b - a).slice(0, 3);
  return dens.length ? dens.reduce((s, x) => s + x, 0) / dens.length * (+p.basePa || +p.ap || 6) * 0.75 : 0;
}

// % de victoire (0-100) depuis cet état, ou null.
function winSim(st) {
  const F = st.fighters || {}, P = F.p;
  const foes0 = Object.values(F).filter((f) => P && f.team !== P.team && f.alive && f.id !== 'p');
  if (!P || !foes0.length || !(+P.hp > 0)) return null;
  const m = winModelOf(), learned = (m.n || 0) >= WIN_MIN_FIGHTS;
  let dpt = learned ? m.dpt : winDeckDpt(P, [...foes0].sort((a, b) => a.hp - b.hp)[0]) || m.dpt || 0;
  let hpt = learned ? m.hpt || 0 : 0;
  // dès 2 tours joués, ce combat-ci compte pour 70 % (main, ennemis, moteur du moment)
  const obs = winObserve(st);
  if (obs.turns >= 2) { dpt = 0.7 * (obs.dealt / obs.turns) + 0.3 * dpt; hpt = 0.7 * (obs.healed / obs.turns) + 0.3 * hpt; }
  const ratio = (k) => ((m.kinds?.[k]?.n || 0) >= 3 ? m.kinds[k].r : WIN_KIND_DEFAULT[k] ?? 0);
  if (!(dpt > 0)) return 0;
  let wins = 0;
  for (let s = 0; s < WIN_SIMS; s++) {
    let hp = +P.hp + shieldSum(P);
    const maxHp = Math.max(hp, +P.maxHp || 0);
    const foes = foes0.map((f) => ({ hp: (+f.hp || 0) + shieldSum(f), atk: +f.atk || 0, pat: f.pattern?.length ? f.pattern : ['attack'],
      i: +f.patternIdx || 0, next: f.intent }));
    let won = false;
    for (let r = 0; r < WIN_MAX_ROUNDS && !won && hp > 0; r++) {
      let d = dpt * noise(0.25);
      for (const f of [...foes].sort((a, b) => a.hp - b.hp)) {
        if (f.hp <= 0 || d <= 0) continue;
        const x = Math.min(f.hp, d);
        f.hp -= x;
        d -= x;
      }
      if (foes.every((f) => f.hp <= 0)) { won = true; break; }
      hp = Math.min(maxHp, hp + hpt * noise(0.3));
      for (const f of foes) {
        if (f.hp <= 0) continue;
        // intention annoncée : sa valeur pour une attaque (comme incomingOf), rien pour un soin, un bouclier…
        const k = f.next ? f.next.k : f.pat[f.i % f.pat.length];
        let v = f.next && WIN_HIT_KINDS.has(k) && +f.next.value ? +f.next.value : f.atk * ratio(k);
        f.next = null;
        f.i++;
        if (Math.random() < 0.1) v *= 1.5;
        hp -= v * noise(0.15);
      }
    }
    if (won) wins++;
  }
  return Math.round((wins / WIN_SIMS) * 100);
}

// Fin de combat (journal complet) : nos dégâts / soins par tour, dégâts des ennemis par type d'action, pronostic de départ.
let winLearned = '';
function winLearn(st) {
  const P = st.fighters?.p, log = st.log || [];
  const id = `${winKey(st)}|${st.logCount || log.length}|${st.status}`;
  if (!P || !log.length || +st.logFrom > 0 || winLearned === id) return;
  winLearned = id;
  const { turns, dealt, healed, kinds } = winObserve(st);
  if (!turns) return;
  const m = { ...winModelOf(), kinds: { ...winModelOf().kinds } };
  const ema = (old, v) => (old == null ? v : old + WIN_LEARN_RATE * (v - old));   // les derniers combats comptent plus
  m.dpt = ema(m.dpt, dealt / turns);
  m.hpt = ema(m.hpt, healed / turns);
  m.n = (m.n || 0) + 1;
  for (const [k, rs] of Object.entries(kinds)) {
    const o = m.kinds[k] || {};
    m.kinds[k] = { r: ema(o.r, rs.reduce((s, x) => s + x, 0) / rs.length), n: (o.n || 0) + rs.length };
  }
  const est = cfg.winEst;
  if (est?.key === winKey(st) && est.first != null) {   // pronostic de départ face à l'issue réelle
    const c = m.calib || { n: 0, ok: 0 };
    m.calib = { n: c.n + 1, ok: c.ok + ((est.first >= 50) === (st.status === 'won') ? 1 : 0) };
  }
  save({ winModel: { ...(cfg.winModel || {}), [winAcct()]: m } });
}

// État de combat reçu : estimation (combat en cours) ou issue (combat fini), publiée dans cfg.winEst.
function winUpdate(st) {
  try {
    if (!st?.fighters?.p) return;
    const key = winKey(st), prev = cfg.winEst;
    const same = prev?.key === key && !prev.done;
    if (st.status && st.status !== 'ongoing') {
      save({ winEst: { key, acct: winAcct(), first: same ? prev.first : null, pct: st.status === 'won' ? 100 : 0, done: st.status, at: Date.now() } });
      winLearn(st);
      return;
    }
    const pct = winSim(st);
    if (pct == null) return;
    save({ winEst: { key, acct: winAcct(), pct, first: same && prev.first != null ? prev.first : pct, at: Date.now(), learned: (winModelOf().n || 0) >= WIN_MIN_FIGHTS } });
  } catch (e) { DM.log(`victoire estimée : ${e.message}`); }
}

// États de combat captés par netwatch.js : lancement (dm-fight-init) et réponses du jeu (dm-fight, Auto du jeu compris).
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  try {
    if (e.data?.type === 'dm-fight-init' && typeof e.data.json === 'string') winUpdate(withFullLog(rscDeep({}, JSON.parse(e.data.json))));
    else if (e.data?.type === 'dm-fight' && typeof e.data.line === 'string') winUpdate(withFullLog(JSON.parse(e.data.line).state));
  } catch { /* état illisible */ }
});
