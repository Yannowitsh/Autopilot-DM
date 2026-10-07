// Autopilot-DM — content script : historique des échanges + sélecteur multiple.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- Historique des échanges + récap de la dernière file ----------
// cfg.tradeHistory : une ligne par exemplaire tenté (ou objet sauté), regroupées par envoi (run = horodatage du début).
// cfg.tradeLastRun[personnage] : dernier envoi de la file, dont le récap reste affiché (même après rechargement) jusqu'à ✕.
const HISTORY_MAX = 1000;
const TRADE_STATUS = {
  ok: { icon: '✔', label: 'envoyé(s)', color: '#6cc070' },
  lost: { icon: '❌', label: 'perdu(s) — acheté(s) par un autre joueur', color: '#e0675c' },
  unsure: { icon: '⚠️', label: 'à vérifier — annonce peut-être encore en vente', color: '#e2b04a' },
  failed: { icon: '⛔', label: 'non envoyé(s) — toujours dans ton inventaire', color: '#e0975c' },
  skipped: { icon: '⏭', label: 'sauté(s)', color: '#9aa0a8' },
};
const STATUS_ORDER = ['lost', 'unsure', 'failed', 'skipped', 'ok'];

function recordTrade(runId, ctx, item, status, detail = '', ms = null, qty = 1) {
  const line = { at: Date.now(), run: runId, seller: myName(), to: ctx?.to || null,
    name: item.name, lvl: item.lvl, fusion: item.fusion, qty, status, detail, ms };
  return save({ tradeHistory: [...(cfg.tradeHistory || []), line].slice(-HISTORY_MAX) });
}
const setLastRun = (run) => save({ tradeLastRun: { ...(cfg.tradeLastRun || {}), [queueKey()]: run } });

// Lignes d'un envoi regroupées par statut puis par objet : { ok: [{ label, n, detail }], lost: […], … }
function runGroups(rows) {
  const out = {};
  for (const h of rows) {
    const g = (out[h.status] ||= new Map());
    const label = itemLabel(h);
    const cur = g.get(label) || { label, n: 0, detail: h.detail };
    cur.n += h.qty || 1;
    g.set(label, cur);
  }
  for (const k in out) out[k] = [...out[k].values()];
  return out;
}
const countOf = (groups, st) => (groups[st] || []).reduce((n, x) => n + x.n, 0);
const itemsText = (arr, withDetail) => arr.map((x) => `${x.label}${x.n > 1 ? ` ×${x.n}` : ''}${withDetail && x.detail ? ` (${x.detail})` : ''}`);

// Récap HTML d'un envoi (panneau de la file et fenêtre d'historique).
function recapHtml(rows, esc, { full = false } = {}) {
  const groups = runGroups(rows);
  return STATUS_ORDER.filter((st) => groups[st]?.length).map((st) => {
    const s = TRADE_STATUS[st];
    const n = countOf(groups, st);
    const detail = st !== 'ok';   // la raison n'est utile que pour ce qui n'est pas parti
    const items = itemsText(groups[st], detail);
    const shown = full || st !== 'ok' ? items : items.slice(0, 6).concat(items.length > 6 ? [`+ ${items.length - 6} autre(s)`] : []);
    return `<div style="color:${s.color}"><b>${s.icon} ${n} ${s.label}</b>${shown.length ? `<div style="color:#ccc;font-size:12px;margin:1px 0 3px 18px">${shown.map(esc).join('<br>')}</div>` : ''}</div>`;
  }).join('');
}

// Message court de fin d'envoi.
function runShort(rows) {
  const g = runGroups(rows);
  const parts = STATUS_ORDER.slice().reverse().filter((st) => countOf(g, st)).map((st) => `${TRADE_STATUS[st].icon} ${countOf(g, st)}`);
  return parts.length ? `Terminé : ${parts.join(' · ')}` : '';
}

// Fenêtre « 🕘 Historique des échanges » : envois du plus récent au plus ancien, filtrables.
function openHistory() {
  document.querySelector('.dm-history')?.remove();
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:6px 12px;color:#fff;cursor:pointer;font:600 13px system-ui,sans-serif';
  const ov = document.createElement('div');
  ov.className = 'dm-history dm-picker';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:#000a;display:grid;justify-items:center;align-items:start;padding:4vh 16px 16px;font:13px system-ui,sans-serif;color:#eee';
  ov.innerHTML = `
    <div style="width:min(680px,100%);max-height:88vh;display:flex;flex-direction:column;gap:10px;background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:14px;box-shadow:0 10px 40px #000">
      <div style="display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:15px">🕘 Historique des échanges${DM.tip('Chaque envoi (bouton « Échanger » ou file) avec ce qui est parti, ce qui a été perdu, ce qui n’a pas pu partir et pourquoi. Gardé dans Chrome (1000 dernières lignes), commun à tes deux comptes.')}</b><button data-a="x" style="${btn};background:transparent">✕</button></div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <select data-k="filter" style="background:#2a231a;border:1px solid #5a4a33;border-radius:8px;color:#eee;padding:5px 8px">
          <option value="">Tous les envois</option>
          <option value="problems">Seulement ceux avec pertes / échecs</option>
        </select>
        <span data-k="count" style="flex:1;color:#bbb"></span>
        <button data-a="clear" style="${btn};background:transparent">🗑 Vider</button>
      </div>
      <div data-k="list" style="overflow:auto;flex:1;min-height:120px;display:flex;flex-direction:column;gap:8px"></div>
    </div>`;
  document.body.appendChild(ov);
  const $ = (s) => ov.querySelector(s);
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  ov.addEventListener('keydown', (e) => e.stopPropagation());
  let clearArmed = false;

  function render() {
    const runs = new Map();
    for (const h of cfg.tradeHistory || []) (runs.get(h.run) || runs.set(h.run, []).get(h.run)).push(h);
    let list = [...runs.entries()].sort((a, b) => b[0] - a[0]);
    if ($('[data-k="filter"]').value === 'problems') list = list.filter(([, rows]) => rows.some((h) => h.status !== 'ok'));
    $('[data-k="count"]').textContent = `${list.length} envoi(s)`;
    $('[data-k="list"]').innerHTML = list.map(([run, rows]) => {
      const first = rows[0];
      const when = new Date(run).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      return `<details style="border:1px solid #3a3125;border-radius:10px;padding:8px 10px" ${rows.some((h) => h.status === 'lost' || h.status === 'unsure') ? 'open' : ''}>
        <summary style="cursor:pointer"><b>${esc(when)}</b> · ${esc(first.seller || '?')} → ${esc(first.to || '?')} · <span style="color:#bbb">${esc(runShort(rows).replace('Terminé : ', ''))}</span></summary>
        <div style="margin-top:6px;display:flex;flex-direction:column;gap:2px">${recapHtml(rows, esc, { full: true })}</div>
      </details>`;
    }).join('') || '<div style="padding:12px;color:#999;text-align:center">Aucun échange enregistré.</div>';
  }
  ov.addEventListener('click', async (e) => {
    if (e.target === ov) return close();
    const a = e.target.closest('button[data-a]')?.dataset.a;
    if (a === 'x') close();
    else if (a === 'clear') {
      if (!clearArmed) { clearArmed = true; e.target.textContent = '⚠️ Confirmer'; setTimeout(() => { clearArmed = false; if (ov.isConnected) e.target.textContent = '🗑 Vider'; }, 4000); return; }
      await save({ tradeHistory: [], tradeLastRun: {} });
      render();
    }
  });
  $('[data-k="filter"]').addEventListener('change', render);
  render();
}

// Panneau flottant (en haut à droite) sur /hdv et /inventaire tant que la file n'est pas vide.
let queueBox = null, queueMsgText = '', queueMsgCls = '';
let queueFolded = (() => { try { return localStorage.getItem('dmTradeQueueFolded') === '1'; } catch { return false; } })();
function queueMsg(t, cls = '') {
  queueMsgText = t;
  queueMsgCls = cls;
  renderQueue();
}

function renderQueue() {
  if (dead) return;
  const q = tradeQueue();
  if (!/^\/(hdv|inventaire)/.test(location.pathname)) { queueBox?.remove(); queueBox = null; return; }
  if (!queueBox?.isConnected) {
    queueBox = document.createElement('div');
    queueBox.className = 'dm-queue';
    queueBox.style.cssText = 'position:fixed;top:72px;right:12px;z-index:2147483000;width:290px;max-width:calc(100vw - 24px);max-height:70vh;display:flex;flex-direction:column;gap:6px;padding:10px;border-radius:12px;background:#1d1812f2;border:1px solid #5a4a33;color:#eee;font:13px system-ui,sans-serif;box-shadow:0 6px 24px #000a';
    queueBox.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      if (b.dataset.act === 'run') runQueue();
      else if (b.dataset.act === 'stop' && queueRun) { queueRun.stop = true; queueMsg('Arrêt après l’objet en cours…'); }
      else if (b.dataset.act === 'clear' && !tradeBusy) { queueMsgText = ''; setTradeQueue([]); }
      else if (b.dataset.act === 'pick' && !tradeBusy) openPicker();
      else if (b.dataset.act === 'history') openHistory();
      else if (b.dataset.act === 'recapClose') { const lr = cfg.tradeLastRun?.[queueKey()]; if (lr) setLastRun({ ...lr, dismissed: true }); }
      else if (b.dataset.act === 'fold') {
        queueFolded = !queueFolded;
        try { localStorage.setItem('dmTradeQueueFolded', queueFolded ? '1' : '0'); } catch { /* stockage indisponible */ }
        renderQueue();
      }
      else if (b.dataset.rm != null && !tradeBusy) setTradeQueue(q.filter((_, i) => i !== +b.dataset.rm));
    });
    document.body.appendChild(queueBox);
  }
  const total = q.reduce((n, it) => n + it.qty, 0);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:4px 10px;color:#fff;cursor:pointer;font:600 12px system-ui,sans-serif';
  const color = queueMsgCls === 'err' ? '#e0675c' : queueMsgCls === 'ok' ? '#6cc070' : '#bbb';
  // récap du dernier envoi de la file (jusqu'à ✕), affiché sous la file
  const lr = cfg.tradeLastRun?.[queueKey()];
  const lrRows = lr && !lr.dismissed && !queueRun ? (cfg.tradeHistory || []).filter((h) => h.run === lr.id) : [];
  const recap = lrRows.length ? `<div style="border-top:1px solid #3a3125;padding-top:6px;display:flex;flex-direction:column;gap:2px;overflow:auto">
      <div style="display:flex;align-items:center;gap:6px"><b style="flex:1">📊 Récap ${esc(new Date(lr.id).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }))} → ${esc(lr.to || '?')}</b>
        <button data-act="history" style="${btn};padding:2px 7px;background:transparent">Détails</button>
        <button data-act="recapClose" title="Masquer le récap" style="${btn};padding:2px 7px;background:transparent">✕</button></div>
      ${recapHtml(lrRows, esc)}</div>` : '';
  const head = `<div style="display:flex;align-items:center;gap:6px"><b style="flex:1">🔁 File d’échange (${total})${DM.tip("Objets à envoyer à ton autre compte (connecté en navigation privée ou normale). « Tout échanger » met chaque exemplaire en vente à 11-49 kamas et le fait acheter aussitôt par l’autre compte. File propre à chaque personnage.")}</b>
      <button data-act="pick" data-tip="Ouvre la liste de tous tes objets vendables, avec filtres (nom, rareté, emplacement, niveau) et cases à cocher, pour remplir la file d’un coup." style="${btn};background:#5a4a33" ${tradeBusy ? 'disabled' : ''}>📋 Sélection</button>
      <button data-act="history" data-tip="Historique de tous les échanges : objets envoyés, perdus, non envoyés et pourquoi." style="${btn};padding:4px 7px;background:transparent">🕘</button>
      <button data-act="fold" title="${queueFolded ? 'Déplier' : 'Replier'}" style="${btn};padding:4px 7px;background:transparent">${queueFolded ? '▾' : '▴'}</button></div>`;
  const html = queueFolded && !queueRun ? head : `
    ${head}
    <ul style="list-style:none;margin:0;padding:0;overflow:auto;display:flex;flex-direction:column;gap:2px">
      ${q.map((it, i) => `<li style="display:flex;align-items:center;gap:6px"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(itemLabel(it))} (niv. ${it.lvl})">${esc(itemLabel(it))}</span>${it.qty > 1 ? `<b>×${it.qty}</b>` : ''}<button data-rm="${i}" title="Retirer de la file" style="${btn};padding:0 6px;background:transparent" ${tradeBusy ? 'disabled' : ''}>✕</button></li>`).join('') || '<li style="color:#999">Vide : 📋 Sélection, ou « ➕ File » sur un objet.</li>'}
    </ul>
    <div style="display:flex;gap:6px">${queueRun
      ? `<button data-act="stop" style="${btn};flex:1;background:#8a2b2b">⏸ Arrêter (${queueRun.done}/${queueRun.total})</button>`
      : q.length ? `<button data-act="run" style="${btn};flex:1;background:#2b5d8a">🔁 Tout échanger</button><button data-act="clear" style="${btn};background:transparent">Vider</button>` : ''}</div>
    <div style="color:${color};font-size:12px;min-height:1em">${esc(queueMsgText)}</div>
    ${recap}`;
  if (queueBox.dmHtml !== html) { queueBox.dmHtml = html; queueBox.innerHTML = html; }
}

// ---------- Sélecteur multiple : tous les objets vendables, filtres, cases à cocher ----------
// Le résultat remplace la file (les objets déjà en file arrivent pré-cochés avec leur quantité).
const SLOT_NAMES = { amulette: 'Amulette', chapeau: 'Chapeau', cape: 'Cape', ceinture: 'Ceinture', bottes: 'Bottes', anneau: 'Anneau', arme: 'Arme', bouclier: 'Bouclier', familier: 'Familier', dofus: 'Dofus / Trophée' };
const PICK_FILTERS_KEY = 'dmTradePickFilters';

async function openPicker() {
  document.querySelector('.dm-picker')?.remove();
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const ov = document.createElement('div');
  ov.className = 'dm-picker';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:#000a;display:grid;justify-items:center;align-items:start;padding:4vh 16px 16px;font:13px system-ui,sans-serif;color:#eee';
  ov.innerHTML = '<div style="background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:16px">Chargement des objets…</div>';
  document.body.appendChild(ov);
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', (e) => e.stopPropagation());   // pas de raccourcis du jeu pendant la saisie

  let entries;
  try {
    entries = (await fetchSellable({ tradable: true })).entries;
  } catch (e) {
    ov.firstElementChild.textContent = `❌ ${e.message}`;
    return;
  }
  const now = Date.now();
  const rows = entries.map((e, i) => ({
    ...e, key: i,
    bound: !!e.boundUntil && new Date(e.boundUntil) > now,
    locked: !!cfg.lockedItems?.[DM.lockKey(e.name, e.lvl)],
  })).sort((a, b) => b.rarity - a.rarity || b.lvl - a.lvl || a.name.localeCompare(b.name) || a.fusion - b.fusion);

  // sélection : key → quantité ; pré-remplie avec la file actuelle
  const sel = new Map();
  for (const it of tradeQueue()) {
    const r = rows.find((x) => !x.bound && sameItem(x, it));
    if (r) sel.set(r.key, Math.min(it.qty, r.qty));
  }

  const NO_FILTERS = { q: '', rarity: '', slot: '', tier: '', min: '', max: '', hideBound: true, hideLocked: true };
  // filtre de fusion : '' tous · radiant = Rayonnants (tier max) · fused = fusionnés (Tiers 2 et +) · base = sans fusion · notRadiant
  const TIER_FILTERS = {
    radiant: (fu) => fu >= FUSION_MAX,
    fused: (fu) => fu > 0,
    base: (fu) => !fu,
    notRadiant: (fu) => fu < FUSION_MAX,
  };
  let f = { ...NO_FILTERS };
  try { f = { ...f, ...JSON.parse(localStorage.getItem(PICK_FILTERS_KEY) || '{}'), q: '' }; } catch { /* stockage indisponible */ }
  const slots = [...new Set(rows.map((r) => r.slot))].filter(Boolean).sort();
  const inp = 'background:#2a231a;border:1px solid #5a4a33;border-radius:8px;color:#eee;padding:5px 8px;font:13px system-ui,sans-serif';
  const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:6px 12px;color:#fff;cursor:pointer;font:600 13px system-ui,sans-serif';
  ov.innerHTML = `
    <div style="width:min(760px,100%);max-height:88vh;display:flex;flex-direction:column;gap:10px;background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:14px;box-shadow:0 10px 40px #000">
      <div style="display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:15px">📋 Sélection d’objets à échanger${DM.tip("Tous tes objets échangeables : les objets équipés, éternels (gardés au Prestige, liés au compte) et verrouillés n’apparaissent pas, les objets liés (achetés il y a moins de 24 h) ne peuvent pas être cochés. Coche ceux à envoyer ; Maj + clic coche une plage ; pour un objet en plusieurs exemplaires, choisis la quantité à droite.")}</b><button data-a="x" style="${btn};background:transparent">✕</button></div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
        <input data-f="q" placeholder="Rechercher un nom…" style="${inp};flex:1;min-width:150px">
        <select data-f="rarity" style="${inp}"><option value="">Toutes raretés</option>${DM.RARITIES.map((r, i) => `<option value="${i}">${r}</option>`).join('')}</select>
        <select data-f="slot" style="${inp}"><option value="">Tous emplacements</option>${slots.map((s) => `<option value="${s}">${esc(SLOT_NAMES[s] || s)}</option>`).join('')}</select>
        <select data-f="tier" style="${inp}" data-tip="Filtrer selon le tier de fusion : Rayonnants (tier maximum ★), objets fusionnés (Tiers 2 et plus), objets sans fusion, ou tout sauf les Rayonnants.">
          <option value="">Tous tiers</option>
          <option value="radiant">★ Rayonnants (${rows.filter((r) => r.fusion >= FUSION_MAX).length})</option>
          <option value="fused">Fusionnés (Tiers 2+)</option>
          <option value="base">Sans fusion</option>
          <option value="notRadiant">Hors Rayonnants</option>
        </select>
        <input data-f="min" type="number" min="1" placeholder="Niv. min" style="${inp};width:80px">
        <input data-f="max" type="number" min="1" placeholder="Niv. max" style="${inp};width:80px">
        <label style="white-space:nowrap"><input data-f="hideBound" type="checkbox"> masquer liés${DM.tip("Cache les objets achetés à l’HDV il y a moins de 24 h : ils te sont liés et ne peuvent pas encore être revendus ni échangés.")}</label>
        <label style="white-space:nowrap"><input data-f="hideLocked" type="checkbox"> masquer 🔒${DM.tip("Cache les objets que tu as verrouillés contre l’Autosell.")}</label>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <button data-a="all" style="${btn};background:#3a3125" data-tip="Coche tous les objets visibles avec les filtres actuels (tous leurs exemplaires). Combine avec les filtres pour sélectionner en masse.">☑ Cocher les objets affichés</button>
        <button data-a="none" style="${btn};background:transparent">☐ Tout décocher</button>
        <button data-a="reset" style="${btn};background:transparent" data-tip="Remet tous les filtres à zéro (recherche, rareté, emplacement, niveaux) pour réafficher tous tes objets.">↺ Filtres</button>
        <span data-k="count" style="flex:1;text-align:right;color:#bbb"></span>
      </div>
      <ul data-k="list" style="list-style:none;margin:0;padding:0;overflow:auto;flex:1;min-height:120px;border:1px solid #3a3125;border-radius:10px"></ul>
      <div style="font-size:11px;color:#999">Astuce : Maj + clic coche/décoche toute la plage depuis la dernière case cliquée.</div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button data-a="x" style="${btn};background:transparent">Annuler</button>
        <button data-a="save" style="${btn};background:#5a4a33" data-tip="Remplace la file d’échange par cette sélection, sans rien envoyer.">➕ Mettre en file</button>
        <button data-a="go" style="${btn};background:#2b5d8a" data-tip="Met la sélection en file et lance tout de suite l’envoi vers ton autre compte.">🔁 Échanger maintenant</button>
      </div>
    </div>`;
  const $ = (s) => ov.querySelector(s);
  const list = $('[data-k="list"]');
  const saveFilters = () => { try { localStorage.setItem(PICK_FILTERS_KEY, JSON.stringify(f)); } catch { /* stockage indisponible */ } };
  // Affiche `f` dans les champs, puis relit les champs : un filtre mémorisé qui n'existe plus dans la liste
  // (ex. emplacement « Dofus » alors qu'il n'y a plus de Dofus) retombe sur « Tous » au lieu de tout cacher en silence.
  const syncFilters = () => {
    for (const el of ov.querySelectorAll('[data-f]')) {
      const k = el.dataset.f;
      if (el.type === 'checkbox') el.checked = !!f[k]; else el.value = f[k] ?? '';
      f[k] = el.type === 'checkbox' ? el.checked : el.value;
    }
    saveFilters();
  };
  for (const el of ov.querySelectorAll('[data-f]')) {
    el.addEventListener('input', () => {
      f[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value;
      saveFilters();
      renderList();
    });
  }
  syncFilters();

  let visible = [], lastIdx = null;
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  function filtered() {
    const q = norm(f.q.trim());
    return rows.filter((r) => (!q || norm(r.name).includes(q))
      && (f.rarity === '' || r.rarity === +f.rarity)
      && (!f.slot || r.slot === f.slot)
      && (!TIER_FILTERS[f.tier] || TIER_FILTERS[f.tier](r.fusion))
      && (!f.min || r.lvl >= +f.min) && (!f.max || r.lvl <= +f.max)
      && !(f.hideBound && r.bound) && !(f.hideLocked && r.locked));
  }
  function renderCount() {
    const n = [...sel.values()].reduce((a, b) => a + b, 0);
    $('[data-k="count"]').textContent = `${sel.size} objet(s) · ${n} exemplaire(s) sélectionné(s) — ${visible.length} affiché(s) sur ${rows.length}`;
  }
  function renderList() {
    visible = filtered();
    lastIdx = null;
    list.innerHTML = visible.map((r, i) => {
      const on = sel.has(r.key);
      const tier = r.fusion >= FUSION_MAX ? ' <span style="color:#ffd76a;font-size:11px;font-weight:800">· ★ Rayonnant</span>'
        : r.fusion ? ` <span style="color:#e2b04a;font-size:11px">· Tiers ${r.fusion + 1}</span>` : '';
      const note = r.bound ? `<span style="color:#7cb7e8;font-size:11px">lié jusqu’à ${esc(new Date(r.boundUntil).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}</span>` : r.locked ? '<span style="font-size:11px">🔒</span>' : '';
      const qty = r.qty > 1 && !r.bound
        ? `<input data-qty="${i}" type="number" min="1" max="${r.qty}" value="${sel.get(r.key) || r.qty}" style="${inp};width:58px;padding:2px 4px" data-tip="Exemplaires à échanger (sur ${r.qty})"> / ${r.qty}`
        : '';
      return `<li style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-bottom:1px solid #2a231a;${r.bound ? 'opacity:.5' : ''}">
        <input data-i="${i}" type="checkbox" ${on ? 'checked' : ''} ${r.bound ? 'disabled' : ''} style="width:16px;height:16px">
        <img src="/img/items/${+r.icon}.png" alt="" width="28" height="28" loading="lazy" style="object-fit:contain">
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span class="rarity-${+r.rarity} rarity-text" style="font-weight:700">${esc(r.name)}</span>${tier}
          <span style="color:#999;font-size:11px">· niv. ${r.lvl} · ${esc(SLOT_NAMES[r.slot] || r.slot || '')}</span> ${note}</span>
        <span style="white-space:nowrap;color:#bbb">${qty}</span></li>`;
    }).join('') || `<li style="padding:12px;color:#999;text-align:center">${rows.length
      ? `Aucun objet pour ces filtres (${rows.length} objet(s) masqué(s)). <button data-a="reset" style="${btn};background:#3a3125;margin-left:6px">↺ Réinitialiser les filtres</button>`
      : 'Aucun objet vendable dans ton inventaire (les objets équipés ne peuvent pas être échangés).'}</li>`;
    renderCount();
  }

  list.addEventListener('click', (e) => {
    const cb = e.target.closest('input[data-i]');
    if (!cb) {   // clic sur la ligne (hors champ quantité) = coche la case
      const li = e.target.closest('li');
      const box = li?.querySelector('input[data-i]');
      if (box && !box.disabled && !e.target.closest('input')) { box.click(); }
      return;
    }
    const i = +cb.dataset.i;
    const set = (j, on) => {
      const r = visible[j];
      if (r.bound) return;
      if (on) sel.set(r.key, +list.querySelector(`[data-qty="${j}"]`)?.value || r.qty); else sel.delete(r.key);
      const c = list.querySelector(`input[data-i="${j}"]`);
      if (c) c.checked = on;
    };
    if (e.shiftKey && lastIdx != null) {
      for (let j = Math.min(lastIdx, i); j <= Math.max(lastIdx, i); j++) set(j, cb.checked);
    } else set(i, cb.checked);
    lastIdx = i;
    renderCount();
  });
  list.addEventListener('input', (e) => {
    const qi = e.target.closest('input[data-qty]');
    if (!qi) return;
    const r = visible[+qi.dataset.qty];
    const n = Math.max(1, Math.min(r.qty, Math.floor(+qi.value) || 1));
    if (sel.has(r.key)) sel.set(r.key, n);
    renderCount();
  });

  async function commit() {
    const q = rows.filter((r) => sel.has(r.key)).map((r) => ({ name: r.name, lvl: r.lvl, fusion: r.fusion, qty: sel.get(r.key) }));
    await setTradeQueue(q);
    queueMsg(`📋 ${q.length} objet(s) en file.`);
    return q.length;
  }
  ov.addEventListener('click', async (e) => {
    const a = e.target.closest('button[data-a]')?.dataset.a;
    if (a === 'x') close();
    else if (a === 'all') { for (const r of visible) if (!r.bound) sel.set(r.key, sel.get(r.key) || r.qty); renderList(); }
    else if (a === 'none') { sel.clear(); renderList(); }
    else if (a === 'reset') { f = { ...NO_FILTERS }; syncFilters(); renderList(); }
    else if (a === 'save') { await commit(); close(); }
    else if (a === 'go') { const n = await commit(); close(); if (n) runQueue(); }
  });
  renderList();
  $('[data-f="q"]').focus();
}

// Boutons « 🔁 Échanger » et « ➕ File » : sous « Vendre au marchand » (/inventaire) et sous « Mettre en vente » (/hdv?onglet=vendre).
function tradeAnchors() {
  if (location.pathname.startsWith('/inventaire')) {
    return [...document.querySelectorAll('div.text-sm.text-muted')]
      .filter((l) => l.textContent.trim() === 'Vendre au marchand' && l.nextElementSibling)
      .map((l) => l.parentElement);
  }
  if (location.pathname.startsWith('/hdv')) {
    return [...document.querySelectorAll('button.btn-gold')].filter((b) => b.textContent.trim() === 'Mettre en vente');
  }
  return [];
}

function scanTradeButtons() {
  renderQueue();
  // Panneau refermé : React retire ses propres nœuds mais pas le nôtre.
  const anchors = tradeAnchors();
  for (const w of document.querySelectorAll('.dm-trade')) {
    if (!anchors.includes(w.previousElementSibling)) w.remove();
  }
  for (const anchor of anchors) {
    let wrap = anchor.nextElementSibling;
    if (!wrap?.classList.contains('dm-trade')) {
      wrap = document.createElement('div');
      wrap.className = 'dm-trade';
      wrap.style.cssText = 'margin-top:8px';
      wrap.innerHTML = '<div style="display:flex;gap:6px">'
        + '<button type="button" data-k="go" class="btn !py-1.5 text-sm" style="flex:1;background:#2b5d8a;color:#fff;border-color:#2b5d8a" data-tip="Met cet objet en vente à 11-49 kamas à l’HDV et le fait acheter immédiatement par ton autre compte (autre fenêtre, normale ↔ privée). Si l’achat échoue, l’annonce est retirée.">🔁 Échanger (→ autre compte)</button>'
        + '<button type="button" data-k="add" class="btn !py-1.5 text-sm" style="white-space:nowrap;background:transparent" data-tip="Ajouter à la file d’échange (re-cliquer = un exemplaire de plus)">➕ File</button>'
        + '</div><div class="text-xs" style="margin-top:4px;min-height:1em"></div>';
      const go = wrap.querySelector('[data-k="go"]');
      const add = wrap.querySelector('[data-k="add"]');
      const msg = wrap.lastElementChild;
      const say = (t, cls) => { msg.textContent = t; msg.style.color = cls === 'err' ? '#e0675c' : cls === 'ok' ? '#6cc070' : ''; };
      add.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const it = itemFromPanel(panelOf(wrap));
        if (!it) return say('❌ Objet illisible', 'err');
        // objet lié (acheté il y a moins de 24 h, éternel…) : le jeu refusera de le mettre en vente
        if (/li[ée]e?\s+(jusqu|à vie|au compte|pendant)|moins de 24\s*h/i.test(panelOf(wrap)?.textContent || '')) return say('❌ Objet lié : il ne peut pas être échangé pour l’instant', 'err');
        const n = queueAdd(it);
        say(`➕ ${itemLabel(it)} dans la file${n > 1 ? ` (×${n})` : ''}`, 'ok');
      });
      go.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (tradeBusy) return;
        tradeBusy = true;
        go.disabled = true;
        try {
          say(await tradeItem(panelOf(wrap), say), 'ok');
          if (/^\/(hdv|inventaire)/.test(location.pathname)) setTimeout(() => location.reload(), 1500);
        } catch (err) {
          say(`❌ ${err.message}`, 'err');
        } finally {
          tradeBusy = false;
          go.disabled = false;
        }
      });
      anchor.after(wrap);
    }
    // Autre objet sélectionné : on efface le message du précédent.
    const key = JSON.stringify(itemFromPanel(panelOf(wrap)));
    if (wrap.dataset.key !== key && !tradeBusy) { wrap.dataset.key = key; wrap.lastElementChild.textContent = ''; }
  }
}

// Ajouts dans les pages du jeu, selon les modules activés (un module désactivé retire ses boutons).
function scanModules() {
  document.querySelectorAll('.dm-lock').forEach((el) => el.remove());   // ancien bouton 🔒 (avant le cadenas du jeu)
  if (modOn('trade')) scanTradeButtons(); else { document.querySelectorAll('.dm-trade').forEach((el) => el.remove()); document.querySelector('.dm-queue')?.remove(); }
  if (modOn('wanted')) highlightWanted();
  if (modOn('fusion')) scanFuseButtons(); else document.querySelectorAll('.dm-fuse-all').forEach((el) => el.remove());
  scanUnequipAllButton();
  scanCancelAllButton();
  scanManualWeightsButton();
  scanDeckButton();
}

let lockScanQueued = false;
const domObserver = new MutationObserver(() => {
  if (dead || lockScanQueued) return;
  lockScanQueued = true;
  requestAnimationFrame(() => {
    lockScanQueued = false;
    scanModules();
    if (isOwner() && !busy && location.pathname.startsWith('/combat') && endTitle()) tick();   // écran de fin affiché : relance sans attendre
  });
}).observe(document.documentElement, { childList: true, subtree: true });

async function runAutosell(dryRun) {
  try {
    const r = await autosell(dryRun);
    if (!dryRun && r.count && location.pathname.startsWith('/inventaire')) setTimeout(() => location.reload(), 1500);
    return r;
  } catch (e) {
    sellActionId = null;   // l'ID a peut-être changé (nouveau déploiement) : on le relira
    return { ok: false, error: e.message || String(e) };
  }
}
