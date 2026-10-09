// Autopilot-DM — content script : avis de recherche / archimonstres, carte, rentabilité des zones.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- Avis de recherche et archimonstres : scan des zones de chasse ----------
// Chaque /chasse?zone=… liste ses groupes (panneaux « Groupe N ») et leurs monstres. On compare les noms aux listes
// locales DM.WANTED (wanted.js) et DM.ARCHI (archi.js), selon les cases cochées (cfg.scanWanted, cfg.scanArchi).
// Les zones en échec (site saturé…) sont réessayées par passes successives.
const normName = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const WANTED_KEYS = (DM.WANTED || []).map((name) => ({ name, key: normName(name) }));
function wantedMatch(monster) {
  const k = normName(monster);
  if (!k) return null;
  // nom identique, ou l'un contient l'autre (seulement pour les noms assez longs, pour éviter « Hin » ⊂ « Chinchin »)
  return WANTED_KEYS.find((w) => w.key === k
    || (Math.min(w.key.length, k.length) >= 6 && (k.includes(w.key) || w.key.includes(k))))?.name || null;
}

// Les groupes se renouvellent toutes les ~3 min : le scan doit tenir dans ce délai.
// → requêtes en parallèle (SCAN_CONC_START, jusqu'à SCAN_CONC_MAX), ralenties automatiquement si le site sature.
const SCAN_CONC_START = 4, SCAN_CONC_MAX = 6;
const SCAN_GAP_MS = 250;                            // pause de chaque « ouvrier » entre deux zones
const SCAN_RETRY_WAITS = [0, 5000, 15000, 30000];   // pause avant chaque passe sur les zones en échec
const ZONE_LIST_TTL_MS = 30 * 60000;                // la liste des ~220 zones change rarement
let scanRunning = false, scanStop = false, scanMsg = '';
let allZonesCache = null;
const notified = new Set();   // avis déjà signalés sur Discord (zone|groupe|monstre|renouvellement)

async function scanZone(id) {
  const r = await DM.fetchT(`/chasse?zone=${id}`, { credentials: 'same-origin', cache: 'no-store' });
  if (r.redirected && /connexion/.test(r.url)) throw Object.assign(new Error('déconnecté'), { fatal: true });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // zone au-dessus du niveau du perso (« Zone réservée aux joueurs de niveau 30 et plus ») : ses groupes ne sont pas
  // attaquables → aucun groupe pour le leveling, le farm de drop, le scan…
  const req = doc.body?.textContent.match(/Zone réservée aux joueurs de niveau (\d+)/);
  if (req) throw Object.assign(new Error(`zone réservée au niveau ${req[1]}`), { empty: true, lvlReq: +req[1] });
  const groups = [];
  for (const p of groupCards(doc)) {
    const n = groupNumber(p);
    const monsters = [...p.querySelectorAll('li')].map((li) => ({
      name: li.querySelector('.font-bold')?.textContent.trim() || li.querySelector('img')?.alt || '',
      lvl: +(li.textContent.match(/Niveau\s*(\d+)/)?.[1] || 0) || null,
      img: li.querySelector('img')?.getAttribute('src') || null,
      // badges du jeu (site v2) : « Archi » (title Archimonstre) et « Recherché » (title Avis de recherche) — font foi
      // devant nos listes de noms (ex. « Ambi Guman », listé « Guman »)
      archi: !!li.querySelector('[title="Archimonstre"]'), wanted: !!li.querySelector('[title="Avis de recherche"]'),
    })).filter((m) => m.name);
    const total = +(p.textContent.match(/Niveau total\s*(\d+)/)?.[1] || 0) || null;
    const diff = p.querySelector('.title')?.nextElementSibling?.textContent.trim() || null;   // « Facile », « Très difficile »…
    groups.push({ n, monsters, total, diff });
  }
  if (!groups.length) throw Object.assign(new Error('aucun groupe'), { empty: true });   // zone sans groupe : inutile de réessayer
  const rot = html.replace(/\\"/g, '"').match(/"to"\s*:\s*(\d{12,14})\s*,\s*"prefix"\s*:\s*"Nouveaux groupes/);
  return { groups, rotateAt: rot ? +rot[1] : null };
}

// Archimonstre : nom exact seulement (« Pichakoté » est le monstre normal de « Pichakoté le Dégoutant »).
const ARCHI_KEYS = new Map((DM.ARCHI || []).map((name) => [normName(name), name]));
const archiMatch = (monster) => ARCHI_KEYS.get(normName(monster)) || null;
const scanKinds = () => ({ wanted: cfg.scanWanted !== false, archi: cfg.scanArchi !== false });
const ALL_KINDS = { wanted: true, archi: true };
const KIND_ICON = { wanted: '🎯', archi: '👑' };
// Cible du scan parmi les types cochés : { kind: 'wanted' | 'archi', name } ou null (un monstre n'est jamais les deux).
function targetMatch(monster, kinds = scanKinds()) {
  const a = archiMatch(monster);
  if (a) return kinds.archi ? { kind: 'archi', name: a } : null;
  const w = kinds.wanted && wantedMatch(monster);
  return w ? { kind: 'wanted', name: w } : null;
}

// Cibles d'une zone, groupe par groupe ; seuls les groupes contenant au moins cfg.wantedMinPerGroup cibles sont retenus
// (avis et archis cumulés si les deux sont cochés : 1 avis + 1 archi = 2 cibles dans le même combat).
function zoneMatches(z) {
  const out = [];
  const min = Math.max(1, cfg.wantedMinPerGroup || 1);
  const kinds = scanKinds();
  for (const g of z.groups || []) {
    const hits = [];
    for (const raw of g.monsters) {
      const m = typeof raw === 'string' ? { name: raw } : raw;   // anciens scans : simples noms
      const t = targetMatch(m.name, kinds);
      if (t) hits.push({ raw, m, t });
    }
    if (hits.length < min) continue;
    const nW = hits.filter((h) => h.t.kind === 'wanted').length, nA = hits.length - nW;
    for (const { raw, m, t } of hits) {
      out.push({
        zoneId: z.id, zoneName: z.name, group: g.n, monster: m.name, lvl: m.lvl, img: m.img, wanted: t.name, kind: t.kind,
        rotateAt: z.rotateAt, total: g.total, diff: g.diff, count: hits.length, nW, nA,
        others: g.monsters.filter((x) => x !== raw).map((x) => (typeof x === 'string' ? { name: x } : x)),
      });
    }
  }
  return out;
}
const scanMatches = (st = cfg.wantedScan) => (st?.zones || []).flatMap(zoneMatches);

// Lien « attaque directe » : ouvert dans le navigateur, l'extension clique « Attaquer » sur ce groupe (voir attackFromLink).
const attackLink = (f) => `${DM.ORIGIN}/chasse?zone=${f.zoneId}&dmAttack=${f.group}${f.rotateAt ? `&dmUntil=${f.rotateAt}` : ''}`;

function notifyFound(f) {
  const key = `${f.zoneId}|${f.group}|${normName(f.monster)}|${f.rotateAt || ''}`;
  if (notified.has(key)) return;
  notified.add(key);
  const others = f.others.map((o) => `${o.name}${o.lvl ? ` (${o.lvl})` : ''}`).join(', ');
  const archi = f.kind === 'archi';
  const mix = [f.nW && `${f.nW} avis de recherche`, f.nA && `${f.nA} archimonstre${f.nA > 1 ? 's' : ''}`].filter(Boolean).join(' + ');
  notify('wanted', `${archi ? '👑 **Archimonstre' : '🎯 **Avis de recherche'} : ${f.monster}**`, [{
    title: `${f.monster}${f.lvl ? ` — niveau ${f.lvl}` : ''}`,
    url: attackLink(f),
    color: archi ? 0xa070e0 : 0xe0b040,
    thumbnail: f.img ? { url: new URL(f.img, DM.ORIGIN).href } : undefined,
    description: `**${f.zoneName}** — groupe ${f.group}${f.diff ? ` (${f.diff})` : ''}`
      + `${f.count > 1 ? `\n${KIND_ICON[f.kind]} **${mix}** dans ce combat` : ''}`
      + `${f.total ? `\nNiveau total du groupe : **${f.total}**` : ''}`
      + `${others ? `\nAvec : ${others}` : ''}`
      + `${f.rotateAt ? `\nDisponible jusqu’à **${DM.hhmm(f.rotateAt)}**` : ''}`
      + `\n\n⚔️ [Attaquer direct (extension)](${attackLink(f)}) · 🗺️ [Voir la zone](${DM.ORIGIN}/chasse?zone=${f.zoneId})`,
  }]);
  showWantedCard(f);
}

// ---------- Carte « avis trouvé » sur la page (au-dessus de la bulle) ----------
const CARD_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, sans-serif; }
  .stack { position: fixed; left: 12px; bottom: calc(64px + var(--dm-lift, 0px)); z-index: 2147483646; display: flex; flex-direction: column-reverse; gap: 8px;
    width: 300px; max-width: calc(100vw - 24px); }
  .card { background: #1b1d22; color: #e8e6e1; border: 1px solid #e0b040; border-radius: 10px; padding: 10px;
    box-shadow: 0 0 18px rgba(224,176,64,.35), 0 6px 24px rgba(0,0,0,.55); font-size: 12px; animation: pop .25s ease-out; }
  @keyframes pop { from { transform: translateY(12px); opacity: 0; } }
  .top { display: flex; gap: 10px; align-items: center; }
  .icon { width: 64px; height: 64px; flex: none; border-radius: 10px; background: radial-gradient(#3a3220, #1b1d22);
    display: grid; place-items: center; border: 1px solid #5a4a20; }
  .icon img { max-width: 58px; max-height: 58px; object-fit: contain; filter: drop-shadow(0 2px 3px rgba(0,0,0,.6)); }
  .kicker { color: #e0b040; font-weight: 800; font-size: 11px; letter-spacing: .03em; }
  .name { font-size: 15px; font-weight: 800; }
  .muted { color: #9aa0a8; }
  .x { margin-left: auto; align-self: flex-start; background: none; border: 0; color: #9aa0a8; cursor: pointer; font-size: 15px; }
  .grp { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px; }
  .grp span { display: inline-flex; align-items: center; gap: 3px; background: #262a31; border-radius: 6px; padding: 2px 6px 2px 2px; }
  .grp img { width: 22px; height: 22px; object-fit: contain; }
  .btns { margin-top: 9px; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .btns a { text-align: center; text-decoration: none; color: #fff; font-weight: 700; border-radius: 6px; padding: 7px; background: #3a3f48; }
  .btns a.go { background: #b07400; }
  .btns a:hover { filter: brightness(1.15); }
`;
let cardStack = null;
function showWantedCard(f) {
  if (!document.body) return;
  if (!cardStack?.host.isConnected) {
    const host = document.createElement('div');
    host.id = 'dm-wanted-cards';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CARD_CSS}</style><div class="stack"></div>`;
    document.body.appendChild(host);
    cardStack = { host, stack: root.querySelector('.stack') };
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const img = (src, alt) => { const i = document.createElement('img'); i.src = src; i.alt = alt; return i; };

  const card = el('div', 'card');
  const top = el('div', 'top');
  const icon = el('div', 'icon');
  if (f.img) icon.append(img(f.img, f.monster)); else icon.textContent = KIND_ICON[f.kind] || '🎯';
  const info = el('div');
  info.append(el('div', 'kicker', f.kind === 'archi' ? '👑 ARCHIMONSTRE' : '🎯 AVIS DE RECHERCHE'), el('div', 'name', f.monster),
    el('div', 'muted', `${f.lvl ? `Niveau ${f.lvl} · ` : ''}groupe ${f.group}${f.diff ? ` (${f.diff})` : ''}`),
    el('div', 'muted', f.zoneName));
  const x = el('button', 'x', '✕');
  x.title = 'Fermer';
  x.addEventListener('click', () => card.remove());
  top.append(icon, info, x);
  card.append(top);

  if (f.others.length) {
    const grp = el('div', 'grp');
    for (const o of f.others) {
      const chip = el('span');
      if (o.img) chip.append(img(o.img, o.name));
      chip.append(`${o.name}${o.lvl ? ` ${o.lvl}` : ''}`);
      grp.append(chip);
    }
    card.append(grp);
  }
  const foot = el('div', 'muted', [f.count > 1 && `${f.count} cibles (${[f.nW && `${f.nW} 🎯`, f.nA && `${f.nA} 👑`].filter(Boolean).join(' + ')})`,
    f.total && `Niveau total ${f.total}`, f.rotateAt && `jusqu’à ${DM.hhmm(f.rotateAt)}`].filter(Boolean).join(' · '));
  foot.style.marginTop = '6px';
  card.append(foot);

  const btns = el('div', 'btns');
  const go = el('a', 'go', '⚔️ Attaquer');
  go.href = attackLink(f);
  const see = el('a', '', '🗺️ Voir la zone');
  see.href = `/chasse?zone=${f.zoneId}`;
  btns.append(go, see);
  card.append(btns);

  cardStack.stack.append(card);
  // la carte disparaît d'elle-même au renouvellement des groupes (l'avis n'est plus garanti)
  const ttl = f.rotateAt ? f.rotateAt - Date.now() : 3 * 60000;
  setTimeout(() => card.remove(), Math.max(15000, ttl));
}

// Zones où des archimonstres peuvent apparaître : badge « Archi ×N » de /chasse?toutes=1 → Map(id de zone → N).
async function fetchArchiZones() {
  const { flight } = await fetchFlight('/chasse?toutes=1');
  const out = new Map();
  for (const part of flight.split('"href":"/chasse?zone=').slice(1)) {
    const id = +part.match(/^(\d+)/)?.[1];
    const n = part.match(/"title":"Archimonstre"[^{}]*?"children":\["Archi"," ×(\d+)"\]/)?.[1];
    if (id && n) out.set(id, +n);
  }
  return out;
}

// resume = true : ne rescanne que les zones pas encore lues avec succès.
async function runScan(resume) {
  if (scanRunning) return;
  scanRunning = true;
  scanStop = false;
  let lastSave = 0;
  const saveScan = (st, force) => {
    if (!force && Date.now() - lastSave < 1500) return;   // en parallèle : on n'écrit pas le stockage à chaque zone
    lastSave = Date.now();
    return save({ wantedScan: st });
  };
  try {
    do {
      let st = resume && cfg.wantedScan?.zones?.length ? JSON.parse(JSON.stringify(cfg.wantedScan)) : null;
      resume = false;
      if (!st) {
        if (!allZonesCache || Date.now() - allZonesCache.at > ZONE_LIST_TTL_MS) {
          scanMsg = 'Lecture de la liste des zones…';
          renderUi();
          // toutes les zones (/chasse?toutes=1), pas seulement celles à ton niveau
          allZonesCache = { at: Date.now(), zones: await DM.fetchZones({ all: true }) };
        }
        // Filtre de niveau (0 = pas de limite) : on garde les zones dont la plage de niveaux croise [min, max].
        // Tri : zones les plus hautes d'abord (les ouvriers prennent la file dans l'ordre).
        const lo = cfg.wantedLvlMin || 0, hi = cfg.wantedLvlMax || Infinity;
        const zones = allZonesCache.zones
          .filter((z) => z.lvlMin == null || ((z.lvlMax ?? z.lvlMin) >= lo && z.lvlMin <= hi))
          .sort((a, b) => (b.lvlMax ?? b.lvlMin ?? 0) - (a.lvlMax ?? a.lvlMin ?? 0) || (b.lvlMin ?? 0) - (a.lvlMin ?? 0));
        if (!zones.length) throw new Error(`aucune zone entre les niveaux ${lo} et ${hi === Infinity ? '∞' : hi}`);
        const kinds = scanKinds();
        if (!kinds.wanted && !kinds.archi) throw new Error('coche au moins « avis de recherche » ou « archimonstres »');
        if (!kinds.wanted) {   // archis seuls : seulement les zones qui peuvent en avoir (badge « Archi ×N » de la liste)
          const archiZones = await fetchArchiZones().catch((e) => { DM.log(`scan : badges archi illisibles (${e.message})`); return null; });
          const withArchi = archiZones?.size ? zones.filter((z) => archiZones.has(z.id)) : [];
          if (withArchi.length) zones.splice(0, zones.length, ...withArchi);
          else DM.log(`scan : aucune zone à badge « Archi » dans la plage (${archiZones?.size || 0} badges lus) → toutes les zones`);
        }
        st = {
          at: Date.now(),
          range: [lo, hi === Infinity ? 0 : hi],
          zones: zones.map((z) => ({
            id: z.id,
            name: (z.region ? `${z.name} (${z.region})` : z.name) + (z.lvlMin != null ? ` [${z.lvlMin}–${z.lvlMax}]` : ''),
            status: 'pending',
          })),
        };
      }
      st.done = false;
      await saveScan(st, true);
      const t0 = Date.now();

      for (let pass = 0; pass < SCAN_RETRY_WAITS.length && !scanStop; pass++) {
        const queue = st.zones.filter((z) => !['ok', 'empty'].includes(z.status));
        if (!queue.length) break;
        if (SCAN_RETRY_WAITS[pass]) {
          scanMsg = `${queue.length} zone(s) en échec — nouvel essai dans ${SCAN_RETRY_WAITS[pass] / 1000} s`;
          renderUi();
          await sleep(SCAN_RETRY_WAITS[pass]);
          if (scanStop) break;
        }
        let conc = pass ? 2 : SCAN_CONC_START;   // les passes de rattrapage partent plus doucement
        let gap = SCAN_GAP_MS, streak = 0;
        const worker = async (i) => {
          while (queue.length && !scanStop) {
            if (i >= conc) { await sleep(500); continue; }   // ouvrier mis en veille tant que le site sature
            const z = queue.shift();
            const done = st.zones.filter((x) => ['ok', 'empty'].includes(x.status)).length;
            scanMsg = `Scan ${done}/${st.zones.length} · ${conc} en parallèle…`;
            renderUi();
            try {
              Object.assign(z, await scanZone(z.id), { status: 'ok', error: null, at: Date.now() });
              zoneMatches(z).forEach(notifyFound);   // notification Discord immédiate
              if (++streak >= 8 && conc < SCAN_CONC_MAX) { conc++; streak = 0; }
              gap = Math.max(SCAN_GAP_MS, gap * 0.8);
            } catch (e) {
              Object.assign(z, { status: e.empty ? 'empty' : 'error', error: e.message });
              if (!e.empty) { conc = Math.max(1, conc - 1); gap = Math.min(5000, gap * 2); streak = 0; }
              if (e.fatal) scanStop = true;
            }
            saveScan(st);
            await sleep(gap + Math.random() * 300);
          }
        };
        await Promise.all(Array.from({ length: SCAN_CONC_MAX }, (_, i) => worker(i)));
      }

      st.done = st.zones.every((z) => ['ok', 'empty'].includes(z.status));
      st.finishedAt = Date.now();
      await saveScan(st, true);
      const found = scanMatches(st);
      const missing = st.zones.filter((z) => !['ok', 'empty'].includes(z.status)).length;
      scanMsg = `${found.length} cible(s) trouvée(s) en ${Math.round((Date.now() - t0) / 1000)} s`
        + (missing ? ` · ${missing} zone(s) non scannée(s)` : '');
      renderUi();

      // Scan en continu : on repart juste après le prochain renouvellement des groupes.
      if (cfg.wantedLoop && !scanStop) {
        const next = Math.min(...st.zones.map((z) => z.rotateAt).filter((t) => t > Date.now()), Date.now() + 3 * 60000);
        const until = Math.max(Date.now() + 5000, next + 3000);
        scanMsg += ` — prochain scan à ${new Date(until).toLocaleTimeString('fr-FR')}`;
        renderUi();
        while (Date.now() < until && !scanStop && cfg.wantedLoop) await sleep(1000);
      }
    } while (cfg.wantedLoop && !scanStop && modOn('wanted'));
  } catch (e) {
    scanMsg = `❌ ${e.message}`;
  } finally {
    scanRunning = false;
    renderUi();
  }
}

// Lien « ⚔️ Attaquer direct » reçu sur Discord : /chasse?zone=Z&dmAttack=N[&dmUntil=t].
// Le groupe N devient la cible de chasse ; si le pilote tourne, cet onglet le prend en main (Auto + relance en boucle),
// Le pilote est démarré au besoin : il lance le combat en Auto puis le relance en boucle (comme en mode chasse),
// jusqu'au renouvellement du groupe. Si les groupes ont été renouvelés depuis (dmUntil dépassé), on n'attaque pas.
async function attackFromLink() {
  const q = new URLSearchParams(location.search);
  const group = +q.get('dmAttack'), zone = +q.get('zone'), until = +q.get('dmUntil') || 0;
  if (!location.pathname.startsWith('/chasse') || !group || !zone) return;
  history.replaceState(null, '', `/chasse?zone=${zone}`);   // retire les paramètres de l'extension de l'URL
  if (until && Date.now() > until) {
    save({ status: 'Lien d’avis expiré : les groupes ont été renouvelés' });
    return;
  }
  for (let i = 0; i < 40 && !targetGroupByNumber(group); i++) await sleep(250);   // attend l'affichage des groupes
  const name = document.querySelector('h1')?.textContent.trim() || '';
  // composition actuelle du groupe : le pilote s'arrêtera quand il sera renouvelé (voir step, mode chasse)
  const monsters = groupMonsters(targetGroupByNumber(group));
  await save({ mode: 'chasse', huntZone: zone, huntZoneName: name, huntGroup: group, pauseReason: null,
    huntTarget: monsters.length ? { zone, group, monsters } : null });
  // Le pilote (démarré s'il était arrêté) passe sur cet onglet : il attaque, active l'Auto puis relance en boucle.
  await send({ type: 'claim', start: true }).catch(() => {});
}
const targetGroupByNumber = (n) => groupCards().find((p) => groupNumber(p) === n);

// Sur une page de zone, on met en évidence les monstres d'avis de recherche.
function highlightWanted() {
  if (!location.pathname.startsWith('/chasse')) return;
  for (const li of groupCards().flatMap((p) => [...p.querySelectorAll('li')])) {
    if (li.dataset.dmWanted) continue;
    const name = li.querySelector('.font-bold')?.textContent.trim();
    if (!name) continue;
    const t = targetMatch(name, ALL_KINDS);
    li.dataset.dmWanted = t ? '1' : '0';
    if (!t) continue;
    const color = t.kind === 'archi' ? '#a070e0' : '#e0b040';
    li.style.outline = `2px solid ${color}`;
    li.style.boxShadow = `0 0 10px ${color}80`;
    li.title = t.kind === 'archi' ? `👑 Archimonstre : ${t.name}` : `🎯 Avis de recherche : ${t.name}`;
    const tag = document.createElement('span');
    tag.textContent = t.kind === 'archi' ? '👑 Archi' : '🎯 Avis';
    tag.style.cssText = `margin-left:auto;font-size:11px;font-weight:700;color:${color};white-space:nowrap`;
    li.appendChild(tag);
  }
}

// ---------- Rentabilité des zones : XP et drops mesurés à chaque combat de chasse ----------
// Le jeu n'affiche nulle part ce que rapporte un groupe : on l'enregistre à chaque victoire en chasse. Le groupe combattu
// est cfg.huntTarget (zone, n° de groupe, noms des monstres), reconnu aux noms des monstres du combat (relances comprises).
// XP : gain = Σ xp des monstres (champ « xp » de l'état du combat) × bonus de groupe × bonus du joueur × (1 + Sagesse / 100).
// Mesuré sur ~2 800 combats : bonus de groupe = 2 × (1 + 0,1 × (monstres − 1)) ; bonus du joueur = ×1,1 si le compte est lié à
// Discord (patch du 08/10, aussi +10 % de butin), × les événements (« Week-end de folie » XP ×2…). Il change d'un joueur à
// l'autre et dans le temps : il est appris par joueur (farmModel). Écart de niveau (xpLevelPen, 162 combats sur 163 de la
// remontée 1 → 200 après un Prestige) : × (1 − 0,04 par niveau au-delà de [plus haut monstre du groupe + 10]), ×0,1 au moins ;
// aucun bonus quand les monstres sont plus forts. Ramenée à 0 de Sagesse pour comparer.
// Drops : valeur de revente au marchand (prix du jeu depuis le 08/10 : min(2 000, 10 × niveau), quel que soit le tier ; avant :
// min(4 000, 20 × niveau) → combats sans `sp` divisés par 2). Règle du jeu : chance = chance de base × Prospection / 100, 90 %
// au plus par objet ; l'objet bonus de victoire et les coffres n'en dépendent pas. Chaque objet lâché est gardé avec sa chance
// de base (bestiaire, monstres du combat ; 0 = bonus de victoire ou chance non publiée → pas ajusté) pour être recalculé à la
// Prospection actuelle. En pratique le bestiaire ne publie aucune chance pour les objets lâchés à haut niveau (bonus de
// victoire) : ils ne dépendent pas de la Prospection (mesuré : même butin à 322 et 1 564). Kamas : tels quels.
// Tout est réaffiché à TA Sagesse / Prospection actuelles (dernier combat). Durée : écart avec le combat précédent dans la
// même zone (relance, animation et délais compris), sinon depuis le lancement.
// cfg.farmLog[perso] = [{ at, z, zn, g, m: [[nom, niveau, xp]], xp, sag, pp, k, v, it: [[prix, chance de base]], n, d, sp, lvl }].
const FARM_LOG_MAX = 3000;
const FARM_GAP_MS = 10 * 60000;
const FARM_CHAR_KEY = 'dmFarmChar';   // Sagesse / Prospection / niveau du dernier combat, par personnage (localStorage de la page)
// Part de l'XP gardée selon ton niveau et celui du plus haut monstre du groupe (niveaux inconnus : 1).
const xpLevelPen = (lvl, mobLvls) => {
  const top = Math.max(0, ...mobLvls.map((l) => +l || 0));
  return lvl > 0 && top > 0 ? Math.max(0.1, Math.min(1, 1 - 0.04 * (lvl - top - 10))) : 1;
};
const sellPrice = (lvl) => Math.min(2000, 10 * Math.max(1, +lvl || 0));
const SELL_PRICE_V = 2;   // `sp` des combats : 2 = prix ci-dessus ; absent = ancien prix (×2)
const groupCoef = (n) => 1 + 0.1 * (Math.max(1, n) - 1);   // bonus de groupe mesuré de 1 à 4 monstres (×2 en plus), extrapolé au-delà
const DROP_CAP = 90;   // % de chance au plus par objet (Prospection comprise)
const dropChance = (base, pp) => Math.min(DROP_CAP, base * (pp || 100) / 100);
let farmLastSig = '', itemLvlMap = null, itemBaseMap = null, itemLvlLoading = false;

// Copie locale du bestiaire → niveau des objets et chance de base par (objet, monstre).
function farmUseBestiary(c) {
  itemLvlMap = new Map(c.items.map((it) => [it.id, it.lvl]));
  itemBaseMap = new Map(Object.entries(c.drops || {}).map(([id, list]) => [+id, new Map(list.map((x) => [normName(x[0]), +x[5] || 0]))]));
}
function farmLoadBestiary() {
  if (itemLvlMap) return;
  try {
    const c = JSON.parse(localStorage.getItem(BESTIARY_KEY) || 'null');
    if (c?.v === 3 && c.items?.length) return farmUseBestiary(c);
  } catch { /* copie illisible */ }
  if (itemLvlLoading) return;
  itemLvlLoading = true;   // pas de copie : import en arrière-plan, pour les combats suivants
  fetchBestiary().then(farmUseBestiary).catch(() => {}).finally(() => { itemLvlLoading = false; });
}
// Niveau d'un objet lâché (rewards.items : { id, f, … }) : lu sur l'objet, sinon dans le bestiaire.
const farmItemLvl = (r) => +r.lvl || itemLvlMap?.get(r.id) || 0;
// Chance de base de l'objet sur les monstres du combat (la plus forte) ; 0 = objet bonus de victoire / inconnu.
const farmItemBase = (r, mobNames) => Math.max(0, ...mobNames.map((n) => itemBaseMap?.get(r.id)?.get(n) || 0));

const farmChar = () => { try { return JSON.parse(localStorage.getItem(FARM_CHAR_KEY) || '{}')[fightAcct()] || null; } catch { return null; } };

function farmOnRewards(st, rewards) {
  try {
    if (!st?.fighters?.p || !rewards || st.status === 'ongoing') return;
    const S = st.fighters.p.stats || {};
    const sag = +S.sagesse || 0, pp = 100 + (+S.prospection || 0) + Math.floor((+S.chance || 0) / 10);
    const plvl = +st.fighters.p.level || 0;   // niveau au début du combat (celui qui compte pour l'écart de niveau)
    try {
      const all = JSON.parse(localStorage.getItem(FARM_CHAR_KEY) || '{}');
      all[fightAcct()] = { sag, pp, lvl: plvl, at: Date.now() };
      localStorage.setItem(FARM_CHAR_KEY, JSON.stringify(all));
    } catch { /* stockage indisponible */ }
    if (st.status !== 'won') return;
    const mobs = Object.values(st.fighters).filter((f) => f.kind === 'monster');
    const t = cfg.huntTarget;
    if (!mobs.length || !t?.zone || !Array.isArray(t.monsters)) return;
    const names = mobs.map((m) => m.name).sort();
    // le groupe de chasse suivi ; ou, pilote en chasse, le même n° de groupe renouvelé entre deux relances
    const same = names.join('|') === [...t.monsters].sort().join('|');
    if (!same && !(isOwner() && cfg.mode === 'chasse' && cfg.huntZone === t.zone)) return;   // aventure, autre combat…
    const sig = `${names.join('|')}|${st.logCount}|${rewards.xp}`;
    if (sig === farmLastSig) return;
    farmLastSig = sig;
    const items = Array.isArray(rewards.items) ? rewards.items : [];
    farmLoadBestiary();
    const mobNames = [...new Set(mobs.map((m) => normName(m.name)))];
    const it = items.map((r) => [sellPrice(farmItemLvl(r)), farmItemBase(r, mobNames)]);
    const me = fightAcct(), log = cfg.farmLog?.[me] || [], last = log[log.length - 1], now = Date.now();
    const d = last && last.z === t.zone && now - last.at < FARM_GAP_MS ? now - last.at
      : cfg.lastLaunchAt && now - cfg.lastLaunchAt < FARM_GAP_MS ? now - cfg.lastLaunchAt : null;
    const rec = { at: now, z: t.zone, zn: cfg.huntZone === t.zone ? cfg.huntZoneName || '' : '', g: t.group,
      m: mobs.map((m) => [m.name, +m.level || 0, +m.xp || 0]), xp: +rewards.xp || 0, sag, pp,
      k: (+rewards.kamas || 0) + (+rewards.cardKamas || 0), v: it.reduce((s, x) => s + x[0], 0), it, n: items.length, d, sp: SELL_PRICE_V, lvl: plvl || undefined };
    save({ farmLog: { ...(cfg.farmLog || {}), [me]: [...log, rec].slice(-FARM_LOG_MAX) } });
  } catch (e) {
    DM.log(`rentabilité : ${e.message}`);
  }
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// Valeur des objets d'un combat recalculée à la Prospection `pp` (chaque objet : chance actuelle / chance d'alors, plafond
// 90 % ; objet bonus de victoire inchangé). Combats enregistrés sans détail (1.80.0) : proportionnel, sans plafond.
// Prix d'avant le 08/10 (pas de `sp`) : divisés par 2, la revente au marchand ayant été divisée par 2.
const farmValueAt = (r, pp) => (r.sp >= SELL_PRICE_V ? 1 : 0.5) * (r.it
  ? r.it.reduce((s, [v, base]) => s + (base > 0 ? v * dropChance(base, pp) / dropChance(base, r.pp) : v), 0)
  : r.v * (pp || 100) / (r.pp || 100));

// Modèle par monstre, appris de TOUS les combats (les tiens + ceux partagés par la synchro) :
// - XP de base de chaque monstre (nom|niveau) et bonus de groupe réel par nombre de monstres ;
// - bonus d'XP de chaque joueur (r.src : 'me' = toi, sinon pseudo de la synchro) : compte Discord lié, événements… ; pris sur
//   ses 50 derniers combats, ramenés sans écart de niveau. Le tien multiplie les prévisions ;
// - écart de niveau (xpLevelPen) au niveau demandé (cur.lvl : le tien, ou celui choisi pour préparer une remontée) ;
// - kamas par niveau de monstre (médiane, par zone si ≥ 3 combats, sinon toutes zones) ;
// - drops : valeur moyenne par monstre d'après le bestiaire (à ta Prospection), recalée sur les drops réellement mesurés
//   (Σ mesuré / Σ prévu, objets bonus de victoire compris) dès 5 combats.
// → farmPredict(zone, monstres) = ce que rapporte une composition donnée, quel que soit le nombre de monstres.
function farmModel(all, best, cur) {
  const mobXp = new Map(), kpl = { all: [] };
  const xr = [];   // [joueur, nb de monstres, XP / (Σ xp des monstres × (1 + Sagesse / 100)), date, zone]
  let dropMeas = 0, dropPred = 0, nPred = 0;
  for (const r of all) {
    let sum = 0, lvl = 0, pred = 0;
    for (const [n, l, x] of r.m) {
      if (x) mobXp.set(`${normName(n)}|${l}`, x);
      sum += x;
      lvl += +l || 0;
      pred += best?.get(normName(n)) || 0;
    }
    // XP ramenée sans écart de niveau quand le niveau du joueur est connu (combats depuis 2.1.4)
    if (sum && r.xp) xr.push([r.src || 'me', r.m.length, r.xp / (sum * (1 + r.sag / 100) * xpLevelPen(r.lvl, r.m.map((x) => x[1]))), r.at]);
    if (lvl) { kpl.all.push(r.k / lvl); (kpl[r.z] ||= []).push(r.k / lvl); }
    if (pred) { dropMeas += farmValueAt(r, cur.pp); dropPred += pred; nPred++; }
  }
  // Bonus de chaque joueur (×2 de base, ×1,1 Discord, événements…) = médiane de ses 50 derniers combats rapportés au bonus de
  // groupe, sans ceux sous 90 % de son 3e quartile (écart de niveau des combats sans niveau connu). Le tien sert aux
  // prévisions ; sans combat à toi, la médiane des autres joueurs.
  const per = {};
  for (const [s, n, x, at] of xr) (per[s] ||= []).push([at, x / groupCoef(n)]);
  const mult = Object.fromEntries(Object.entries(per).map(([s, a]) => {
    const recent = a.sort((p, q) => q[0] - p[0]).slice(0, 50).map((p) => p[1]);
    const q3 = [...recent].sort((x, y) => x - y)[Math.floor(recent.length * 0.75)];
    return [s, median(recent.filter((v) => v >= 0.9 * q3))];
  }));
  const myMult = mult.me || median(Object.values(mult)) || 2;
  const coef = groupCoef;
  const dropCal = nPred >= 5 && dropPred ? Math.min(4, Math.max(0.25, dropMeas / dropPred)) : 1;
  const kamasPerLvl = (z) => median(kpl[z]?.length >= 3 ? kpl[z] : kpl.all) || 0;
  const sagMul = 1 + (cur.sag || 0) / 100;
  // mons : [{ name, lvl }] → { xp (à ta Sagesse) | null si un monstre n'a jamais été combattu à ce niveau, val | null sans bestiaire }
  const predict = (z, mons) => {
    const xs = mons.map((m) => mobXp.get(`${normName(m.name)}|${m.lvl}`));
    const lvl = mons.reduce((s, m) => s + (+m.lvl || 0), 0);
    return {
      xp: mons.length && xs.every(Boolean)
        ? xs.reduce((a, b) => a + b, 0) * coef(mons.length) * myMult * xpLevelPen(cur.lvl, mons.map((m) => m.lvl)) * sagMul : null,
      val: best ? mons.reduce((s, m) => s + (best.get(normName(m.name)) || 0), 0) * dropCal + kamasPerLvl(z) * lvl : null,
    };
  };
  // XP de base d'un monstre déjà combattu à ce niveau (null sinon)
  const mobXpOf = (m) => mobXp.get(`${normName(m.name)}|${m.lvl}`) || null;
  return { predict, dropCal, myMult, mobXpOf };
}

// Lignes du classement, par zone + n° de groupe (ce que farme ▶ : le groupe n° N, renouvelé toutes les ~3 min).
// Un même n° de groupe change de composition (2 monstres puis 6…) : la moyenne brute des combats mélange tout. On prend
// donc, pour chaque composition déjà vue sous ce n° (combats, tiens ou partagés, + dernier scan), ce que le modèle par
// monstre en prévoit, et on en fait la moyenne. La moyenne brute mesurée reste affichée en info-bulle.
// Durée : tes combats seulement (elle dépend de ton build) — ce groupe, sinon la zone, sinon ta durée type.
function farmRows(log, shared, scan, best, cur) {
  const all = [...log, ...shared];
  const { predict, dropCal, myMult } = farmModel(all, best, cur);
  const sagMul = 1 + (cur.sag || 0) / 100;
  const cycle = median(log.map((r) => r.d).filter(Boolean)) || null;   // ta durée type d'un combat
  const zoneDur = {};
  const rows = new Map();
  const row = (z, g, zn) => {
    const k = `${z}|${g}`;
    if (!rows.has(k)) rows.set(k, { z, g, zn: zn || '', meas: null, now: null, samples: [] });
    const r = rows.get(k);
    if (zn && !r.zn) r.zn = zn;
    return r;
  };
  const addFight = (r, own) => {
    const o = row(r.z, r.g, r.zn);
    const m = o.meas ||= { n: 0, mine: 0, xp: 0, v: 0, k: 0, d: [], last: 0 };
    m.n++;
    if (own) m.mine++;
    m.xp += r.xp / (1 + r.sag / 100);
    m.v += farmValueAt(r, cur.pp);
    m.k += r.k;
    if (own && r.d) { m.d.push(r.d); (zoneDur[r.z] ||= []).push(r.d); }
    m.last = Math.max(m.last, r.at);
    o.samples.push(r.m.map(([name, lvl]) => ({ name, lvl })));
  };
  log.forEach((r) => addFight(r, true));
  shared.forEach((r) => addFight(r, false));
  for (const z of scan?.zones || []) {
    for (const g of z.groups || []) {
      const mons = g.monsters.map((x) => (typeof x === 'string' ? { name: x } : x));
      const o = row(z.id, g.n, z.name);
      o.now = { mons: mons.map((m) => `${m.name}${m.lvl ? ` ${m.lvl}` : ''}`), ...predict(z.id, mons) };
      o.samples.push(mons);
    }
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  for (const o of rows.values()) {
    const preds = o.samples.map((mons) => predict(o.z, mons));
    const m = o.meas;
    const measXp = m ? m.xp / m.n * sagMul : null, measVal = m ? (m.v + m.k) / m.n : null;
    o.xp = mean(preds.map((p) => p.xp).filter((x) => x != null)) ?? measXp;
    o.val = mean(preds.map((p) => p.val).filter((x) => x != null)) ?? measVal;
    o.measXp = measXp;
    o.measVal = measVal;
    o.comps = new Set(o.samples.map((mons) => mons.map((x) => `${normName(x.name)}|${x.lvl}`).sort().join(','))).size;
    o.dur = median(m?.d || []) || median(zoneDur[o.z] || []) || cycle;
    o.estOnly = !m;
  }
  for (const o of rows.values()) o.pen = mean(o.samples.map((mons) => xpLevelPen(cur.lvl, mons.map((m) => m.lvl))));
  return { rows: [...rows.values()], cycle, dropCal, myMult };
}

// Valeur de drop moyenne d'un monstre à la Prospection `pp` (bestiaire : chance de base par objet × pp / 100, 90 % au plus)
// → Map(nom normalisé → kamas). Objets bonus de victoire (chance non publiée) non comptés.
function bestiaryMobValue(c, pp) {
  const lvl = new Map(c.items.map((it) => [it.id, it.lvl]));
  const out = new Map();
  for (const [id, list] of Object.entries(c.drops || {})) {
    for (const [mob, , , mine, , base] of list) {
      const chance = base > 0 ? dropChance(base, pp) : Math.min(DROP_CAP, mine || 0);
      if (!(chance > 0)) continue;
      const k = normName(mob);
      out.set(k, (out.get(k) || 0) + chance / 100 * sellPrice(lvl.get(+id)));
    }
  }
  return out;
}

async function openFarmStats() {
  document.querySelector('.dm-picker')?.remove();
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const fmt = (n) => (n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString('fr-FR'));
  const ov = document.createElement('div');
  ov.className = 'dm-picker';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:#000a;display:grid;justify-items:center;align-items:start;padding:4vh 16px 16px;font:13px system-ui,sans-serif;color:#eee';
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:4px 9px;color:#fff;cursor:pointer;font:600 12px system-ui,sans-serif;background:#2a231a';
  const inp = 'background:#241e16;color:#eee;border:1px solid #5a4a33;border-radius:6px;padding:3px 6px;font:12px system-ui,sans-serif';
  ov.innerHTML = `<div style="width:min(900px,100%);max-height:90vh;display:flex;flex-direction:column;gap:10px;background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:14px;box-shadow:0 10px 40px #000">
    <div style="display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:15px">📈 Rentabilité des zones${DM.tip('Chaque victoire en chasse est enregistrée (XP, kamas, objets lâchés au prix de revente marchand), ramenée à 0 de Sagesse puis remise à ta Sagesse actuelle : changer d’équipement ne fausse pas le classement. Ton bonus d’XP personnel (compte Discord lié ×1,1, événements) est appris sur tes derniers combats, et la perte d’XP quand tu dépasses de plus de 10 niveaux le plus haut monstre du groupe (−4 % par niveau, ×0,1 au moins) est comptée à ton niveau, ou à celui choisi dans « XP à mon niveau ».&#10;Drops : revente au marchand (10 K × niveau, 2 000 K au plus ; anciens combats ramenés à ce prix). Le bestiaire ne publie pas de chance pour la plupart des objets lâchés (bonus de victoire) : ceux-là ne dépendent pas de ta Prospection et restent tels que mesurés.&#10;Le nombre de monstres compte : un n° de groupe change de composition à chaque renouvellement (2 monstres puis 6…). Pour chaque composition vue sous ce n° (combats + dernier scan), on calcule ce qu’elle rapporte monstre par monstre — XP de base × bonus de groupe appris en jeu, drops du bestiaire recalés sur tes drops réels, kamas par niveau de monstre — puis on fait la moyenne. La moyenne brute est en info-bulle.&#10;≈ : groupe jamais combattu (composition du dernier scan seulement ; XP si chaque monstre a déjà été combattu à ce niveau).&#10;Combats : les tiens, + ceux reçus par la synchro (en bleu). /min : avec TA durée réelle entre deux combats.&#10;▶ envoie le pilote farmer ce groupe en mode chasse.')}</b>
      <button data-a="x" style="${btn};background:transparent">✕</button></div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:12px">
      <label>Trier par <select data-f="sort" style="${inp}"><option value="xpMin">XP / min</option><option value="xp">XP / combat</option><option value="valMin">Kamas + drops / min</option><option value="val">Kamas + drops / combat</option></select></label>
      <label><input type="checkbox" data-f="est"> estimations (≈)</label>
      <label title="Combats reçus par la synchro (popup de l’extension)"><input type="checkbox" data-f="shared"> mesures partagées</label>
      <label>Niveau max <input type="number" data-f="lvl" min="0" max="200" style="${inp};width:60px" placeholder="—"></label>
      <label title="XP calculée à ce niveau de personnage (perte d’XP quand tu dépasses de plus de 10 niveaux le plus haut monstre du groupe : −4 % par niveau, ×0,1 au moins). Vide = ton niveau actuel. Pratique pour préparer une remontée après un Prestige. Si « Niveau max » est vide, les zones au-dessus de ce niveau sont masquées. La durée par combat reste la tienne actuelle.">XP à mon niveau <input type="number" data-f="atLvl" min="1" max="200" style="${inp};width:60px" placeholder="actuel"></label>
      <span data-k="cur" style="color:#b9a98c;margin-left:auto"></span>
    </div>
    <div data-k="msg" style="font-size:12px;color:#b9a98c"></div>
    <div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px" data-k="tbl"></table></div>
    <div style="display:flex;gap:8px;align-items:center"><span data-k="foot" style="flex:1;font-size:11px;color:#8a7d66"></span>
      <button data-a="clear" style="${btn}" title="Effacer toutes les mesures de ce personnage — 2e clic pour confirmer">🗑️ Effacer les mesures</button></div></div>`;
  document.body.appendChild(ov);
  const $ = (q) => ov.querySelector(q);
  let prefs = { sort: 'xpMin', est: true, shared: true, lvl: '', atLvl: '' };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem('dmFarmStatsPrefs') || '{}') }; } catch { /* défaut */ }
  $('[data-f="sort"]').value = prefs.sort;
  $('[data-f="est"]').checked = prefs.est;
  $('[data-f="shared"]').checked = prefs.shared;
  $('[data-f="lvl"]').value = prefs.lvl;
  $('[data-f="atLvl"]').value = prefs.atLvl;
  let bc = null, bz = null, best = null, bestPp = null;
  try {
    $('[data-k="msg"]').textContent = 'Lecture du bestiaire…';
    bc = await fetchBestiary((t) => { $('[data-k="msg"]').textContent = t; });
    farmUseBestiary(bc);
    bz = bc.zones;
    $('[data-k="msg"]').textContent = '';
  } catch (e) { $('[data-k="msg"]').textContent = `Bestiaire illisible (${e.message}) : pas d’estimation des drops.`; }
  let shown = [];
  const render = () => {
    const log = cfg.farmLog?.[fightAcct()] || [];
    const last = log[log.length - 1];
    const cur = { ...(farmChar() || (last ? { sag: last.sag, pp: last.pp, lvl: last.lvl } : { sag: 0, pp: 100 })) };
    if (+prefs.atLvl > 0) cur.lvl = +prefs.atLvl;
    $('[data-k="cur"]').textContent = `Sagesse ${fmt(cur.sag)} · Prospection ${fmt(cur.pp)}${cur.lvl ? ` · niveau ${cur.lvl}${+prefs.atLvl > 0 ? ' (choisi)' : ''}` : ''}`;
    if (bc && bestPp !== cur.pp) { best = bestiaryMobValue(bc, cur.pp); bestPp = cur.pp; }
    // chaque combat partagé garde son joueur (src) : son bonus d'XP personnel est appris à part
    const shared = prefs.shared ? Object.entries(cfg.farmShared || {}).flatMap(([p, l]) => l.map((r) => ({ ...r, src: p }))) : [];
    const { rows, cycle, dropCal, myMult } = farmRows(log, shared, cfg.wantedScan, best, cur);
    const lvlMax = +prefs.lvl || +prefs.atLvl || 0;   // « XP à mon niveau » sans niveau max : zones au-dessus masquées
    const zoneLvl = (z) => bz?.[z]?.[1];
    for (const r of rows) {
      r.name = r.zn || bz?.[r.z]?.[0] || `Zone ${r.z}`;
      r.xpMin = r.xp != null && r.dur ? r.xp / (r.dur / 60000) : null;
      r.valMin = r.val != null && r.dur ? r.val / (r.dur / 60000) : null;
    }
    shown = rows.filter((r) => (prefs.est || !r.estOnly) && r[prefs.sort] != null && !(lvlMax && zoneLvl(r.z) > lvlMax))
      .sort((a, b) => (b[prefs.sort] || 0) - (a[prefs.sort] || 0)).slice(0, 150);
    const th = 'text-align:left;padding:4px 6px;color:#b9a98c;border-bottom:1px solid #3a3024;position:sticky;top:0;background:#1d1812';
    const td = 'padding:4px 6px;border-bottom:1px solid #2a231a';
    $('[data-k="tbl"]').innerHTML = shown.length ? `<tr><th style="${th}">#</th><th style="${th}">Zone · groupe</th><th style="${th}">Combats</th><th style="${th}">XP / combat</th><th style="${th}">XP / min</th><th style="${th}">Kamas + drops / combat</th><th style="${th}">/ min</th><th style="${th}"></th></tr>`
      + shown.map((r, i) => {
        const e = r.estOnly ? '≈ ' : '';
        const tip = [r.meas && `${r.meas.mine} combat(s) à toi${r.meas.n > r.meas.mine ? ` + ${r.meas.n - r.meas.mine} partagé(s)` : ''}, dernier ${new Date(r.meas.last).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`,
          `moyenne de ${r.comps} composition(s) vue(s) sous ce n° de groupe`,
          r.meas && `moyenne brute mesurée : ${fmt(r.measXp)} XP, ${fmt(r.measVal)} K`,
          r.pen < 1 && `écart de niveau : ×${r.pen.toFixed(2)} de l’XP à ton niveau (déjà compté)`,
          r.dur && `durée type ${Math.round(r.dur / 1000)} s`,
          r.now && `groupe du dernier scan : ${r.now.mons.join(', ')} → ≈ ${fmt(r.now.xp)} XP, ${fmt(r.now.val)} K`].filter(Boolean).join('\n');
        return `<tr title="${esc(tip)}" style="${r.estOnly ? 'color:#b9a98c;font-style:italic' : ''}"><td style="${td}">${i + 1}</td>
          <td style="${td}">${esc(r.name)}${zoneLvl(r.z) != null ? ` <span style="color:#8a7d66">niv. ${bz[r.z][1]}–${bz[r.z][2]}</span>` : ''} · G${r.g}</td>
          <td style="${td}">${r.meas ? `${r.meas.mine}${r.meas.n > r.meas.mine ? ` <span style="color:#7fb2ff">+${r.meas.n - r.meas.mine}</span>` : ''}` : '—'}</td><td style="${td}">${e}${fmt(r.xp)}</td><td style="${td}">${e}${fmt(r.xpMin)}</td>
          <td style="${td}">${e}${fmt(r.val)}</td><td style="${td}">${e}${fmt(r.valMin)}</td>
          <td style="${td}"><button data-farm="${i}" style="${btn};background:#2e7d32" title="Farmer ce groupe (mode chasse, pilote démarré)">▶</button></td></tr>`;
      }).join('')
      : '<tr><td style="color:#b9a98c;padding:8px">Rien à classer : gagne des combats en chasse (ils sont enregistrés automatiquement), ou lance un scan des zones et coche « estimations ».</td></tr>';
    $('[data-k="foot"]').textContent = `${log.length} combat(s) enregistré(s)${shared.length ? ` + ${shared.length} partagé(s)` : ''} · ton bonus d’XP ×${myMult.toFixed(2)} (×2 de base, Discord, événements…)${dropCal !== 1 ? ` · drops du bestiaire × ${dropCal.toFixed(2)} (recalage sur les mesures)` : ''}${cycle ? ` · durée type d’un combat ${Math.round(cycle / 1000)} s` : ''}`
      + `${cfg.wantedScan?.finishedAt ? ` · scan du ${new Date(cfg.wantedScan.finishedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}` : ' · aucun scan'}`;
  };
  render();
  ov.addEventListener('change', (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    prefs[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    try { localStorage.setItem('dmFarmStatsPrefs', JSON.stringify(prefs)); } catch { /* stockage indisponible */ }
    render();
  });
  ov.addEventListener('click', async (e) => {
    if (e.target.closest('[data-a="x"]')) return close();
    const clr = e.target.closest('[data-a="clear"]');
    if (clr) {
      if (!clr.dataset.armed) {
        clr.dataset.armed = '1';
        clr.textContent = '⚠️ Confirmer l’effacement';
        setTimeout(() => { if (clr.isConnected) { delete clr.dataset.armed; clr.textContent = '🗑️ Effacer les mesures'; } }, 5000);
        return;
      }
      const all = { ...(cfg.farmLog || {}) };
      delete all[fightAcct()];
      await save({ farmLog: all });
      delete clr.dataset.armed;
      clr.textContent = '🗑️ Effacer les mesures';
      return render();
    }
    const go = e.target.closest('[data-farm]');
    if (!go) return;
    const r = shown[+go.dataset.farm];
    if (!r) return;
    if (dropOn()) await dropStop('remplacé par ▶ Rentabilité des zones');
    if (sampleOn()) await sampleStop('remplacé par ▶ Rentabilité des zones');
    await save({ mode: 'chasse', huntZone: r.z, huntZoneName: r.name, huntGroup: r.g, huntTarget: null, pauseReason: null, lossStreak: 0 });
    await send({ type: 'claim', start: true, status: 'Démarrage…' }).catch(() => {});
    tradeToast(`▶ Chasse : ${r.name}, groupe ${r.g}`, 'ok');
    close();
  });
}
