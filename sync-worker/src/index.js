// Autopilot-DM — synchro des mesures de « Rentabilité des zones » entre joueurs (Worker Cloudflare + D1).
// Chaque combat de chasse gagné est envoyé une fois (clé unique : personnage + horodatage) ; chacun récupère ceux des
// autres depuis son dernier curseur (seq). Accès : clé partagée (secret SYNC_KEY) dans l'en-tête Authorization.
//   POST /fights  { player, fights: [rec…] }  → { ok, added }
//   GET  /fights?since=<seq>                  → { fights: [{ p, r }], next }
//   POST /combats { player, combat: rec }     → { ok, added }  combat complet (stats, build, journal) pour l'analyse des dégâts
//   GET  /combats?since=<seq>&limit=<n>&full=1 → { combats: [{ seq, p, at, kind, status, r? }], next }  (r seulement avec full=1)
//   GET  /health                              → ok (sans clé)

const PAGE = 1000;          // combats renvoyés au plus par requête
const PUSH_MAX = 500;       // combats acceptés au plus par envoi
const REC_MAX = 4096;       // taille max d'un combat (JSON)
const PLAYER_RE = /^[^\u0000-\u001f]{1,64}$/;

let ready = false;
async function init(db) {
  if (ready) return;
  await db.exec('CREATE TABLE IF NOT EXISTS fights (seq INTEGER PRIMARY KEY AUTOINCREMENT, player TEXT NOT NULL, at INTEGER NOT NULL, rec TEXT NOT NULL, UNIQUE(player, at))');
  await db.exec('CREATE TABLE IF NOT EXISTS combats (seq INTEGER PRIMARY KEY AUTOINCREMENT, player TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT, status TEXT, rec TEXT NOT NULL, UNIQUE(player, id))');
  ready = true;
}

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

function authorized(req, key) {
  const got = new TextEncoder().encode((req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''));
  const want = new TextEncoder().encode(key || '');
  return want.byteLength > 0 && got.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(got, want);
}

async function push(req, db) {
  const body = await req.json().catch(() => null);
  const player = typeof body?.player === 'string' ? body.player.trim() : '';
  if (!PLAYER_RE.test(player) || !Array.isArray(body.fights)) return json({ error: 'player / fights attendus' }, 400);
  if (body.fights.length > PUSH_MAX) return json({ error: `${PUSH_MAX} combats au plus par envoi` }, 413);
  const stmt = db.prepare('INSERT OR IGNORE INTO fights (player, at, rec) VALUES (?, ?, ?)');
  const rows = [];
  for (const r of body.fights) {
    const at = Number(r?.at);
    const rec = JSON.stringify(r);
    if (!Number.isSafeInteger(at) || !Array.isArray(r.m) || rec.length > REC_MAX) continue;
    rows.push(stmt.bind(player, at, rec));
  }
  if (!rows.length) return json({ ok: true, added: 0 });
  const res = await db.batch(rows);
  return json({ ok: true, added: res.reduce((s, x) => s + (x.meta?.changes || 0), 0) });
}

async function pull(url, db) {
  const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
  const { results } = await db.prepare('SELECT seq, player, rec FROM fights WHERE seq > ? ORDER BY seq LIMIT ?').bind(since, PAGE).all();
  return json({ fights: results.map((x) => ({ p: x.player, r: JSON.parse(x.rec) })), next: results.length ? results[results.length - 1].seq : since });
}

const COMBAT_MAX = 1500000;   // taille max d'un combat (JSON) ; D1 accepte 2 Mo par valeur
async function pushCombat(req, db) {
  const body = await req.json().catch(() => null);
  const player = typeof body?.player === 'string' ? body.player.trim() : '';
  const c = body?.combat;
  const rec = JSON.stringify(c ?? null);
  if (!PLAYER_RE.test(player) || typeof c?.id !== 'string' || !/^[0-9a-z]{1,16}$/.test(c.id) || !Number.isSafeInteger(Number(c.at)) || !c.state) {
    return json({ error: 'player / combat { id, at, state } attendus' }, 400);
  }
  if (rec.length > COMBAT_MAX) return json({ error: 'combat trop gros' }, 413);
  const res = await db.prepare('INSERT OR IGNORE INTO combats (player, id, at, kind, status, rec) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(player, c.id, Number(c.at), String(c.kind ?? ''), String(c.status ?? ''), rec).run();
  return json({ ok: true, added: res.meta?.changes || 0 });
}

async function pullCombats(url, db) {
  const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
  const full = url.searchParams.get('full') === '1';
  const limit = Math.min(full ? 20 : 500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
  const { results } = await db.prepare(`SELECT seq, player, at, kind, status${full ? ', rec' : ''} FROM combats WHERE seq > ? ORDER BY seq LIMIT ?`)
    .bind(since, limit).all();
  return json({ combats: results.map((x) => ({ seq: x.seq, p: x.player, at: x.at, kind: x.kind, status: x.status, ...(full ? { r: JSON.parse(x.rec) } : {}) })),
    next: results.length ? results[results.length - 1].seq : since });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname !== '/fights' && url.pathname !== '/combats') return json({ error: 'introuvable' }, 404);
    if (!authorized(req, env.SYNC_KEY)) return json({ error: 'clé invalide' }, 401);
    await init(env.DB);
    if (url.pathname === '/combats') {
      if (req.method === 'POST') return pushCombat(req, env.DB);
      if (req.method === 'GET') return pullCombats(url, env.DB);
      return json({ error: 'méthode non gérée' }, 405);
    }
    if (req.method === 'POST') return push(req, env.DB);
    if (req.method === 'GET') return pull(url, env.DB);
    return json({ error: 'méthode non gérée' }, 405);
  },
};
