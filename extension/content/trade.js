// Autopilot-DM — content script : échange entre comptes via l’HDV, robustesse, file.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- Échange entre deux comptes via l'HDV ----------
// Compte A (onglet normal) et compte B (onglet en navigation privée, extension autorisée en privé) :
// le service worker est commun aux deux contextes, il relaie la demande à un onglet de l'autre contexte.
// « Échanger » : A met l'objet en vente à un petit prix aléatoire (11-49 K, listItem), B l'achète aussitôt (buyListing).
// Si l'achat échoue, A retire l'annonce (cancelListing) pour qu'un tiers ne l'achète pas.
// Prix de l'annonce d'échange : tiré au hasard entre 11 et 49 K pour chaque annonce (une annonce à 1 K se fait racheter
// par des tiers en une fraction de seconde) ; il est suivi exactement pour retrouver / retirer l'annonce.
const TRADE_PRICE_MIN = 11, TRADE_PRICE_MAX = 49;
const tradePrice = () => TRADE_PRICE_MIN + Math.floor(Math.random() * (TRADE_PRICE_MAX - TRADE_PRICE_MIN + 1));
const tradeListed = new Set();   // annonces d'échange de l'envoi en cours : « id|tier|prix » (filet de sécurité)
const HDV_ACTION_FALLBACK = {
  listItem: '702736ba6595110a5f795129bb67e1474296b9bbc3',      // (itemId, fusion, prix) → { ok } ou { error }
  buyListing: '4069e01f9c51baeb8173b67961698d890b954c0314',    // (listingId)
  cancelListing: '402e59a8dfed62e1ad851ba0dca9bf8630e6316b10', // (listingId)
};
const hdvActionIds = {};
let tradeBusy = false, myNameCache;

async function hdvAction(name, chunks) {
  if (!hdvActionIds[name]) hdvActionIds[name] = await findAction(chunks || (await fetchFlight('/hdv')).chunks, name, HDV_ACTION_FALLBACK[name]);
  return hdvActionIds[name];
}

// Server action de l'HDV. Si l'ID est périmé (nouveau déploiement : HTTP 404 ou réponse illisible), on le relit et on
// réessaie une fois. Jamais sur une erreur serveur (5xx, 508…) ni réseau : relire l'ID prend plusieurs secondes,
// pendant lesquelles une annonce d'échange resterait en vente.
async function hdvCall(name, args, query = '') {
  try {
    return await postAction('hdv', await hdvAction(name), args, query);
  } catch (e) {
    if (e.game || !(e.status === 404 || e.message === 'Réponse du serveur illisible')) throw e;
    delete hdvActionIds[name];
    hdvActionIds[name] = await findAction((await fetchFlight('/hdv')).chunks, name, HDV_ACTION_FALLBACK[name]);
    return postAction('hdv', hdvActionIds[name], args, query);
  }
}

// Nom du personnage connecté (« me » du payload RSC de la page).
function myName() {
  if (myNameCache) return myNameCache;
  for (const s of document.scripts) {
    for (const m of s.textContent.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
      let chunk;
      try { chunk = JSON.parse(m[1]); } catch { continue; }
      const n = chunk.match(/"me":\{"id":"[^"]*","name":("(?:[^"\\]|\\.)*")/);
      if (n) return (myNameCache = JSON.parse(n[1]));
    }
  }
  return null;
}

// Panneau de détails d'un objet (ItemDetails : titre « Nom · Tiers N », « Niveau N ») → { name, lvl, fusion }.
function itemFromPanel(panel) {
  const title = panel?.querySelector('.title.leading-tight');
  if (!title) return null;
  const name = [...title.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
  const tier = title.querySelector('span')?.textContent || '';
  const fusion = fusionOfLabel(tier);
  const lvl = +([...panel.querySelectorAll('span')].map((s) => s.textContent.match(/^Niveau (\d+)$/)).find(Boolean)?.[1] || 0);
  return name ? { name, lvl, fusion } : null;
}
const panelOf = (el) => {
  let p = el;
  while (p && !p.querySelector('.title.leading-tight')) p = p.parentElement;
  return p;
};

// Objets vendables (onglet « vendre » de l'HDV : sans les objets équipés, avec la date de fin de liaison).
// `tradable` : retire aussi les exemplaires « éternels » (gardés au Prestige, liés au compte à vie) et les objets
// verrouillés (cadenas du jeu). L'HDV les liste sans les marquer : le nombre d'éternels n'est lu que sur /inventaire.
async function fetchSellable({ tradable = false } = {}) {
  const [{ flight, chunks }, eternal] = await Promise.all([fetchFlight('/hdv?onglet=vendre'), tradable ? fetchEternal() : null]);
  const { rows, props } = rscProps(flight, (x) => Array.isArray(x.inventory) && Array.isArray(x.mine));
  if (!props) throw new Error('Inventaire de l’HDV introuvable');
  let entries = props.inventory.map((e) => {
    const item = rscResolve(rows, e.item) || {};
    return { id: item.id, name: item.n, lvl: item.lvl, slot: item.s, rarity: item.r, icon: item.icon, fusion: e.fusion, qty: e.qty, boundUntil: e.boundUntil, locked: !!e.locked };
  }).filter((e) => Number.isInteger(e.id));
  if (tradable) {
    entries = entries.map((e) => {
      const k = `${e.id}|${e.fusion || 0}`, n = Math.min(eternal.get(k) || 0, e.qty);
      eternal.set(k, (eternal.get(k) || 0) - n);   // plusieurs lignes pour le même objet : on ne retire qu'une fois
      return { ...e, qty: e.qty - n };
    }).filter((e) => e.qty > 0 && !e.locked);
  }
  return { entries, chunks, mine: props.mine, own: ownListings(rows, props.mine), maxListings: props.maxListings };
}

// Mes annonces (props « mine » de l'HDV), références RSC résolues : le jeu peut y mettre « $… » à la place de l'objet
// quand il apparaît déjà ailleurs dans la page → [{ id, price, fusion, itemId, name }].
function ownListings(rows, mine) {
  return (rscResolve(rows, mine) || []).map((raw) => {
    const l = rscResolve(rows, raw) || {};
    const it = rscResolve(rows, l.item) || {};
    return { id: +l.id, price: +l.price, fusion: +l.fusion || 0, itemId: it.id, name: it.n };
  }).filter((l) => l.id);
}

// Exemplaires « éternels » (objets gardés au Prestige, invendables) par « id|fusion », lus dans /inventaire.
async function fetchEternal() {
  const { flight } = await fetchFlight('/inventaire');
  const { rows, props } = rscProps(flight, (x) => Array.isArray(x.entries) && Array.isArray(x.slots));
  if (!props) throw new Error('Inventaire introuvable dans la page');
  const out = new Map();
  for (const e of props.entries) {
    if (!(+e.eternal > 0)) continue;
    const k = `${rscResolve(rows, e.item)?.id}|${e.fusion || 0}`;
    out.set(k, (out.get(k) || 0) + +e.eternal);
  }
  return out;
}

// ID de l'annonce d'échange qu'on vient de créer, lu dans la page renvoyée avec le résultat de listItem
// (annonces « mine » résolues ; sinon recherche dans le texte brut).
function findMyListing(text, itemId, fusion, price) {
  const { rows, props } = rscProps(text, (x) => Array.isArray(x.mine) && Array.isArray(x.inventory));
  const own = props ? ownListings(rows, props.mine).filter((l) => l.price === price && l.fusion === fusion && l.itemId === itemId) : [];
  if (own.length) return Math.max(...own.map((l) => l.id));
  let best = null;
  for (const m of text.matchAll(/\{"id":(\d+),"price":(\d+),"fusion":(\d+),"mine":true,"seller":"(?:[^"\\]|\\.)*","item":\{"id":(\d+)/g)) {
    if (+m[2] === price && +m[3] === fusion && +m[4] === itemId) best = Math.max(best || 0, +m[1]);
  }
  return best;
}

// Côté acheteur, si l'ID n'a pas pu être lu : annonce la plus récente de ce vendeur pour cet objet à ce prix.
async function findListingOnMarket({ itemId, fusion, seller, price }) {
  const { flight } = await fetchFlight('/hdv');
  const who = seller ? JSON.stringify(seller).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '"(?:[^"\\\\]|\\\\.)*"';
  const re = new RegExp(`\\{"id":(\\d+),"price":${+price || '\\d+'},"fusion":${+fusion},"mine":false,"seller":${who},"item":\\{"id":${+itemId}[,}]`, 'g');
  let best = null;
  for (const m of flight.matchAll(re)) best = Math.max(best || 0, +m[1]);
  return best;
}

// Vendeur, avant un ou plusieurs échanges : contact de l'autre compte + objets vendables + IDs des actions.
async function tradePrepare(say) {
  const peer = await peerReady(say);
  const sell = await fetchSellable({ tradable: true });
  if (sell.maxListings && sell.mine.length >= sell.maxListings) throw new Error(`HDV plein (${sell.mine.length}/${sell.maxListings} ventes en cours)`);
  await Promise.all([hdvAction('listItem', sell.chunks), hdvAction('cancelListing', sell.chunks)]);
  return { to: peer.name || 'l’autre compte', entries: sell.entries, maxListings: sell.maxListings || 0, listed: sell.mine.length };
}

// Objet vendable correspondant à { name, lvl, fusion } (non lié, quantité restante > 0).
function tradeResolve(ctx, it) {
  const matches = ctx.entries.filter((e) => e.name === it.name && (!it.lvl || e.lvl === it.lvl) && e.fusion === it.fusion);
  if (!matches.length) throw new Error(`${it.name} introuvable parmi les objets échangeables (équipé, éternel ou verrouillé ?)`);
  if (new Set(matches.map((e) => e.id)).size > 1) throw new Error(`Plusieurs objets s’appellent ${it.name} : échange annulé`);
  const free = matches.filter((e) => !e.boundUntil || new Date(e.boundUntil) <= Date.now());
  if (!free.length) throw new Error(`${it.name} est lié jusqu’au ${new Date(matches[0].boundUntil).toLocaleString('fr-FR')}`);
  const entry = free.find((e) => e.qty - (e.reserved || 0) > 0);
  if (!entry) throw new Error(`Plus d’exemplaire de ${it.name} à échanger`);
  return entry;
}

// ---------- Robustesse de l'échange ----------
// Une annonce d'échange ne doit jamais rester en vente si l'autre compte ne l'achète pas aussitôt :
// - avant chaque mise en vente, on vérifie que l'autre compte (session + serveur) répond, sinon on attend ;
// - l'achat doit être confirmé en BUY_WAIT_MS, sinon l'annonce est retirée sans attendre la réponse ;
// - après un échec technique (HTTP 5xx, onglet en rechargement…), l'objet est retenté une fois l'autre compte revenu.
const BUY_WAIT_MS = 2500;
const BUY_WAIT_SEARCH_MS = 8000;              // l'acheteur doit chercher l'annonce lui-même (ID non lu)
const TRADE_RETRIES = 4;                       // nouveaux essais d'un même exemplaire après un échec technique
const PEER_WAIT_MS = 3 * 60000;                // attente max que l'autre compte redevienne joignable
const PEER_RETRY_GAPS = [2000, 4000, 8000, 15000, 30000];
const CANCEL_TRIES = 6;
const TRADE_PARALLEL = 2;                      // « Tout échanger » : objets envoyés en même temps
const tradeErr = (message, extra) => Object.assign(new Error(message), extra);
const tradeStopped = () => !!queueRun?.stop;
// « Tout échanger » : problème qui concerne tout l'envoi (autre compte déconnecté / injoignable, plus de kamas, HDV plein,
// annonce peut-être perdue à retirer à la main…) → arrêt ; tout autre refus du jeu sur UN objet (lié, non échangeable,
// déjà acheté, vente disparue…) → objet sauté (annonce retirée si elle existe) et on passe aux suivants.
const TRADE_FATAL_RE = /kamas|plein|limite|maximum|d[ée]connect|injoignable|session|m[êe]me personnage|serveur/i;
const TRADE_MAX_LOST = 2;   // objets achetés par un autre joueur avant le retrait : au-delà, on arrête (prix surveillés ?)
const tradeItemProblem = (e) => !e.stopped && e.lost !== 'maybe' && !TRADE_FATAL_RE.test(`${e.message} ${e.why || ''}`)
  && (e.game || e.lost === true || e.retry === false);

// Attend que l'autre compte réponde (onglet joignable, session valide, serveur du jeu disponible).
// Un achat réussi il y a moins de PEER_FRESH_MS suffit : pas de nouvelle vérification avant chaque objet.
const PEER_FRESH_MS = 15000;
let peerOkAt = 0, peerInfo = null;
async function peerReady(say) {
  if (peerInfo && Date.now() - peerOkAt < PEER_FRESH_MS) return peerInfo;
  const t0 = Date.now();
  for (let i = 0; ; i++) {
    const p = await send({ type: 'tradePeer' }).catch((e) => ({ ok: false, error: e.message, retry: true }));
    if (p?.ok) {
      if (p.name && p.name === myName()) throw tradeErr('L’autre onglet est connecté au même personnage');
      peerInfo = p;
      peerOkAt = Date.now();
      return p;
    }
    if (p?.retry === false || Date.now() - t0 > PEER_WAIT_MS) throw tradeErr(p?.error || 'Autre compte injoignable');
    if (tradeStopped()) throw tradeErr('Arrêté', { stopped: true });
    const gap = PEER_RETRY_GAPS[Math.min(i, PEER_RETRY_GAPS.length - 1)];
    say(`⏳ Autre compte indisponible (${p?.error || 'sans réponse'}) — nouvel essai dans ${gap / 1000} s…`);
    await sleep(gap);
  }
}

// Retire l'annonce (avec plusieurs essais : tant qu'elle est en ligne, n'importe qui peut l'acheter).
// → { ok } | { gone } (déjà vendue / retirée) | { error }
// « gone » seulement si le jeu dit que la vente n'existe plus, ou si elle n'est plus dans mes annonces ; tout autre
// refus (« attends un peu »…) est retenté — avant, il était pris pour « achetée par un autre joueur ».
const GONE_RE = /n.existe plus|introuvable|plus en vente|déjà (été )?vendu|déjà (été )?achet/i;
const myTradeListing = (own, entry, price) => Math.max(0, ...own.filter((l) => l.price === price && l.itemId === entry.id && l.fusion === entry.fusion).map((l) => l.id)) || null;
async function cancelTradeListing(listingId, entry, price) {
  let id = listingId, last = null;
  for (let i = 0; i < CANCEL_TRIES; i++) {
    try {
      if (!id) id = myTradeListing((await fetchSellable()).own, entry, price);
      if (!id) return { gone: true, error: 'annonce plus en vente' };
      await hdvCall('cancelListing', [id], '?onglet=vendre');
      return { ok: true };
    } catch (e) {
      last = e;
      if (e.game && GONE_RE.test(e.message)) {
        // le jeu dit qu'elle n'existe plus : on vérifie dans mes annonces avant de le croire
        try {
          const still = myTradeListing((await fetchSellable()).own, entry, price);
          if (!still) return { gone: true, error: e.message };
          id = still;
        } catch { return { gone: true, error: e.message }; }
      } else if (!e.game) {
        id = id || null;
      }
      await sleep(400 + i * 400);
    }
  }
  return { error: last?.message || 'retrait impossible' };
}

// Filet de sécurité en fin d'envoi : retire mes annonces d'échange de cet envoi restées en vente (objet, tier et prix exacts :
// une vraie vente du même objet à un autre prix n'est pas touchée).
async function sweepTradeListings(say) {
  if (!tradeListed.size) return 0;
  let n = 0;
  try {
    const { own } = await fetchSellable();
    for (const l of own.filter((x) => tradeListed.has(`${x.itemId}|${x.fusion}|${x.price}`))) {
      try {
        await hdvCall('cancelListing', [l.id], '?onglet=vendre');
        n++;
        DM.log(`échange: annonce restée en vente retirée (${l.name}, annonce ${l.id})`);
      } catch (e) {
        DM.log(`échange: annonce restée en vente ${l.name} (${l.id}) : retrait impossible (${e.message})`);
      }
    }
  } catch (e) {
    DM.log(`échange: vérification des annonces restantes impossible (${e.message})`);
  }
  tradeListed.clear();
  if (n) say?.(`🧹 ${n} annonce(s) d’échange restée(s) en vente retirée(s).`);
  return n;
}

// Un exemplaire : mise en vente à 11-49 K puis achat par l'autre compte. last = dernier de la série (l'acheteur recharge sa page).
// Erreur avec retry = true : rien n'est perdu (annonce retirée ou jamais créée), on peut retenter.
async function tradeOne(ctx, entry, say, last = true) {
  await peerReady(say);
  const price = tradePrice();
  tradeListed.add(`${entry.id}|${entry.fusion}|${price}`);
  say(`${entry.name} : mise en vente à ${price} K…`);
  const t0 = performance.now();
  let text;
  try {
    ({ text } = await hdvCall('listItem', [entry.id, entry.fusion, price], '?onglet=vendre'));
  } catch (e) {
    if (e.game) throw e;   // refus du jeu (HDV plein…) : inutile de retenter
    // erreur technique : la vente a peut-être été créée quand même → on la retire si elle existe
    const c = await cancelTradeListing(null, entry, price);
    if (c.error && !c.gone) throw tradeErr(`${entry.name} : mise en vente incertaine (${e.message}) et retrait impossible (${c.error}) — vérifie tes ventes à l’HDV !`, { lost: 'maybe', why: e.message, cancel: c.error });
    throw tradeErr(`${entry.name} : mise en vente impossible (${e.message})`, { retry: true });
  }
  let listingId = findMyListing(text, entry.id, entry.fusion, price);
  if (!listingId) {
    // numéro d'annonce absent de la réponse : on relit mes ventes plutôt que de faire chercher l'acheteur à l'HDV (lent)
    try { listingId = myTradeListing((await fetchSellable()).own, entry, price); } catch { /* l'acheteur cherchera */ }
    DM.log(`échange: ${entry.name} : n° d'annonce absent de la réponse${listingId ? `, relu dans mes ventes (${listingId})` : ', introuvable dans mes ventes'}`);
  }
  say(`${entry.name} : achat par ${ctx.to}…`);
  const buyP = send({ type: 'tradeBuy', listingId, itemId: entry.id, fusion: entry.fusion, price, seller: myName(), last })
    .catch((e) => ({ ok: false, error: e.message, retry: true }));
  let r = await Promise.race([buyP, sleep(listingId ? BUY_WAIT_MS : BUY_WAIT_SEARCH_MS).then(() => null)]);
  const done = (res) => {
    entry.qty--;
    const ms = Math.round(performance.now() - t0);
    DM.log(`échange: ${entry.name} → ${ctx.to} (annonce ${res.listingId || listingId}, ${ms} ms)`);
    return ms;
  };
  if (r?.ok) { peerOkAt = Date.now(); return done(r); }

  // Échec, ou pas de confirmation à temps : on retire l'annonce tout de suite, sans attendre la réponse.
  peerOkAt = 0;   // l'autre compte a eu un souci : on le revérifiera avant le prochain objet
  say(`${entry.name} : achat ${r ? 'refusé' : 'trop lent'} — retrait de l’annonce…`);
  const tooSlow = !r;   // retirée avant la réponse : l'achat échouera sur « vente n'existe plus », ce n'est pas un vrai refus
  const c = await cancelTradeListing(listingId, entry, price);
  if (!r) r = await buyP;   // la réponse de l'acheteur finit par arriver
  if (r?.ok) return done(r);
  const why = r?.error || 'sans réponse';
  if (c.ok) {
    DM.log(`échange: ${entry.name} → ${ctx.to} raté (${why}), annonce retirée`);
    throw tradeErr(`${entry.name} : achat ${tooSlow ? 'trop lent' : `raté (${why})`} — annonce retirée`, { retry: tooSlow || r?.retry !== false });
  }
  // Annonce introuvable ou impossible à retirer : l'autre compte l'a-t-il finalement reçue ?
  const v = await send({ type: 'tradeVerify', itemId: entry.id, fusion: entry.fusion }).catch(() => null);
  if (v?.has) return done({ listingId });
  DM.log(`échange: PERTE possible ${entry.name} (achat : ${why} ; retrait : ${c.error})`);
  throw tradeErr(c.gone
    ? `⚠️ ${entry.name} a été acheté par un autre joueur avant le retrait (achat : ${why}).`
    : `⚠️ ${entry.name} : achat raté (${why}) et retrait impossible (${c.error}) — retire l’annonce à la main !`,
  { lost: c.gone ? true : 'maybe', why, cancel: c.error });
}

// tradeOne avec nouveaux essais après un échec technique (attend que l'autre compte soit revenu).
async function tradeWithRetry(ctx, entry, say, last = true, runId = Date.now()) {
  for (let attempt = 1; ; attempt++) {
    try {
      const ms = await tradeOne(ctx, entry, say, last);
      await recordTrade(runId, ctx, entry, 'ok', attempt > 1 ? `après ${attempt} essais` : '', ms);
      return ms;
    } catch (e) {
      if (!e.retry || attempt > TRADE_RETRIES || tradeStopped()) {
        if (!e.stopped) {
          const status = e.lost === true ? 'lost' : e.lost ? 'unsure' : 'failed';
          const detail = e.lost === true ? `achat de l’autre compte : ${e.why}`
            : e.lost ? `achat : ${e.why} ; retrait : ${e.cancel}`
            : e.message.replace(`${entry.name} : `, '') + (attempt > 1 ? ` — ${attempt} essais` : '');
          await recordTrade(runId, ctx, entry, status, detail);
        }
        throw e;
      }
      say(`${e.message} — nouvel essai ${attempt + 1}/${TRADE_RETRIES + 1}…`);
      await sleep(1500 * attempt);
    }
  }
}

// Bouton « Échanger » d'un panneau d'objet.
async function tradeItem(panel, say) {
  const it = itemFromPanel(panel);
  if (!it) throw new Error('Objet illisible');
  const ctx = await tradePrepare(say);
  const entry = tradeResolve(ctx, it);
  try {
    const ms = await tradeWithRetry(ctx, entry, say, true, Date.now());
    return `✔ ${it.name} → ${ctx.to} (${ms} ms)`;
  } catch (e) {
    await sweepTradeListings();
    throw e;
  }
}

// Acheteur : achète l'annonce relayée par le service worker.
// retry = false : refus du jeu (kamas, vente disparue…) ; sinon erreur technique, le vendeur pourra retenter.
let buyReloadTimer;
async function tradeBuy(msg) {
  clearTimeout(buyReloadTimer);
  try {
    const listingId = msg.listingId || await findListingOnMarket(msg);
    if (!listingId) throw tradeErr('annonce introuvable à l’HDV', { game: true });
    const { res } = await hdvCall('buyListing', [listingId]);
    tradeToast(`🔁 Objet reçu via l’HDV${msg.seller ? ` de ${msg.seller}` : ''}.`, 'ok');
    return { ok: true, listingId, text: res.ok };
  } catch (e) {
    tradeToast(`🔁 Échec de l’achat : ${e.message}`, 'err');
    return { ok: false, error: e.message, retry: !e.game };
  } finally {
    // Rafraîchit l'inventaire affiché, une fois la série terminée (ou 5 s sans nouvel achat).
    if (/^\/(hdv|inventaire)/.test(location.pathname) && !isOwner()) {
      buyReloadTimer = setTimeout(() => location.reload(), msg.last === false ? 5000 : 1200);
    }
  }
}

// Acheteur : le jeu et la session répondent-ils ? (requête légère, celle que le chat du site fait en continu)
async function tradeHealth() {
  try {
    const r = await DM.fetchT('/api/chat?after=999999999&g=0', { credentials: 'same-origin', cache: 'no-store' }, 8000);
    if (r.redirected && /connexion/.test(r.url)) return { ok: false, error: 'autre compte déconnecté', retry: true };
    if (!r.ok) return { ok: false, error: `serveur indisponible (HTTP ${r.status})`, retry: true };
  } catch (e) {
    return { ok: false, error: `serveur injoignable (${e.message})`, retry: true };
  }
  hdvAction('buyListing').catch(() => {});   // préchauffe l'ID de buyListing (une fois par page)
  return { ok: true, name: myName() };
}

// Acheteur : l'objet est-il arrivé dans l'inventaire ? (acheté à l'HDV = lié pendant ~24 h)
async function tradeVerify({ itemId, fusion }) {
  try {
    const { entries } = await fetchSellable();
    const soon = Date.now() + 23 * 3600000;
    return { has: entries.some((e) => e.id === itemId && e.fusion === fusion && e.boundUntil && new Date(e.boundUntil) > soon) };
  } catch (e) {
    return { has: false, error: e.message };
  }
}

let toastEl, toastTimer;
function tradeToast(text, cls, onClick = null) {
  if (!toastEl?.isConnected) {
    toastEl = document.createElement('div');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.onclick = onClick;
  toastEl.style.cssText = `cursor:${onClick ? 'pointer' : 'default'};position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:10px 16px;border-radius:10px;font:600 14px system-ui,sans-serif;color:#fff;box-shadow:0 4px 16px #0008;background:${cls === 'err' ? '#a8322a' : '#2e7d32'}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.remove(), 6000);
}

// ---------- File d'échange ----------
// Objets ajoutés depuis leur panneau (« ➕ File »), échangés ensuite d'un coup. Stockée par personnage
// (le stockage est commun aux deux comptes) : cfg.tradeQueues = { [nom]: [{ name, lvl, fusion, qty }] }.
let queueRun = null;   // { stop, done, total } pendant « Tout échanger »
const queueKey = () => myName() || '?';
const tradeQueue = () => cfg.tradeQueues?.[queueKey()] || [];
const sameItem = (a, b) => a.name === b.name && a.lvl === b.lvl && a.fusion === b.fusion;
const itemLabel = (it) => `${it.name}${it.fusion ? ` · ${fusionName(it.fusion)}` : ''}`;

function setTradeQueue(q) {
  return save({ tradeQueues: { ...(cfg.tradeQueues || {}), [queueKey()]: q.filter((it) => it.qty > 0) } });
}

function queueAdd(it) {
  const q = tradeQueue().map((x) => ({ ...x }));
  const cur = q.find((x) => sameItem(x, it));
  if (cur) cur.qty++; else q.push({ ...it, qty: 1 });
  setTradeQueue(q);
  return cur ? cur.qty : 1;
}

async function runQueue() {
  if (tradeBusy || !tradeQueue().length) return;
  tradeBusy = true;
  const runId = Date.now();
  queueRun = { stop: false, done: 0, total: tradeQueue().reduce((n, it) => n + it.qty, 0), id: runId };
  const say = (t, cls) => queueMsg(t, cls);
  let ok = false;
  const skipped = [];
  let lostCount = 0;
  try {
    const ctx = await tradePrepare(say);
    await setLastRun({ id: runId, to: ctx.to });
    let ms = 0, fatal = null;
    tradeListed.clear();   // annonces de cet envoi (filet de sécurité en fin d'envoi)
    // Envoi en parallèle : un objet est mis en vente pendant que l'autre compte achète le précédent.
    // Jamais deux exemplaires du même objet en même temps : l'ID de l'annonce est retrouvé par objet + tier.
    const room = ctx.maxListings ? ctx.maxListings - ctx.listed : TRADE_PARALLEL;
    const workers = Math.max(1, Math.min(TRADE_PARALLEL, room));
    const inFlight = new Map();   // clé d'objet → exemplaires en cours
    const keyOf = (it) => `${it.name}|${it.lvl}|${it.fusion}`;
    const nextJob = () => tradeQueue().find((it) => !inFlight.has(keyOf(it)) && it.qty - (inFlight.get(keyOf(it)) || 0) > 0);
    const worker = async (w) => {
      if (w) await sleep(150 + Math.random() * 200);   // décalage du 2e envoi
      while (!queueRun.stop && !fatal) {
        const it = nextJob();
        if (!it) {
          if (!inFlight.size) return;
          await sleep(100);   // un autre objet est en cours : on attend qu'il libère sa place
          continue;
        }
        const k = keyOf(it);
        inFlight.set(k, (inFlight.get(k) || 0) + 1);   // réservé avant toute attente : l'autre envoi ne le prend pas
        let entry;
        try {
          entry = tradeResolve(ctx, it);
        } catch (e) {
          // Objet introuvable / lié / plus assez d'exemplaires : on le sort de la file et on passe au suivant.
          skipped.push(e.message);
          await recordTrade(runId, ctx, it, 'skipped', e.message.replace(`${it.name} `, ''), null, it.qty);
          queueRun.total -= it.qty;
          await setTradeQueue(tradeQueue().filter((x) => !sameItem(x, it)));
          inFlight.delete(k);
          continue;
        }
        entry.reserved = (entry.reserved || 0) + 1;
        const n = queueRun.done + inFlight.size;
        try {
          // last = false : l'acheteur rafraîchit sa page après 5 s sans achat (un autre envoi peut être en cours)
          ms += await tradeWithRetry(ctx, entry, (t) => say(`${Math.min(n, queueRun.total)}/${queueRun.total} · ${t}`), workers === 1 && queueRun.done + 1 >= queueRun.total, runId);
          queueRun.done++;
          await setTradeQueue(tradeQueue().map((x) => (sameItem(x, it) ? { ...x, qty: x.qty - 1 } : x)));
          renderQueue();
        } catch (e) {
          if (tradeItemProblem(e) && (e.lost !== true || ++lostCount < TRADE_MAX_LOST)) {
            // problème propre à cet objet : on le sort de la file (tous ses exemplaires) et on passe aux suivants
            skipped.push(`${it.name} : ${e.message.replace(`${it.name} : `, '')}`);
            const rest = tradeQueue().find((x) => sameItem(x, it))?.qty || 0;
            queueRun.total -= rest;
            await setTradeQueue(tradeQueue().filter((x) => !sameItem(x, it)));
            DM.log(`échange: ${it.name} sauté (${e.message}), ${rest} exemplaire(s) retiré(s) de la file`);
            say(`⏭️ ${it.name} sauté : ${e.message.replace(`${it.name} : `, '')}`, 'err');
            renderQueue();
          } else {
            fatal ||= e;   // l'autre envoi termine son objet, puis on s'arrête
          }
        } finally {
          entry.reserved--;
          const left = inFlight.get(k) - 1;
          if (left > 0) inFlight.set(k, left); else inFlight.delete(k);
        }
        await sleep(80 + Math.random() * 170);
      }
    };
    await Promise.all(Array.from({ length: workers }, (_, w) => worker(w)));
    await sweepTradeListings((t) => skipped.push(t));
    if (fatal) throw fatal;
    ok = true;
    const avg = queueRun.done ? Math.round((Date.now() - runId) / queueRun.done) : 0;   // débit réel (envois en parallèle)
    say((queueRun.stop && tradeQueue().length
      ? `⏸ Arrêté : ${queueRun.done} objet(s) envoyé(s) à ${ctx.to} — le reste est toujours dans la file.`
      : `✔ Terminé${queueRun.done ? ` (~${avg} ms par objet)` : ''}.`)
      + (skipped.length ? ` ${skipped.length} objet(s) sauté(s) : ${skipped.join(' · ')}` : ''), skipped.length ? '' : 'ok');
  } catch (e) {
    say(`❌ Envoi interrompu : ${e.message}${tradeQueue().length ? ' — le reste est toujours dans la file.' : ''}`
      + (skipped.length ? ` (${skipped.length} objet(s) sauté(s) avant : ${skipped.join(' · ')})` : ''), 'err');
  } finally {
    const done = queueRun.done;
    tradeBusy = false;
    queueRun = null;
    renderQueue();
    // le récap (stocké) reste affiché après le rechargement de la page
    if (ok && done && !skipped.length && /^\/(hdv|inventaire)/.test(location.pathname)) setTimeout(() => location.reload(), 2000);
  }
}
