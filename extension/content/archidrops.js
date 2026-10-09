// Autopilot-DM — content script : 👑 Drops d'archimonstres (et d'avis de recherche).
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- 👑 Drops d'archimonstres ----------
// Tous les combats de chasse gagnés de la synchro (toi, Lanthane… : Worker /drops, enregistrés par combatrec.js) qui
// contiennent un archimonstre (ou un avis de recherche) : pour chacun, combien de combats, et chaque objet obtenu dans ces
// combats avec son taux (combats où il est tombé / combats). Un combat a souvent d'autres monstres : les objets que le
// bestiaire attribue à ce monstre (★, avec leur chance de base) sont séparés des autres objets tombés dans ces combats.
// Cache local (localStorage) : seuls les combats nouveaux sont demandés au Worker à chaque ouverture.
// cache = { next, rows: [{ seq, p, at, m: [[nom, niveau, grade]], it: [[id, nom, icône, niveau, fusion, rareté, type]], pp, k, card }] }
const ARCHI_DROPS_KEY = 'dmArchiDrops';
const archiDropsCache = () => { try { return JSON.parse(localStorage.getItem(ARCHI_DROPS_KEY) || 'null') || { next: 0, rows: [] }; } catch { return { next: 0, rows: [] }; } };
const isSpecialMob = (name) => !!targetMatch(name, ALL_KINDS);

// Nouveaux combats depuis le dernier passage ; on ne garde que ceux qui ont un archimonstre ou un avis de recherche.
async function archiDropsSync(say = () => {}) {
  const c = archiDropsCache();
  for (let i = 0; i < 50; i++) {
    const r = await send({ type: 'dropsShared', since: c.next });
    if (!r?.ok) throw new Error(r?.error || 'synchro injoignable');
    for (const d of r.drops || []) {
      if (!d.m?.some(([n]) => isSpecialMob(n))) continue;
      c.rows.push({ seq: d.seq, p: d.p, at: d.at, m: d.m, it: d.it, pp: 100 + (+d.pr || 0) + Math.floor((+d.ch || 0) / 10), k: d.k, card: d.card });
    }
    const done = !r.drops?.length || r.next === c.next;
    c.next = r.next;
    say(`Lecture des combats partagés… ${c.rows.length} combat(s) avec archimonstre / avis`);
    if (done || r.drops.length < 1000) break;
  }
  try { localStorage.setItem(ARCHI_DROPS_KEY, JSON.stringify(c)); } catch { /* stockage plein : recalculé la prochaine fois */ }
  return c.rows;
}

// Statistiques par monstre (nom) : { name, kind, fights, players: Map(joueur → combats), lvls: Set, pp: [], grades: Set,
// items: Map(id → { id, n, icon, lvl, r, fights, qty, mine }) }.
function archiDropStats(rows, players) {
  const by = new Map();
  for (const d of rows) {
    if (players && !players.has(d.p)) continue;
    const names = [...new Set(d.m.map(([n]) => n).filter(isSpecialMob))];
    for (const name of names) {
      const s = by.get(name) || { name, kind: targetMatch(name, ALL_KINDS).kind, fights: 0, alone: 0, players: new Map(), lvls: new Set(), grades: new Set(), pp: [], items: new Map(), last: 0 };
      s.fights++;
      if (d.m.every(([n]) => n === name)) s.alone++;
      s.players.set(d.p, (s.players.get(d.p) || 0) + 1);
      for (const [n, l, g] of d.m) if (n === name) { s.lvls.add(l); s.grades.add(g); }
      s.pp.push(d.pp);
      s.last = Math.max(s.last, d.at);
      const seen = new Set();
      for (const [id, n, icon, lvl, , r] of d.it) {
        const it = s.items.get(id) || { id, n, icon, lvl, r, fights: 0, qty: 0 };
        it.qty++;
        if (!seen.has(id)) { it.fights++; seen.add(id); }
        s.items.set(id, it);
      }
      by.set(name, s);
    }
  }
  return [...by.values()];
}

async function openArchiDrops() {
  document.querySelector('.dm-archi-drops')?.remove();
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const pct = (x) => `${(x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toFixed(2)).replace('.', ',')} %`;
  const ov = document.createElement('div');
  ov.className = 'dm-archi-drops';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:#000a;display:grid;justify-items:center;align-items:start;padding:4vh 16px 16px;font:13px system-ui,sans-serif;color:#eee';
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
  const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:4px 9px;color:#fff;cursor:pointer;font:600 12px system-ui,sans-serif;background:#2a231a';
  const inp = 'background:#241e16;color:#eee;border:1px solid #5a4a33;border-radius:6px;padding:3px 6px;font:12px system-ui,sans-serif';
  ov.innerHTML = `<div style="width:min(860px,100%);max-height:90vh;display:flex;flex-direction:column;gap:10px;background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:14px;box-shadow:0 10px 40px #000">
    <div style="display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:15px">👑 Drops d’archimonstres${DM.tip('Tous les combats de chasse gagnés enregistrés par la synchro (toi et tes amis dont l’extension est à jour, « Envoyer mes combats » coché) qui contenaient un archimonstre — ou un avis de recherche, au choix.&#10;Pour chacun : nombre de combats, puis chaque objet obtenu dans ces combats avec son taux = combats où il est tombé ÷ combats.&#10;★ : objet que le bestiaire attribue à ce monstre (chance de base affichée ; ta chance réelle = base × Prospection ÷ 100, 90 % au plus). Les autres objets sont tombés dans les mêmes combats mais viennent sans doute des autres monstres du groupe.&#10;Prospection : moyenne des combats comptés.')}</b>
      <button data-a="x" style="${btn};background:transparent">✕</button></div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:12px">
      <select data-f="kind" style="${inp}"><option value="archi">👑 Archimonstres</option><option value="wanted">🎯 Avis de recherche</option></select>
      <input data-f="q" type="search" placeholder="Monstre ou objet…" style="${inp};width:200px">
      <select data-f="sort" style="${inp}"><option value="fights">Plus combattus</option><option value="name">Nom</option><option value="lvl">Niveau</option><option value="items">Plus d’objets ★</option></select>
      <span data-k="players" style="display:flex;gap:8px;flex-wrap:wrap"></span>
      <span data-k="msg" style="color:#b9a98c;margin-left:auto"></span>
    </div>
    <div data-k="list" style="overflow-y:auto;display:flex;flex-direction:column;gap:6px"></div></div>`;
  document.body.appendChild(ov);
  const $ = (q) => ov.querySelector(q);
  const say = (t) => { $('[data-k="msg"]').textContent = t; };
  ov.querySelector('[data-a="x"]').addEventListener('click', close);
  let rows = archiDropsCache().rows, bz = null;
  const off = new Set();   // joueurs décochés
  const render = () => {
    const kind = $('[data-f="kind"]').value, q = normName($('[data-f="q"]').value || ''), sort = $('[data-f="sort"]').value;
    const all = [...new Set(rows.map((d) => d.p))].sort();
    $('[data-k="players"]').innerHTML = all.map((p) => `<label><input type="checkbox" data-p="${esc(p)}"${off.has(p) ? '' : ' checked'}> ${esc(p)} (${rows.filter((d) => d.p === p).length})</label>`).join('');
    const players = new Set(all.filter((p) => !off.has(p)));
    // objets attribués à un monstre par le bestiaire : nom normalisé → Map(id objet → chance de base)
    const own = (name) => {
      const out = new Map();
      for (const [id, srcs] of Object.entries(bz?.drops || {})) for (const [m, , , p] of srcs) if (normName(m) === normName(name)) out.set(+id, +p || 0);
      return out;
    };
    let stats = archiDropStats(rows, players).filter((s) => s.kind === kind);
    if (q) stats = stats.filter((s) => normName(s.name).includes(q) || [...s.items.values()].some((it) => normName(it.n).includes(q)));
    for (const s of stats) s.own = own(s.name);
    const lvl = (s) => Math.max(...s.lvls);
    stats.sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name, 'fr') : sort === 'lvl' ? lvl(b) - lvl(a)
      : sort === 'items' ? [...b.items.keys()].filter((id) => b.own.has(id)).length - [...a.items.keys()].filter((id) => a.own.has(id)).length : b.fights - a.fights));
    const itemRow = (it, s, star) => `<div style="display:flex;align-items:center;gap:6px;padding:2px 0${star ? '' : ';opacity:.6'}">
      ${it.icon ? `<img src="/img/items/${+it.icon}.png" alt="" style="width:24px;height:24px;object-fit:contain">` : '<span style="width:24px"></span>'}
      <span style="flex:1" class="rarity-${+it.r || 0} rarity-text">${star ? '★ ' : ''}${esc(it.n)} <span style="color:#8a7d66;font-size:11px">niv. ${it.lvl ?? '?'}</span></span>
      <span style="color:#ffd76a;width:150px;text-align:right">${it.fights}/${s.fights} combats · <b>${pct(it.fights / s.fights * 100)}</b></span>
      <span style="color:#8a7d66;width:120px;text-align:right;font-size:11px">${s.own.has(it.id) ? `base ${pct(s.own.get(it.id))}` : ''}${it.qty > it.fights ? ` · ×${it.qty}` : ''}</span></div>`;
    $('[data-k="list"]').innerHTML = stats.map((s) => {
      const items = [...s.items.values()].sort((a, b) => b.fights - a.fights);
      const mine = items.filter((it) => s.own.has(it.id)), other = items.filter((it) => !s.own.has(it.id));
      const never = [...s.own.entries()].filter(([id]) => !s.items.has(id));
      const pp = Math.round(s.pp.reduce((t, v) => t + v, 0) / s.pp.length);
      const lv = [...s.lvls].sort((a, b) => a - b);
      return `<details style="background:#241e16;border:1px solid #3a3024;border-radius:8px;padding:6px 9px"${stats.length <= 3 || q ? ' open' : ''}>
        <summary style="cursor:pointer;display:flex;gap:8px;align-items:center"><b style="flex:1">${s.kind === 'archi' ? '👑' : '🎯'} ${esc(s.name)} <span style="color:#8a7d66;font-weight:400;font-size:12px">niv. ${lv[0]}${lv.length > 1 ? `–${lv.at(-1)}` : ''}${s.grades.has(6) && s.kind === 'archi' ? ' · grade 6 vu (0 XP)' : ''}</span></b>
          <span style="color:#b9a98c;font-size:12px">${s.fights} combat${s.fights > 1 ? 's' : ''}${s.alone ? ` (${s.alone} seul)` : ''} · ${[...s.players].map(([p, n]) => `${esc(p)} ${n}`).join(', ')} · PP ${pp} · ${mine.length} ★</span></summary>
        <div style="margin-top:4px">${mine.map((it) => itemRow(it, s, true)).join('') || '<div style="color:#8a7d66;font-size:12px">Aucun objet du bestiaire de ce monstre obtenu.</div>'}
          ${never.length ? `<div style="color:#8a7d66;font-size:11px;margin-top:3px">Jamais obtenus (bestiaire) : ${never.map(([id, p]) => `${esc(bz?.items?.find((x) => x.id === +id)?.n || `objet ${id}`)} (base ${pct(p)})`).join(', ')}</div>` : ''}
          ${other.length ? `<div style="color:#8a7d66;font-size:11px;margin-top:6px">Aussi tombés dans ces combats (autres monstres du groupe, sans doute) :</div>${other.map((it) => itemRow(it, s, false)).join('')}` : ''}</div></details>`;
    }).join('') || `<div style="color:#8a7d66">${rows.length ? 'Aucun combat pour ce filtre.' : 'Aucun combat enregistré avec un archimonstre pour l’instant.'}</div>`;
  };
  ov.addEventListener('input', (e) => { if (e.target.dataset.f) render(); });
  ov.addEventListener('change', (e) => { if (e.target.dataset.p != null) { if (e.target.checked) off.delete(e.target.dataset.p); else off.add(e.target.dataset.p); render(); } });
  render();
  try {
    say('Bestiaire…');
    bz = await fetchBestiary(say).catch(() => null);
    rows = await archiDropsSync(say);
    const n = new Set(rows.map((d) => d.p)).size;
    say(`${rows.length} combat(s) · ${n} joueur(s)${bz ? '' : ' · bestiaire illisible (pas de ★)'}`);
  } catch (e) { say(`❌ ${e.message}${rows.length ? ' — copie locale affichée' : ''}`); }
  render();
}
