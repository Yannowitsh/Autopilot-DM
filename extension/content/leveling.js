// Autopilot-DM — content script : 📈 mode Leveling (monter au niveau 200 le plus vite possible).
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- 📈 Leveling ----------
// Le pilote chasse en boucle le groupe qui rapporte le plus d'XP par combat parmi les zones autour de ton niveau :
// - scan des zones dont la plage croise [niveau − 20, niveau + 20] (+ les zones « à ton niveau » du jeu), à chaque
//   renouvellement des groupes (~3 min) ou après une défaite ;
// - XP d'un groupe = Σ XP de base des monstres × bonus de groupe × perte d'écart de niveau (xpLevelPen). XP de base : celle
//   mesurée en combat (farmModel), sinon estimée : archimonstre / avis de recherche = niveau × (400 + 8 × niveau) (exact sur
//   701 monstres), monstre normal ≈ le tiers (médiane de 3 189 monstres) — d'où des archis et avis visés d'office ;
// - archimonstres de grade 6 : 0 XP (jeu ; Tronkoneuz, Crognan, Boostif, Pissdane — le même Pissdane donne 11 200 XP en
//   grade 5). Le grade n'est pas affiché sur la page de zone : un monstre vu à 0 XP (nom|niveau) est retenu
//   (cfg.levelNoXp) et compté à 0, et un combat à 0 XP fait rechoisir un groupe tout de suite ;
// - archimonstre jamais vu : estimé à 90 % (≈ 1 sur 10 est de grade 6, sans XP : 37 sur 380 vus) ;
// - nouveau choix à chaque niveau gagné (zones débloquées, perte d'écart de niveau) : les groupes déjà lus sont gardés
//   jusqu'au renouvellement de leur zone (levelScanCache), seules les nouvelles zones sont lues ;
// - prudence : seuls les groupes dont la somme des niveaux ≤ ton niveau × `danger` sont pris. `danger` monte de 10 % toutes
//   les 5 victoires d'affilée (plus haut niveau possible), baisse de 25 % à chaque défaite (et nouveau choix tout de suite) ;
// - équipement auto forcé : Sagesse > Puissance > Vitalité ; points de caractéristiques mis en Sagesse dès qu'il y en a ;
// - niveau 200 : fin (pilote arrêté par défaut), notification Discord, chrono enregistré pour ce Prestige.
// cfg.levelRun = { active, danger, wins, pickedAt, rotateAt, lastLvl, pick: { zone, zn, g, xp, mons, targets } }
// cfg.levelChrono[perso] = { prestige, startedAt, fromLvl, lastLvl } (gardé si on arrête puis relance avant 200)
// cfg.levelHistory[perso] = [{ prestige, fromLvl, ms, at }] (une entrée par montée à 200)
const levelOn = () => !!cfg.levelRun?.active;
const LEVEL_STATS = ['sagesse', 'puissance', 'vitalite', '', ''];
const LEVEL_MAX = 200;
const LEVEL_MAX_DEFEATS = 5;   // défaites d'affilée (après baisse de prudence à chaque fois) : arrêt
const LEVEL_ALLOC_FALLBACK = '60dbf9f72590dfc5c79366a0bed9bbbc123e6de0e4';   // allocatePoints(stat, nombre) sur /personnage
const levelEstXp = (lvl) => lvl * (400 + 8 * lvl);
const levelChar = () => myName() || fightAcct();
// Niveau après le dernier combat terminé (combatOnEnd : rewards.newLevel) : { lvl, at, xp, noXp }. Pas lastFight() : l'Auto
// par poids ne le met pas à jour (niveau 200 d'une Ascension d'avant le Prestige → montée « finie » au 1er combat, 2.3.0).
// En sessionStorage, pas en variable : l'Auto par poids recharge la page en fin de combat (niveau resté à 31, 2.3.3).
const LEVEL_SEEN_KEY = 'dmLevelSeen';
const levelSeenGet = () => { try { return JSON.parse(sessionStorage.getItem(LEVEL_SEEN_KEY) || 'null'); } catch { return null; } };
const levelSeenSet = (v) => { try { sessionStorage.setItem(LEVEL_SEEN_KEY, JSON.stringify(v)); } catch { /* stockage indisponible */ } };
const levelScanCache = new Map();   // zone → { at, groups, rotateAt } : valable jusqu'au renouvellement des groupes
// montées enregistrées par erreur (2.3.0) : moins d'une minute
const levelHistOf = (who) => (cfg.levelHistory?.[who] || []).filter((x) => x.ms >= 60000);

// Fiche légère : niveau, Prestige, points libres et coût des points de Sagesse.
async function levelSheet() {
  const { flight, chunks } = await fetchFlight('/personnage');
  const { rows } = rscProps(flight, () => false);
  const res = (v) => rscResolve(rows, v);
  const alloc = rscProps(flight, (x) => Array.isArray(x.rows) && x.rows[0]?.key && 'pointsFree' in x).props;
  const info = rscProps(flight, (x) => 'prestige' in x && 'level' in x && 'equipped' in x).props;
  if (!info) throw new Error('fiche personnage illisible');
  const sag = alloc ? res(alloc.rows).map(res).find((r) => r.key === 'sagesse') : null;
  const t = sag ? res(sag.tiers) : null;
  return { level: +info.level || 1, prestige: +info.prestige || 0, pointsFree: +alloc?.pointsFree || 0, sagBase: +sag?.base || 0,
    sagTiers: Array.isArray(t) && t.length ? t.map(res) : DEFAULT_POINT_TIERS.sagesse, chunks };
}

// Points libres → Sagesse, au maximum possible (paliers de coût compris).
async function levelSpendPoints(sh) {
  let free = sh.pointsFree, v = sh.sagBase, n = 0;
  while (free >= pointCost(sh.sagTiers, v)) { free -= pointCost(sh.sagTiers, v); v++; n++; }
  if (!n) return 0;
  const id = await findAction(sh.chunks, 'allocatePoints', LEVEL_ALLOC_FALLBACK);
  const r = await callAction('personnage', id, ['sagesse', n]);
  if (r?.error) throw new Error(r.error);
  DM.log(`leveling : +${n} Sagesse (${sh.pointsFree} points)`);
  return n;
}

// Meilleur groupe : { zone, zn, g, xp, mons, total, rotateAt, targets } ou null.
async function levelBestGroup(lvl, danger, say = () => {}) {
  const all = await DM.fetchZones({ all: true });
  const mine = new Set((await DM.fetchZones().catch(() => [])).map((z) => z.id));
  const zones = all.filter((z) => mine.has(z.id) || (z.lvlMin != null && (z.lvlMax ?? z.lvlMin) >= lvl - 20 && z.lvlMin <= lvl + 20));
  if (!zones.length) throw new Error(`aucune zone autour du niveau ${lvl}`);
  const log = cfg.farmLog?.[fightAcct()] || [];
  const shared = Object.entries(cfg.farmShared || {}).flatMap(([p, l]) => l.map((r) => ({ ...r, src: p })));
  const { mobXpOf } = farmModel([...log, ...shared], null, { lvl, sag: 0, pp: 100 });
  const queue = [...zones], out = [];
  let done = 0;
  await Promise.all([0, 1, 2].map(async () => {
    while (queue.length) {
      const z = queue.shift();
      try {
        let c = levelScanCache.get(z.id);
        if (!c || Date.now() > (c.rotateAt || c.at + 3 * 60000) + 1000) { c = { at: Date.now(), ...(await scanZone(z.id)) }; levelScanCache.set(z.id, c); }
        const { groups, rotateAt } = c;
        for (const g of groups) {
          const mons = g.monsters.map((m) => ({ name: m.name, lvl: +m.lvl || 1, kind: m.archi ? 'archi' : m.wanted ? 'wanted' : targetMatch(m.name, ALL_KINDS)?.kind || null }));
          if (!mons.length) continue;
          const total = mons.reduce((t, m) => t + m.lvl, 0);
          if (total > Math.max(lvl * danger, 3)) continue;   // trop dangereux pour l'instant
          const target = (m) => !!m.kind;
          const noXp = (m) => !!cfg.levelNoXp?.[`${normName(m.name)}|${m.lvl}`];
          const est = (m) => levelEstXp(m.lvl) * (!m.kind ? 1 / 3 : m.kind === 'archi' ? 0.9 : 1);
          const base = mons.reduce((t, m) => t + (mobXpOf(m) || (noXp(m) ? 0 : est(m))), 0);
          if (!(base > 0)) continue;
          const xp = base * groupCoef(mons.length) * xpLevelPen(lvl, mons.map((m) => m.lvl));
          out.push({ zone: z.id, zn: z.name, g: g.n, xp, mons, total, rotateAt, targets: mons.filter(target).map((m) => m.name) });
        }
      } catch (e) { if (e.fatal) throw e; }
      say(`Leveling : scan ${++done}/${zones.length} zones…`);
      await sleep(200);
    }
  }));
  return out.sort((a, b) => b.xp - a.xp)[0] || null;
}

// Choix du groupe et départ vers sa zone. why : raison (journal).
async function levelPick(why) {
  const run = cfg.levelRun;
  if (!run?.active) return;
  const lvl = run.lastLvl || 1;
  setStatus('Leveling : recherche du groupe le plus rentable en XP…');
  progress();
  let best = null, danger = run.danger;
  // rien d'assez sûr : la prudence est relâchée (×1,25) et on rescanne, 4 fois au plus
  for (let i = 0; i < 4 && !best && levelOn(); i++) {
    if (i) danger = Math.min(12, danger * 1.25);
    try {
      best = await levelBestGroup(lvl, danger, (t) => { setStatus(t); progress(); });
    } catch (e) {
      DM.log(`leveling : scan impossible (${e.message})`);
      if (e.fatal) return levelStop(`scan impossible (${e.message})`);
      await sleep(5000);
    }
  }
  if (!levelOn()) return;
  if (!best) return levelStop(`aucun groupe trouvé autour du niveau ${lvl}`);
  if (danger !== run.danger) await save({ levelRun: { ...cfg.levelRun, danger } });
  DM.log(`leveling : ${why} → ${best.zn} groupe ${best.g} (${best.mons.map((m) => `${m.name} ${m.lvl}`).join(', ')}) ≈ ${Math.round(best.xp).toLocaleString('fr-FR')} XP de base, prudence ×${danger.toFixed(2)}`);
  await save({ levelRun: { ...cfg.levelRun, pickedAt: Date.now(), pickLvl: lvl, rotateAt: best.rotateAt || null, pick: best },
    mode: 'chasse', huntZone: best.zone, huntZoneName: best.zn, huntGroup: best.g, huntTarget: null });
  setStatus(`Leveling : ${best.zn}, groupe ${best.g}${best.targets.length ? ` (🎯 ${best.targets.join(', ')})` : ''}…`);
  progress();
  if (isOwner()) location.assign(`/chasse?zone=${best.zone}`);
}

// Sur la page de zone : pas encore de groupe choisi (départ, ou rien d'assez sûr au dernier scan) → on cherche.
// true = on s'en occupe.
async function levelNeedPick() {
  if (!levelOn()) return false;
  const run = cfg.levelRun;
  if (run.pickedAt && run.pick && cfg.huntZone === run.pick.zone) return false;
  await levelPick('choix du groupe');
  return true;
}

// Après une victoire : niveau, points, fin à 200, nouveau choix au renouvellement des groupes.
// true = on s'en occupe (pas de relance du même groupe).
async function levelAfterWin() {
  if (!levelOn() || !isHunt()) return false;
  const run = cfg.levelRun;
  // niveau après le combat qui vient de finir (récompenses du jeu)
  const ls = levelSeenGet();
  const fresh = ls && ls.at > (run.startedAt || 0) && Date.now() - ls.at < 5 * 60000 ? ls : null;
  const lvl = Math.max(fresh?.lvl || 0, run.lastLvl || 1);
  // monstres à 0 XP (archis grade 6) : retenus pour ne plus les viser
  if (fresh?.noXp?.length) await save({ levelNoXp: { ...(cfg.levelNoXp || {}), ...Object.fromEntries(fresh.noXp.map((k) => [k, Date.now()])) } });
  const wins = (run.wins || 0) + 1;
  const danger = wins % 5 === 0 ? Math.min(12, run.danger * 1.1) : run.danger;
  await save({ levelRun: { ...run, wins, danger, lastLvl: lvl } });
  if (lvl > (run.lastLvl || 0)) await levelOnLevelUp(run.lastLvl || lvl, lvl);
  if (!levelOn()) return true;
  const rotated = (run.rotateAt && Date.now() > run.rotateAt + 2000) || Date.now() - (run.pickedAt || 0) > 4 * 60000;
  if (fresh && fresh.xp === 0) { await levelPick('0 XP sur ce groupe (archimonstre de grade 6 ?)'); return true; }
  if (rotated) { await levelPick('groupes renouvelés'); return true; }
  if (lvl > (run.pickLvl || lvl)) { await levelPick(`niveau ${lvl} : zones et groupes revus`); return true; }
  return false;
}

// Passage de niveau : points en Sagesse, équipement revu, palier de notification, fin à 200.
async function levelOnLevelUp(from, lvl) {   // lvl peut être corrigé par la fiche
  const who = levelChar();
  if (cfg.levelChrono?.[who]) await save({ levelChrono: { ...cfg.levelChrono, [who]: { ...cfg.levelChrono[who], lastLvl: lvl } } });
  try {
    const sh = await levelSheet();
    if (sh.pointsFree > 0) await levelSpendPoints(sh);
    if (sh.level > lvl) { lvl = sh.level; await save({ levelRun: { ...cfg.levelRun, lastLvl: lvl } }); }   // la fiche fait foi
  } catch (e) { DM.log(`leveling : points non répartis (${e.message})`); }
  try { await autoEquipTick(true); } catch { /* auto-équipement facultatif */ }
  const every = Math.max(0, +cfg.levelNotifyEvery || 0);
  if (every && Math.floor(lvl / every) > Math.floor(from / every) && lvl < LEVEL_MAX) {
    notify('level', `📈 **Leveling** : niveau **${lvl}** atteint (${levelChronoText()}).`);
  }
  if (lvl >= LEVEL_MAX) {   // confirmé par la fiche avant de clore la montée
    const real = await levelSheet().then((sh) => sh.level).catch(() => null);
    if (real >= LEVEL_MAX) await levelFinish();
    else if (real) await save({ levelRun: { ...cfg.levelRun, lastLvl: real } });
  }
}

const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };
function levelChronoText() {
  const c = cfg.levelChrono?.[levelChar()];
  return c ? `⏱ ${fmtDur(Date.now() - c.startedAt)} depuis le niveau ${c.fromLvl}${c.prestige ? `, Prestige ${c.prestige}` : ''}` : '';
}
// Moyennes des montées complètes depuis le niveau 1 : par Prestige { p: { n, avg } } et toutes confondues.
function levelAverages() {
  const h = levelHistOf(levelChar()).filter((x) => x.fromLvl <= 1);
  const by = {};
  for (const x of h) (by[x.prestige] ||= []).push(x.ms);
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  return { by: Object.fromEntries(Object.entries(by).map(([p, a]) => [p, { n: a.length, avg: avg(a) }])), all: h.length ? avg(h.map((x) => x.ms)) : null, n: h.length };
}

async function levelFinish() {
  const who = levelChar(), c = cfg.levelChrono?.[who];
  const ms = c ? Date.now() - c.startedAt : null;
  const hist = { ...(cfg.levelHistory || {}) };
  if (c) hist[who] = [...levelHistOf(who), { prestige: c.prestige, fromLvl: c.fromLvl, ms, at: Date.now() }].slice(-50);
  const chrono = { ...(cfg.levelChrono || {}) };
  delete chrono[who];
  await save({ levelHistory: hist, levelChrono: chrono });
  const a = levelAverages();
  const stop = cfg.levelStopAt200 !== false;
  const msg = `🎉 **Leveling terminé : niveau ${LEVEL_MAX}** sur DofusMasters${c ? ` en **${fmtDur(ms)}** (depuis le niveau ${c.fromLvl}${c.prestige ? `, Prestige ${c.prestige}` : ''})` : ''}.`
    + (a.n ? `\nMoyenne : ${fmtDur(a.all)} sur ${a.n} montée(s) complète(s).` : '')
    + (stop ? ' Pilote arrêté.' : ' Le pilote continue en chasse.');
  await levelEnd(`Leveling terminé : niveau ${LEVEL_MAX}${ms ? ` en ${fmtDur(ms)}` : ''}`, msg, stop);
}

// Défaite : prudence en baisse, nouveau groupe tout de suite ; trop de défaites d'affilée → arrêt.
async function levelOnDefeat(streak, hint) {
  const run = cfg.levelRun;
  const danger = Math.max(1, run.danger * 0.75);
  await save({ levelRun: { ...run, wins: 0, danger } });
  if (streak >= LEVEL_MAX_DEFEATS) return levelStop(`${streak} défaites d’affilée${hint ? ` (💡 ${hint})` : ''}`);
  return levelPick(`défaite (prudence ×${danger.toFixed(2)})`);
}

// Fin du mode : stop = pilote arrêté (sinon il continue en chasse sur le dernier groupe).
async function levelEnd(status, msg, stop = true) {
  const run = cfg.levelRun;
  if (!run) return;
  await save({ levelRun: { ...run, active: false, endedAt: Date.now() }, status,
    ...(stop ? { enabled: false, paused: false, botFight: false } : {}) });
  if (msg) notify('level', msg);
}
const levelStop = (reason) => levelEnd(`Leveling arrêté : ${reason}`.slice(0, 200), `⏹️ **Leveling arrêté** : ${reason}${levelChronoText() ? ` (${levelChronoText()})` : ''}`);

async function startLeveling() {
  if (dropOn()) await dropStop('remplacé par 📈 Leveling', false);
  if (sampleOn()) await sampleStop('remplacé par 📈 Leveling');
  const sh = await levelSheet();
  if (sh.level >= LEVEL_MAX) throw new Error(`déjà niveau ${LEVEL_MAX}`);
  const who = levelChar(), chrono = { ...(cfg.levelChrono || {}) };
  if ((cfg.levelHistory?.[who] || []).length !== levelHistOf(who).length) await save({ levelHistory: { ...cfg.levelHistory, [who]: levelHistOf(who) } });
  // chrono : repris si c'est la même montée (même Prestige, niveau pas redescendu), sinon il repart
  const c = chrono[who];
  if (!c || c.prestige !== sh.prestige || (c.lastLvl || 0) > sh.level) chrono[who] = { prestige: sh.prestige, startedAt: Date.now(), fromLvl: sh.level, lastLvl: sh.level };
  const run = { active: true, startedAt: Date.now(), danger: Math.max(1, +cfg.levelRun?.danger || 2), wins: 0, lastLvl: sh.level, pickedAt: 0 };
  await save({ levelRun: run, levelChrono: chrono, mode: 'chasse', pauseReason: null });
  if (sh.pointsFree > 0) await levelSpendPoints(sh).catch((e) => DM.log(`leveling : points non répartis (${e.message})`));
  await send({ type: 'claim', start: true }).catch(() => {});
  notify('level', `📈 **Leveling lancé** au niveau ${sh.level}${sh.prestige ? ` (Prestige ${sh.prestige})` : ''}.`);
  await levelPick('départ');
}
