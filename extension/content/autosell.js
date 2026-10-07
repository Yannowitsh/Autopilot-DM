// Autopilot-DM — content script : autosell + verrous d’objets (cadenas).
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- Autosell : vend tout l'inventaire non équipé ----------
// /inventaire est une page Next.js : l'inventaire est dans le payload RSC (self.__next_f.push)
// et la vente passe par la server action « sellItems » ([{ itemId, fusion, qty }, …]).
// `entries` ne contient que les objets non portés ; le serveur refuse de toute façon de vendre un objet porté.
const SELL_ACTION_FALLBACK = '606e0b152d7eeb65f891df20554b9d310fd5dfd04c';
const NEVER_SELL_SLOTS = new Set(['familier', 'dofus']);   // jamais vendus par l'Autosell
// Valeur de fusion du tier max « Rayonnant » (= FUSION.max du jeu : 0 = Tiers 1 … 3 = Tiers 4, 4 = Rayonnant, le « tier 5 »).
// Jamais vendu automatiquement (comme « Tout cocher » sur le site).
const FUSION_MAX = 4;
const SELL_BATCH = 50;
let sellActionId = null;

// Résout une référence RSC « $10:props:children:1:… » vers la valeur pointée.
function rscResolve(rows, v) {
  const m = typeof v === 'string' && v.match(/^\$([0-9a-f]+):(.+)$/);
  if (!m) return v;
  let cur = rows[m[1]];
  for (const k of m[2].split(':')) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) && cur[0] === '$' && k === 'props' ? cur[3] : cur[k];
  }
  return cur;
}

// Page Next.js : payload RSC concaténé (« flight ») + chunks JS (pour retrouver les server actions).
// Simple lecture (GET) : en cas d'erreur serveur (5xx, « Resource Limit » 508…) ou réseau, on réessaie
// FLIGHT_RETRY_WAITS fois en espaçant ; fetchFlight.onRetry(message) permet d'afficher la progression.
const FLIGHT_RETRY_WAITS = [2000, 5000, 10000, 20000];
async function fetchFlight(path) {
  let r;
  for (let i = 0; ; i++) {
    let why = null;
    try {
      r = await DM.fetchT(path, { credentials: 'same-origin', cache: 'no-store' });
      if (r.status >= 500) why = `HTTP ${r.status}`;
    } catch (e) {
      why = e.name === 'TimeoutError' ? 'délai dépassé' : 'erreur réseau';
    }
    if (!why) break;
    if (i >= FLIGHT_RETRY_WAITS.length) throw new Error(`${path} : ${why} (après ${i + 1} essais)`);
    fetchFlight.onRetry?.(`${path} : ${why} — nouvel essai ${i + 2}/${FLIGHT_RETRY_WAITS.length + 1} dans ${FLIGHT_RETRY_WAITS[i] / 1000} s…`);
    await sleep(FLIGHT_RETRY_WAITS[i]);
  }
  if (r.redirected && /connexion/.test(r.url)) throw new Error('Déconnecté');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  let flight = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) flight += JSON.parse(m[1]);
  const chunks = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/[^"'\\\s]+?\.js(?:\?[^"'\\\s]*)?/g)].map((m) => m[0]))];
  return { flight, chunks, html };
}

// Lignes JSON du payload RSC (« id:{…} ») + premier objet (non tableau) qui satisfait `pred`.
function rscProps(flight, pred) {
  const rows = {};
  for (const line of flight.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]+):([[{].*)$/);
    if (!m) continue;
    try { rows[m[1]] = JSON.parse(m[2]); } catch { /* ligne texte/partielle */ }
  }
  let props = null;
  const walk = (x) => {
    if (props || x == null || typeof x !== 'object') return;
    if (!Array.isArray(x) && pred(x)) { props = x; return; }
    for (const k in x) walk(x[k]);
  };
  for (const id in rows) walk(rows[id]);
  return { rows, props };
}

async function fetchInventory() {
  const { flight, chunks } = await fetchFlight('/inventaire');
  const { rows, props } = rscProps(flight, (x) => Array.isArray(x.entries) && Array.isArray(x.slots));
  if (!props) throw new Error('Inventaire introuvable dans la page');

  const entries = props.entries.map((e) => {
    const item = rscResolve(rows, e.item) || {};
    return { id: item.id, name: item.n, lvl: item.lvl, slot: item.s, rarity: item.r, fusion: e.fusion, qty: e.qty, locked: !!e.locked };
  }).filter((e) => Number.isInteger(e.id) && e.qty > 0);
  return { entries, chunks, level: +props.level || null, lockable: props.lockable !== false };
}

// L'ID d'une server action change à chaque déploiement : on le relit dans les chunks JS de la page.
async function findAction(chunks, name, fallback) {
  const re = new RegExp(`createServerReference\\)\\("([0-9a-f]{20,})",[^)]*?"${name}"\\)`);
  for (const src of [...chunks].reverse()) {
    try {
      const m = (await (await DM.fetchT(src)).text()).match(re);
      if (m) return m[1];
    } catch { /* chunk suivant */ }
  }
  return fallback;
}

// Résultat d'une server action dans la réponse RSC : la ligne 0 le désigne (« "a":"$@N" ») ; souvent la ligne 1, mais pas
// toujours (la ligne 1 peut être une référence de module « I[…] » : « Unexpected token 'I' » avant la 1.81.1).
// Sinon : première ligne objet { ok | error }. → objet résultat, ou null.
function actionResult(text) {
  const rows = new Map();
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(/^([0-9a-f]+):(.*)$/);
    if (m && !rows.has(m[1])) rows.set(m[1], m[2]);
  }
  const parse = (v) => { try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } };
  const ref = rows.get('0')?.match(/^\{"a":"\$@([0-9a-f]+)"/)?.[1];
  const res = parse(rows.get(ref || '1') || '');
  if (res) return res;
  for (const [k, v] of rows) {
    if (k === '0' || v[0] !== '{') continue;
    const o = parse(v);
    if (o && ('ok' in o || 'error' in o)) return o;
  }
  return null;
}

// Appelle une server action de la page /<segment> ; renvoie son résultat (ligne « 1: » de la réponse RSC).
// Erreur renvoyée par le jeu (« Pas assez de kamas »…) : err.game = true ; sinon problème de protocole (ID périmé…).
async function callAction(segment, actionId, args, query = '') {
  return (await postAction(segment, actionId, args, query)).res;
}

// Comme callAction, mais renvoie aussi le texte brut (la page re-rendue suit le résultat).
async function postAction(segment, actionId, args, query = '') {
  const tree = encodeURIComponent(JSON.stringify(['', { children: [segment, { children: ['__PAGE__', {}, null, null, 4096] }, null, null, 4096] }, null, null, 4116]));
  const r = await DM.fetchT(`/${segment}${query}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'text/x-component',
      'Content-Type': 'text/plain;charset=UTF-8',
      'Next-Action': actionId,
      'Next-Router-State-Tree': tree,
    },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  const text = await r.text();
  const res = actionResult(text);
  if (!res) throw new Error('Réponse du serveur illisible');
  if (res.error) throw Object.assign(new Error(res.error), { game: true });
  return { res, text };
}

async function sellItems(actionId, items) {
  return (await callAction('inventaire', actionId, [items])).kamas || 0;
}

// dryRun = true : renvoie seulement ce qui serait vendu.
async function autosell(dryRun) {
  // cadenas à jour d'abord (équipements enregistrés, liste de drops…) ; à défaut, les derniers verrous connus
  let sync = null;
  try { sync = await syncLocks({ force: true }); } catch (e) { DM.log(`autosell : synchro des verrous impossible (${e.message})`); }
  const { entries, chunks, level } = await fetchInventory();
  const keepAbove = cfg.sellKeepAbove !== false;
  if (keepAbove && !level) throw new Error('Niveau du personnage illisible : vente annulée');
  const ls = lockStateOf();
  const locked = sync?.want || new Set([...Object.keys(ls ? ls.manual : cfg.lockedItems || {}),
    ...Object.keys(ls?.auto || {}).filter((k) => !ls.optOut?.[k])]);
  const keepRar = new Set(cfg.sellKeepRarities || []);
  // Raison de garder un objet (par ordre de priorité), ou null s'il est vendable.
  const keepReason = (e) => e.locked || locked.has(DM.lockKey(e.name, e.lvl)) ? 'locked'
    : NEVER_SELL_SLOTS.has(e.slot) ? 'slot'
    : keepRar.has(e.rarity) ? 'rarity'
    : e.fusion >= FUSION_MAX ? 'radiant'
    : keepAbove && !(e.lvl <= level) ? 'above'
    : null;
  const kept = { locked: 0, slot: 0, rarity: 0, radiant: 0, above: 0 };
  const toSell = [];
  for (const e of entries) {
    const why = keepReason(e);
    if (why) kept[why]++; else toSell.push(e);
  }
  const count = toSell.reduce((n, e) => n + e.qty, 0);
  const estimate = toSell.reduce((n, e) => n + 20 * (e.lvl || 0) * e.qty, 0);
  const info = { level, keepAbove, skipped: kept.radiant, lockedCount: kept.locked, aboveCount: kept.above, slotCount: kept.slot, rarityCount: kept.rarity };
  if (dryRun || !count) return { ok: true, count, estimate, ...info, kamas: 0 };

  if (!sellActionId) sellActionId = await findAction(chunks, 'sellItems', SELL_ACTION_FALLBACK);
  let kamas = 0, sold = 0;
  for (let i = 0; i < toSell.length; i += SELL_BATCH) {
    const batch = toSell.slice(i, i + SELL_BATCH);
    kamas += await sellItems(sellActionId, batch.map((e) => ({ itemId: e.id, fusion: e.fusion, qty: e.qty })));
    sold += batch.reduce((n, e) => n + e.qty, 0);
    if (i + SELL_BATCH < toSell.length) await sleep(800 + Math.random() * 700);
  }
  return { ok: true, count: sold, estimate, ...info, kamas };
}

// ---------- Verrou d'objets : cadenas du jeu, synchronisé avec l'extension ----------
// Server action « setItemLock(itemId, fusion, verrouillé) » (/inventaire) : le jeu pose le cadenas par pile (objet + tier).
// Objet verrouillé : ni vendu, ni brisé, ni fusionné, ni mis à l'HDV. L'extension raisonne par objet (clé nom + niveau) :
// tous ses tiers suivent. État par personnage (le stockage est commun aux deux comptes) : cfg.lockState[nom] = {
//   manual:  { clé: { name, lvl } }        cadenas mis à la main (en jeu ou ici) : jamais retirés automatiquement
//   auto:    { clé: { name, lvl, src } }   objets des équipements enregistrés (/personnage) et de la liste de drops
//   optOut:  { clé: 1 }                    objets « auto » déverrouillés à la main : plus reverrouillés tant qu'ils y restent
//   seen:    ['id|fusion', …]              piles verrouillées à la dernière lecture : repère les cadenas ouverts / fermés en jeu
//   presets: [{ slot, name, items }]       équipements enregistrés à la dernière lecture (noms d'objets, sans ID)
//   syncAt }
// Cadenas fermé en jeu sur un objet que rien ne verrouille → verrou « à la main » (tous les tiers) ; cadenas ouvert en jeu →
// tout l'objet est déverrouillé. Objet sorti des équipements enregistrés / de la liste de drops → déverrouillé, sauf s'il
// était verrouillé à la main.
const LOCK_ACTION_FALLBACK = '705e9898422cc41c27d2a949ae2d46fa5df960a549';
const LOCK_SYNC_MS = 5 * 60000;
let lockActionId = null, lockSyncTimer = null, lockTimer = null;
const lockStateOf = () => cfg.lockState?.[myName() || '?'] || null;
const stackKey = (id, f) => `${id}|${f || 0}`;
const nameKey = (s) => String(s || '').trim().toLowerCase();

async function setItemLock(id, fusion, on) {
  if (!lockActionId) lockActionId = await findAction((await fetchFlight('/inventaire')).chunks, 'setItemLock', LOCK_ACTION_FALLBACK);
  try {
    await callAction('inventaire', lockActionId, [id, fusion || 0, !!on]);
  } catch (e) {
    if (!e.game) lockActionId = null;   // l'ID a peut-être changé : relu au prochain appel
    throw e;
  }
}

// Note une pile (dé)verrouillée par l'extension elle-même (fusion…), pour ne pas la prendre pour un clic en jeu.
function lockSeen(id, fusion, on) {
  const me = myName(), st = cfg.lockState?.[me];
  if (!st?.seen) return;
  const seen = new Set(st.seen);
  if (on) seen.add(stackKey(id, fusion)); else seen.delete(stackKey(id, fusion));
  return save({ lockState: { ...cfg.lockState, [me]: { ...st, seen: [...seen] } } });
}

// Équipements enregistrés de /personnage (composant GearPresets) ; null si illisibles (on garde alors la dernière lecture).
async function fetchPresets() {
  const { flight } = await fetchFlight('/personnage');
  const { props } = rscProps(flight, (x) => Array.isArray(x.presets));
  return props && props.presets.map((p) => ({ slot: p.slot, name: String(p.name || `Équipement ${(+p.slot || 0) + 1}`), items: (p.items || []).filter(Boolean) }));
}

// Synchronise les cadenas du jeu et l'état de l'extension. `unlock` : clés à déverrouiller (✕ dans le menu de l'extension) ;
// `ifStale` : seulement si la dernière synchro a plus de LOCK_SYNC_MS. Une seule synchro à la fois par profil de navigateur
// (Web Locks : les onglets d'un même compte ne se marchent pas dessus ; la navigation privée a les siens).
// → { want: Set des clés à protéger, locked, unlocked } ; null si rien n'a été fait (personnage inconnu, synchro récente).
function syncLocks(opts = {}) {
  const asked = Date.now();
  const run = () => doSyncLocks({ ...opts, asked });
  return navigator.locks?.request ? navigator.locks.request('dm-item-locks', run) : run();
}

async function doSyncLocks({ unlock, asked = 0, ifStale = false, force = false, reload = false }) {
  const me = myName();
  if (!me) return null;
  const prev = cfg.lockState?.[me];
  if (ifStale && Date.now() - (prev?.syncAt || 0) < LOCK_SYNC_MS) return null;   // un autre onglet vient de le faire
  if (!force && !unlock && !ifStale && (prev?.syncAt || 0) > asked) return null;   // idem, depuis la demande
  const [inv, presets] = await Promise.all([fetchInventory(),
    fetchPresets().catch((e) => { DM.log(`verrous : équipements enregistrés illisibles (${e.message})`); return null; })]);
  const cur = cfg.lockState?.[me];
  // 1re synchro de ce personnage : on reprend les verrous de l'extension (avant la 1.79, communs aux deux comptes)
  const st = cur ? { manual: { ...cur.manual }, auto: { ...cur.auto }, optOut: { ...cur.optOut }, seen: cur.seen, presets: cur.presets || [] }
    : { manual: { ...(cfg.lockedItems || {}) }, auto: {}, optOut: {}, seen: null, presets: [] };
  if (presets) st.presets = presets;
  const inPreset = new Map();   // nom d'objet → équipements enregistrés qui le contiennent
  for (const p of st.presets) for (const n of p.items) inPreset.set(nameKey(n), [...new Set([...(inPreset.get(nameKey(n)) || []), p.name])]);
  const cart = cfg.dropLockCart !== false ? cfg.dropCart || [] : [];
  const cartIds = new Set(cart.map((c) => c.id)), cartNames = new Set(cart.map((c) => nameKey(c.name)));
  const sourcesOf = (e) => [...(inPreset.get(nameKey(e.name)) || []).map((n) => `équipement « ${n} »`), ...(cartIds.has(e.id) ? ['liste de drops'] : [])];
  const seen = st.seen && new Set(st.seen);
  const groups = new Map();
  for (const e of inv.entries) {
    const k = DM.lockKey(e.name, e.lvl);
    if (!groups.has(k)) groups.set(k, { name: e.name, lvl: e.lvl, stacks: [] });
    groups.get(k).stacks.push(e);
  }
  const toLock = [], toUnlock = [], want = new Set();
  for (const [k, g] of groups) {
    const locked = g.stacks.filter((e) => e.locked);
    const src = sourcesOf(g.stacks[0]);
    // cadenas ouvert en jeu (pile verrouillée à la dernière lecture, toujours là mais ouverte), ou ✕ dans l'extension
    if (unlock?.has(k) || (seen && g.stacks.some((e) => !e.locked && seen.has(stackKey(e.id, e.fusion))))) {
      if (st.manual[k] || (st.auto[k] && !st.optOut[k])) DM.log(`verrous : ${g.name} déverrouillé à la main`);
      delete st.manual[k];
      if (src.length) { st.auto[k] = { name: g.name, lvl: g.lvl, src }; st.optOut[k] = 1; } else delete st.auto[k];
      toUnlock.push(...locked);
      continue;
    }
    const autoOn = src.length > 0 && !st.optOut[k];
    // cadenas fermé en jeu sur un objet que rien ne verrouille (ou déjà fermé à la 1re synchro) → verrou « à la main »
    if (!st.manual[k] && !autoOn && !st.auto[k] && locked.some((e) => !seen || !seen.has(stackKey(e.id, e.fusion)))) {
      st.manual[k] = { name: g.name, lvl: g.lvl };
      delete st.optOut[k];
      DM.log(`verrous : ${g.name} verrouillé à la main (en jeu)`);
    }
    if (src.length) st.auto[k] = { name: g.name, lvl: g.lvl, src };
    else if (st.auto[k]) {   // sorti des équipements enregistrés / de la liste de drops
      delete st.auto[k];
      delete st.optOut[k];
      if (!st.manual[k]) { toUnlock.push(...locked); continue; }
    }
    if (st.manual[k] || autoOn) {
      want.add(k);
      toLock.push(...g.stacks.filter((e) => !e.locked));
    }
  }
  for (const k of unlock || []) {   // ✕ sur un objet absent de l'inventaire (porté…) : on oublie son verrou
    if (groups.has(k)) continue;
    delete st.manual[k];
    if (st.auto[k]) st.optOut[k] = 1;
  }
  // objets « auto » absents de l'inventaire (portés, vendus…) : oubliés quand ils ne sont plus dans aucune source
  for (const [k, a] of Object.entries(st.auto)) {
    if (!groups.has(k) && !inPreset.has(nameKey(a.name)) && !cartNames.has(nameKey(a.name))) { delete st.auto[k]; delete st.optOut[k]; }
  }
  let done = 0;
  if (inv.lockable && (toLock.length || toUnlock.length)) {
    let failed = 0;
    for (const [list, on] of [[toUnlock, false], [toLock, true]]) {
      for (const e of list) {
        try {
          await setItemLock(e.id, e.fusion, on);
          e.locked = on;
          done++;
        } catch (err) {
          failed++;
          DM.log(`verrous : ${e.name} (${tierLabel(e.fusion || 0)}) ${on ? 'verrouillage' : 'déverrouillage'} refusé : ${err.message}`);
        }
        await sleep(250 + Math.random() * 300);
      }
    }
    DM.log(`verrous : ${toLock.filter((e) => e.locked).length} pile(s) verrouillée(s), ${toUnlock.filter((e) => !e.locked).length} déverrouillée(s)${failed ? `, ${failed} échec(s)` : ''}`);
  } else if (!inv.lockable && toLock.length) DM.log('verrous : cadenas du jeu indisponible sur ce compte, verrou de l’extension seulement (Autosell)');
  st.seen = inv.entries.filter((e) => e.locked).map((e) => stackKey(e.id, e.fusion));
  st.syncAt = Date.now();
  await save({ lockState: { ...(cfg.lockState || {}), [me]: st } });
  // grille de /inventaire à jour (seulement si aucune fiche d'objet n'est ouverte)
  if (reload && done && location.pathname.startsWith('/inventaire') && !document.querySelector('.title.leading-tight')) location.reload();
  return { want, locked: toLock.length, unlocked: toUnlock.length };
}

// Synchro différée et regroupée (clic en jeu sur un cadenas ou un équipement enregistré, liste de drops modifiée…).
function scheduleLockSync(ms = 2500) {
  clearTimeout(lockSyncTimer);
  lockSyncTimer = setTimeout(() => syncLocks({ reload: true }).catch((e) => DM.log(`verrous : ${e.message}`)), ms);
}

// Clics du joueur qui changent les cadenas ou ce qui est porté : cadenas, équipements enregistrés, (dés)équiper.
document.addEventListener('click', (e) => {
  if (dead || !/^\/(inventaire|personnage)/.test(location.pathname)) return;
  const b = e.target.closest('button');
  if (!b || [...b.classList].some((c) => c.startsWith('dm-'))) return;
  const txt = `${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.textContent || ''}`;
  if (/verrouill|cadenas|enregistr|[ée]quip|retirer|porter|charger/i.test(txt)) scheduleLockSync();
}, true);
