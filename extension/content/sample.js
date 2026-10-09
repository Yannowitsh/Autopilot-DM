// Autopilot-DM — content script : échantillonnage des zones (mesurer la rentabilité de la chasse).
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- 🧪 Échantillonner les zones ----------
// But : avoir au moins `target` combats mesurés (victoires de chasse, voir farmOnRewards dans hunt.js) dans chaque zone
// accessible dont le niveau min est entre `min` et `max`. Les combats comptés sont les tiens (tous tes personnages) +
// ceux reçus par la synchro (Worker partagé) : ce que ton pote a farmé avance aussi les compteurs.
// Le pilote va toujours dans la zone la MOINS mesurée, puis, dans la zone, attaque le groupe dont le nombre de monstres
// y est le moins représenté (un groupe de 2 et un groupe de 6 ne rapportent pas pareil : le modèle de rentabilité calcule
// monstre par monstre, il lui faut toutes les tailles). Après chaque victoire on repasse par la page de la zone pour
// rechoisir ; zone à l'objectif → la moins mesurée suivante. SAMPLE_MAX_DEFEATS défaites d'affilée : zone abandonnée.
// cfg.sampleRun = { active, min, max, target, zones: [{ id, name, lvlMin, lvlMax }], zone, skipped: [], prev, startedAt }
const SAMPLE_MAX_DEFEATS = 3;
const sampleOn = () => !!cfg.sampleRun?.active;

// Combats mesurés par zone : Map(zone → { n, sizes: { nb de monstres: combats } }).
// Synchro configurée : compteurs du Worker (tous joueurs, sans les plafonds du stockage local, relus toutes les 5 min)
// + tes combats pas encore envoyés. Sinon : tes combats + ceux déjà reçus (farmShared).
let sampleMemo = { key: '', map: new Map() };
function sampleCounts() {
  const srv = cfg.syncCounts?.zones && cfg.syncUrl && cfg.syncKey ? cfg.syncCounts : null;
  const lists = srv ? Object.entries(cfg.farmLog || {}).map(([p, l]) => (l || []).filter((r) => r.at > (cfg.syncPushed?.[p] || 0)))
    : [...Object.values(cfg.farmLog || {}), ...Object.values(cfg.farmShared || {})];
  const key = `${srv?.at || 0}|${lists.map((l) => `${l?.length || 0}:${l?.[l.length - 1]?.at || 0}`).join(',')}`;
  if (key === sampleMemo.key) return sampleMemo.map;
  const map = new Map();
  const add = (z, k, n) => {
    const e = map.get(z) || { n: 0, sizes: {} };
    e.n += n;
    e.sizes[k] = (e.sizes[k] || 0) + n;
    map.set(z, e);
  };
  for (const [z, e] of Object.entries(srv?.zones || {})) for (const [k, n] of Object.entries(e.sizes || {})) add(+z, +k, +n || 0);
  for (const l of lists) for (const r of l || []) if (r?.z && Array.isArray(r.m)) add(r.z, r.m.length, 1);
  sampleMemo = { key, map };
  return map;
}
const sampleCount = (z) => sampleCounts().get(z)?.n || 0;
const sampleZoneName = (z, run = cfg.sampleRun) => run?.zones?.find((x) => x.id === z)?.name || `zone ${z}`;
// Zones restant à mesurer, la moins mesurée d'abord (à égalité : la plus haute).
const sampleLeft = (run = cfg.sampleRun) => (run?.zones || [])
  .filter((z) => !run.skipped?.includes(z.id) && sampleCount(z.id) < run.target)
  .sort((a, b) => sampleCount(a.id) - sampleCount(b.id) || (b.lvlMin ?? 0) - (a.lvlMin ?? 0));

// Groupe à attaquer sur la page de la zone : taille la moins mesurée dans cette zone (à égalité : le plus gros, plus de
// monstres mesurés par combat) ; false si aucun groupe ; null si la page n'est pas chargée.
function samplePickGroup() {
  const cards = groupCards();
  if (!cards.length) return null;
  const sizes = sampleCounts().get(cfg.huntZone)?.sizes || {};
  let best = null;
  for (const p of cards) {
    const n = groupMonsters(p).length;
    if (!n) continue;
    const seen = sizes[n] || 0;
    if (!best || seen < best.seen || (seen === best.seen && n > best.n)) best = { g: groupNumber(p), n, seen };
  }
  return best ? best.g : false;
}

// Zone suivante : la moins mesurée ; plus rien → fin.
async function sampleGoZone(why) {
  const run = cfg.sampleRun;
  if (!run?.active) return;
  const next = sampleLeft(run)[0];
  if (!next) {
    const skipped = run.skipped?.length || 0;
    return skipped ? sampleStop(`objectif atteint sauf pour ${skipped} zone(s) abandonnée(s) (défaites) : ${run.skipped.map((z) => sampleZoneName(z, run)).join(', ')}`)
      : sampleEnd('Échantillonnage terminé ✔', `✅ **Échantillonnage terminé** : au moins ${run.target} combats mesurés dans les ${run.zones.length} zone(s) ${run.min}–${run.max}. Pilote arrêté.`);
  }
  DM.log(`échantillonnage : ${why} → ${next.name} (${sampleCount(next.id)}/${run.target})`);
  await save({ sampleRun: { ...run, zone: next.id }, huntZone: next.id, huntZoneName: next.name, huntGroup: null, huntTarget: null, lossStreak: 0 });
  setStatus(`Échantillonnage : ${next.name} (${sampleCount(next.id)}/${run.target} combats)…`);
  progress();
  if (isOwner()) location.assign(`/chasse?zone=${next.id}`);
}

// Après une victoire : zone à l'objectif → suivante ; sinon retour à la page de la zone pour rechoisir le groupe.
// true = on s'en occupe (pas de relance du même groupe).
async function sampleAfterWin() {
  if (!sampleOn() || !isHunt()) return false;
  if (sampleCount(cfg.huntZone) >= cfg.sampleRun.target) {
    notify('sample', `🧪 Échantillonnage : **${sampleZoneName(cfg.huntZone)}** à l’objectif (${sampleCount(cfg.huntZone)} combats). ${sampleLeft().length} zone(s) restante(s).`);
    await sampleGoZone(`${sampleZoneName(cfg.huntZone)} à l’objectif`);
    return true;
  }
  await goHome();
  return true;
}

// Défaites d'affilée dans une zone : abandonnée, on passe à la suivante.
async function sampleOnDefeats(streak, hint) {
  const z = cfg.huntZone;
  notify('sample', `❌ Échantillonnage : ${streak} défaites d’affilée dans **${sampleZoneName(z)}** — zone abandonnée, passage à la suivante.${hint ? `\n> 💡 ${hint}` : ''}`);
  await save({ sampleRun: { ...cfg.sampleRun, skipped: [...(cfg.sampleRun.skipped || []), z] } });
  return sampleGoZone(`${streak} défaites dans ${sampleZoneName(z)}`);
}

// Fin : pilote arrêté, mode précédent rétabli.
async function sampleEnd(status, msg) {
  const run = cfg.sampleRun;
  if (!run) return;
  const prev = run.prev || {};
  await save({ sampleRun: { ...run, active: false, endedAt: Date.now() }, enabled: false, paused: false, botFight: false, status,
    mode: prev.mode || cfg.mode, huntZone: prev.huntZone ?? null, huntZoneName: prev.huntZoneName || '', huntGroup: prev.huntGroup ?? null, huntTarget: null });
  notify('sample', msg);
}
const sampleStop = (reason) => sampleEnd(`Échantillonnage arrêté : ${reason}`.slice(0, 200), `⏹️ **Échantillonnage arrêté** : ${reason}`);

async function startSample({ min, max, target, zones }, say = () => {}) {
  if (dropOn()) { say('Arrêt du farm de drop…'); await dropStop('remplacé par 🧪 Échantillonnage', false); }
  const run = { active: true, startedAt: Date.now(), min, max, target, zones, skipped: [], zone: null,
    prev: sampleOn() ? cfg.sampleRun.prev : { mode: cfg.mode, huntZone: cfg.huntZone, huntZoneName: cfg.huntZoneName, huntGroup: cfg.huntGroup } };
  if (!sampleLeft(run).length) throw new Error('toutes ces zones ont déjà assez de combats');
  await save({ sampleRun: run, mode: 'chasse', pauseReason: null });
  say('Démarrage du pilote…');
  await send({ type: 'claim', start: true }).catch(() => {});   // le pilote démarre sur cet onglet
  say(`Direction ${sampleLeft(run)[0]?.name || 'la 1re zone'}…`);
  await sampleGoZone('départ');
}

// Fenêtre « 🧪 Échantillonner les zones » : niveaux, objectif, aperçu zone par zone, lancement.
const SAMPLE_PREFS_KEY = 'dmSamplePrefs';
async function openSampleFarm() {
  document.querySelector('.dm-sample')?.remove();
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const fmt = (n) => Math.round(n).toLocaleString('fr-FR');
  let p = { min: 150, max: 200, target: 100 };
  try { p = { ...p, ...JSON.parse(localStorage.getItem(SAMPLE_PREFS_KEY) || '{}') }; } catch { /* défaut */ }
  if (cfg.sampleRun) p = { ...p, min: cfg.sampleRun.min, max: cfg.sampleRun.max, target: cfg.sampleRun.target };
  const ov = document.createElement('div');
  ov.className = 'dm-sample';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483601;background:#000c;display:grid;justify-items:center;align-items:start;padding:4vh 16px 16px;font:13px system-ui,sans-serif;color:#eee';
  const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:5px 10px;color:#fff;cursor:pointer;font:600 12px system-ui,sans-serif;background:#2a231a';
  const inp = 'background:#2a231a;border:1px solid #5a4a33;border-radius:8px;color:#eee;padding:3px 6px;font:13px system-ui,sans-serif;width:64px';
  ov.innerHTML = `<div style="width:min(680px,100%);max-height:90vh;display:flex;flex-direction:column;gap:10px;background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:14px;box-shadow:0 10px 40px #000">
    <div style="display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:15px">🧪 Échantillonner les zones${DM.tip('Pour fiabiliser 📈 Rentabilité des zones : le pilote farme en chasse jusqu’à avoir au moins N combats mesurés (victoires) dans chaque zone choisie.&#10;Comptés : tes combats (tous tes personnages) + ceux reçus par la synchro — ce que farme ton pote avance aussi les compteurs (synchro toutes les 5 min).&#10;Le pilote va toujours dans la zone la MOINS mesurée. Dans la zone, il attaque le groupe dont le nombre de monstres y est le moins représenté (2, 3… 8 monstres : la rentabilité est calculée monstre par monstre, il faut toutes les tailles), puis repasse par la zone après chaque victoire pour rechoisir.&#10;Zones : toutes celles dont le niveau min est dans la plage (et pas au-dessus de ton niveau). 3 défaites d’affilée dans une zone : abandonnée (notification). Tout est mesuré : arrêt + notification.')}</b><button data-a="x" style="${btn};background:transparent">✕</button></div>
    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;font-size:12px">
      <label>Niveau min <input type="number" data-f="min" min="1" max="250" style="${inp}" value="${+p.min}"></label>
      <label>Niveau max <input type="number" data-f="max" min="1" max="250" style="${inp}" value="${+p.max}"></label>
      <label>Objectif <input type="number" data-f="target" min="1" max="5000" style="${inp}" value="${+p.target}"> combats par zone</label>
    </div>
    <div data-k="sum" style="font-size:12px;color:#b9a98c">Lecture des zones…</div>
    <div data-k="list" style="overflow-y:auto;max-height:55vh;display:flex;flex-direction:column;gap:3px"></div>
    <div style="display:flex;gap:8px;align-items:center"><span data-k="msg" style="flex:1;font-size:12px;color:#b9a98c"></span>
      <button data-a="stop" style="${btn};display:${sampleOn() ? '' : 'none'}">■ Arrêter</button>
      <button data-a="go" style="${btn};background:#2b6d8a">🧪 Lancer</button></div></div>`;
  document.body.appendChild(ov);
  DM.installTips(ov);
  const $ = (q) => ov.querySelector(q);
  let all = [];
  // toutes les zones du jeu (pas seulement celles « à ton niveau » du site), jusqu'à ton niveau
  let myLvl = null;
  try {
    const r = await DM.fetchT(DM.ORIGIN + '/chasse', { credentials: 'include', cache: 'no-store' });
    myLvl = +DM.zoneBrowserProps(await r.text())?.level || null;
    all = await DM.fetchZones({ all: true });
  } catch (e) { $('[data-k="sum"]').textContent = `❌ Zones illisibles : ${e.message}`; return; }
  if (myLvl) all = all.filter((z) => z.lvlMin == null || z.lvlMin <= myLvl);
  const read = () => ({ min: +$('[data-f="min"]').value || 0, max: +$('[data-f="max"]').value || 0, target: Math.max(1, +$('[data-f="target"]').value || 0) });
  const pick = ({ min, max }) => all.filter((z) => z.lvlMin != null && z.lvlMin >= min && z.lvlMin <= max)
    .map((z) => ({ id: z.id, name: z.region ? `${z.name} (${z.region})` : z.name, lvlMin: z.lvlMin, lvlMax: z.lvlMax }));
  const render = () => {
    const o = read(), zones = pick(o), counts = sampleCounts();
    const rows = zones.map((z) => ({ ...z, c: counts.get(z.id) || { n: 0, sizes: {} } })).sort((a, b) => a.c.n - b.c.n || b.lvlMin - a.lvlMin);
    const todo = rows.reduce((s, r) => s + Math.max(0, o.target - r.c.n), 0);
    const done = rows.filter((r) => r.c.n >= o.target).length;
    $('[data-k="sum"]').textContent = zones.length ? `Objectif : ${o.target} combats dans CHACUNE des ${zones.length} zone(s) · ${done} déjà à ${o.target} (ignorée(s)) · ${zones.length - done} à compléter, soit ~${fmt(todo)} combat(s) au total`
      : 'Aucune zone accessible dans cette plage de niveaux.';
    $('[data-k="list"]').innerHTML = rows.map((r) => {
      const pct = Math.min(100, r.c.n / o.target * 100);
      const sizes = Object.entries(r.c.sizes).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}×${v}`).join(' ');
      const cur = sampleOn() && cfg.sampleRun.zone === r.id;
      return `<div style="display:flex;align-items:center;gap:8px;background:#241e16;border:1px solid ${cur ? '#2b6d8a' : '#3a3024'};border-radius:8px;padding:4px 8px">
        <span style="flex:1;min-width:0">${cur ? '▶ ' : ''}${esc(r.name)} <span style="color:#8a7d66">niv. ${r.lvlMin}–${r.lvlMax}</span>${sizes ? `<br><span style="font-size:11px;color:#8a7d66" title="combats par nombre de monstres">monstres : ${sizes}</span>` : ''}</span>
        <span style="width:120px;height:8px;background:#3a3024;border-radius:4px;overflow:hidden"><span style="display:block;height:100%;width:${pct}%;background:${pct >= 100 ? '#2e7d32' : '#2b6d8a'}"></span></span>
        <span style="width:70px;text-align:right">${r.c.n >= o.target ? '✔ ' : ''}${r.c.n}/${o.target}</span></div>`;
    }).join('');
    $('[data-a="go"]').textContent = sampleOn() ? '🧪 Relancer avec ces réglages' : '🧪 Lancer';
  };
  render();
  ov.addEventListener('input', (e) => {
    if (!e.target.dataset.f) return;
    try { localStorage.setItem(SAMPLE_PREFS_KEY, JSON.stringify(read())); } catch { /* stockage indisponible */ }
    render();
  });
  ov.addEventListener('click', async (e) => {
    if (e.target === ov || e.target.closest('[data-a="x"]')) return ov.remove();
    if (e.target.closest('[data-a="stop"]')) { await sampleStop('arrêté à la main'); return ov.remove(); }
    if (!e.target.closest('[data-a="go"]')) return;
    const o = read();
    if (o.min > o.max) { $('[data-k="msg"]').textContent = 'Niveau min > niveau max.'; return; }
    try {
      $('[data-k="msg"]').textContent = 'Lancement…';
      await startSample({ ...o, zones: pick(o) }, (t) => { $('[data-k="msg"]').textContent = t; });
      ov.remove();
    } catch (err) { $('[data-k="msg"]').textContent = `❌ ${err.message}`; }
  });
}
