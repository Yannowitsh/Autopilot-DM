// Autopilot-DM — content script : enregistrement en ligne des combats (option « Enregistrer mes combats en ligne »).
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.
// À chaque fin de combat (gagné / perdu) : état complet du serveur (tous les combattants, stats, buffs, journal des coups),
// récompenses, définition des cartes jouées (lignes de dégâts, critique) et photo du build — fiche perso (niveau, prestige,
// Bouclier de forge, points), équipement porté (fusion, stats de base et fusionnées), parchemins d'arène.
// Le combat attend d'abord dans le localStorage de la page (survit au rechargement du combat rapide), puis le service
// worker l'envoie au Worker de synchro (POST /combats, voir sync-worker/ et background.js).
const COMBAT_PENDING_KEY = 'dmCombatPending';   // combats pas encore remis au service worker
const COMBAT_SEEN_KEY = 'dmCombatSeen';         // signatures des derniers combats enregistrés (doublons netwatch / auto par poids)
const COMBAT_SNAP_KEY = 'dmBuildSnap';          // photo du build par personnage { stats signature, sheet, gear, scrolls, at }
const COMBAT_CARDS_KEY = 'dmCardDefs';          // définitions des cartes de la collection par personnage { at, cards: { nom: carte } }
const COMBAT_SNAP_MAX_AGE = 30 * 60000;         // photo du build relue au plus tard toutes les 30 min (ou dès que les stats changent)
const COMBAT_SNAP_MIN_GAP = 5 * 60000;
const COMBAT_CARDS_MAX_AGE = 6 * 3600000;
const COMBAT_PENDING_MAX = 10;

const combatOn = () => cfg.combatUpload !== false;
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
// Empreinte courte (FNV-1a) : identifiant de combat et signature des stats.
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
const statsSig = (stats) => fnv(JSON.stringify(Object.entries(stats || {}).sort()));

// Journal complet d'un combat : le serveur ne renvoie que les 150 dernières entrées (log), logCount = nombre total. Chaque
// état reçu en cours de combat est recollé au précédent (sessionStorage de l'onglet) ; logFrom = indice de la 1re entrée
// connue (0 = journal complet).
const FIGHT_LOG_KEY = 'dmFightLog';
function withFullLog(st) {
  if (!st || !Array.isArray(st.log) || !(+st.logCount)) return st;
  const key = `${st.kind}|${(st.order || []).join(',')}|${Object.values(st.fighters || {}).map((f) => `${f.name}:${f.maxHp}`).join(',')}`;
  const start = +st.logCount - st.log.length;
  let acc = null;
  try { acc = JSON.parse(sessionStorage.getItem(FIGHT_LOG_KEY) || 'null'); } catch { /* stockage indisponible */ }
  const end = acc ? acc.from + acc.log.length : 0;
  if (!acc || acc.key !== key || +st.logCount < end || start > end || start <= acc.from) acc = { key, from: start, log: st.log.slice() };   // autre combat, trou, ou état plus complet
  else acc.log = acc.log.slice(0, start - acc.from).concat(st.log);
  try { sessionStorage.setItem(FIGHT_LOG_KEY, JSON.stringify(acc)); } catch { /* journal trop gros : on garde l'état reçu */ }
  return { ...st, log: acc.log, logFrom: acc.from };
}

// Fin de combat (état du serveur `st`, récompenses) : mise en attente, puis remise au service worker.
function combatOnEnd(st, rewards) {
  if (st?.status && st.status !== 'ongoing') selfCheckFight(st);   // auto-diagnostic (selfcheck.js), même sans envoi en ligne
  try {
    if (!combatOn() || !st?.fighters?.p || !st.status || st.status === 'ongoing') return;
    const id = fnv(`${st.kind}|${st.logCount}|${st.status}|${JSON.stringify(st.log?.slice(0, 3))}|${JSON.stringify(st.log?.slice(-3))}`);
    const seen = lsGet(COMBAT_SEEN_KEY, []);
    if (seen.includes(id)) return;
    lsSet(COMBAT_SEEN_KEY, [...seen, id].slice(-30));
    // Ascension : étage, boss, mécaniques vues dans le journal et cause d'une défaite (gardés aussi pour l'étage, ascmech.js)
    const ids = Object.values(st.fighters).filter((f) => f.team !== st.fighters.p.team && f.isBoss).map((f) => +f.monsterId);
    const ascBossN = (f) => (f >= 7 ? 3 : f >= 4 ? 2 : 1);   // « Étages 1 à 3 : un boss, 4 à 6 : 2, dès 7 : 3 »
    const onAsc = st.kind === 'boss' && cfg.ascFloor && ids.length === ascBossN(+cfg.ascFloor)
      && (cfg.ascBosses?.length ? ids.every((m) => cfg.ascBosses.includes(m)) : isAsc());
    const asc = onAsc ? { floor: +cfg.ascFloor, diff: cfg.ascDiff || null, at: Date.now(), status: st.status, rounds: +st.round || 0,
      bosses: Object.values(st.fighters).filter((f) => f.team !== st.fighters.p.team && f.isBoss).map((f) => ({ id: +f.monsterId, name: f.name, maxHp: +f.maxHp || 0, atk: +f.atk || 0, element: f.element ?? null,
        res: EL_RES_PCT.map((k) => +f.stats?.[k] || 0), resCap: +f.resCap || 100,
        // motif d'intentions (« $1:state:fighters:b0:pattern » = celui d'un autre boss)
        pattern: Array.isArray(f.pattern) ? f.pattern : st.fighters[String(f.pattern || '').split(':')[3]]?.pattern || null })),
      seen: observedMechanics(st), cause: st.status === 'lost' ? ascFailCause(st) : null } : null;
    if (asc) {
      ascRemember(asc);
      if (asc.cause) DM.log(`ascension étage ${asc.floor} perdue — ${asc.cause} ; vu : ${asc.seen.map((o) => `${o.bossName} ${o.name || '?'} (t${o.round})`).join(', ') || 'rien'}`);
    }
    const rec = { v: 1, id, at: Date.now(), asc, player: myName() || null, acct: fightAcct(), ext: chrome.runtime.getManifest().version, page: location.pathname,
      kind: st.kind, status: st.status, state: st, rewards: rewards || null };
    const pending = lsGet(COMBAT_PENDING_KEY, []);
    pending.push(rec);
    if (!lsSet(COMBAT_PENDING_KEY, pending.slice(-COMBAT_PENDING_MAX))) lsSet(COMBAT_PENDING_KEY, [rec]);   // stockage plein : le dernier seulement
    combatFlush();
  } catch (e) { DM.log(`combat en ligne : ${e.message}`); }
}

// Photo du build : relue si trop vieille ou si les stats du combat ne correspondent plus (équipement changé).
async function combatSnapshot(sig) {
  const acct = fightAcct(), all = lsGet(COMBAT_SNAP_KEY, {}), cur = all[acct];
  const age = cur ? Date.now() - cur.at : Infinity;
  // stats différentes (équipement changé… ou buff de fin de combat) : relue, mais au plus toutes les 5 min
  if (cur && (cur.sig === sig ? age < COMBAT_SNAP_MAX_AGE : age < COMBAT_SNAP_MIN_GAP)) return cur;
  const [sheet, gear] = await Promise.all([fetchCharSheet().catch((e) => ({ error: e.message })), fetchEquipState().catch((e) => ({ error: e.message }))]);
  const snap = { at: Date.now(), sig, sheet: sheet.error ? sheet : { ...sheet, tiers: undefined },
    gear: gear.error ? gear : gear.slots.map((s) => ({ slot: s.slot, item: s.cur && { id: s.cur.id, name: s.cur.name, lvl: s.cur.lvl, type: s.cur.type,
      rarity: s.cur.rarity, fusion: s.cur.fusion, set: s.cur.setName, base: s.cur.baseEff, fused: s.cur.eff } })),
    scrolls: gear.error ? null : gear.scrolls, level: gear.error ? null : gear.level };
  // lecture ratée (souvent : page rechargée pendant la lecture) : pas gardée, on réessaie au prochain combat
  if (!sheet.error && !gear.error) lsSet(COMBAT_SNAP_KEY, { ...all, [acct]: snap });
  else if (cur) return { ...cur, retryError: sheet.error || gear.error };
  return snap;
}
// Cartes de la collection (lignes complètes) : relues si trop vieilles ou si une carte jouée est inconnue.
async function combatCards(names) {
  const acct = fightAcct(), all = lsGet(COMBAT_CARDS_KEY, {}), cur = all[acct];
  if (cur && Date.now() - cur.at < COMBAT_CARDS_MAX_AGE && names.every((n) => cur.cards[n] || cur.missing?.includes(n))) return cur;
  const { spells } = await fetchSpells();
  const cards = Object.fromEntries(spells.map((s) => [s.name, s.card]));
  const out = { at: Date.now(), cards, missing: names.filter((n) => !cards[n]) };   // armes, cartes hors collection
  if (!lsSet(COMBAT_CARDS_KEY, { ...all, [acct]: out })) lsSet(COMBAT_CARDS_KEY, { [acct]: out });
  return out;
}

let combatFlushing = false;
async function combatFlush() {
  if (combatFlushing || dead) return;
  const pending = lsGet(COMBAT_PENDING_KEY, []);
  if (!pending.length) return;
  if (!combatOn()) { lsSet(COMBAT_PENDING_KEY, []); return; }
  combatFlushing = true;
  try {
    for (const rec of pending) {
      const p = rec.state.fighters.p;
      if (!rec.snap) {
        const snap = await combatSnapshot(statsSig(p.stats)).catch((e) => ({ error: e.message }));
        rec.snap = { ...snap, match: snap.sig === statsSig(p.stats) };
      }
      if (!rec.cards) {
        const names = [...new Set((rec.state.log || []).filter((L) => L.t === 'play' && L.who === 'p' && L.card).map((L) => L.card))];
        try {
          const c = await combatCards(names);
          rec.cards = Object.fromEntries(names.filter((n) => c.cards[n]).map((n) => [n, c.cards[n]]));
        } catch (e) { rec.cards = { error: e.message }; }
      }
      const r = await send({ type: 'combatRec', rec });
      if (!r?.ok) throw new Error(r?.error || 'service worker indisponible');
      lsSet(COMBAT_PENDING_KEY, lsGet(COMBAT_PENDING_KEY, []).filter((x) => x.id !== rec.id));
    }
  } catch (e) {
    DM.log(`combat en ligne : en attente (${e.message})`);
  } finally {
    combatFlushing = false;
  }
}
