// Code partagé entre le service worker, le content script et la popup.
const DM = {
  ORIGIN: 'https://dofusmasters.houk.fr',

  // Mises à jour : le manifest du dépôt GitHub public fait foi (vérifié toutes les `updateCheckMin` minutes).
  REPO: 'Yannowitsh/Autopilot-DM',
  get UPDATE_MANIFEST() { return `https://raw.githubusercontent.com/${DM.REPO}/main/extension/manifest.json`; },
  get REPO_URL() { return `https://github.com/${DM.REPO}`; },
  // « 1.32.0 » > « 1.31.4 » ?
  isNewer(a, b) {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    }
    return false;
  },
  // Version plus récente disponible sur GitHub (null si à jour).
  pendingUpdate(s) {
    const v = s.updateVersion;
    return v && DM.isNewer(v, chrome.runtime.getManifest().version) ? v : null;
  },

  DEFAULTS: {
    enabled: false,
    webhookUrl: '',
    minEnergy: 5,        // pause sous ce seuil
    resumeEnergy: 20,    // reprise à partir de ce seuil
    autoBuyEnergy: false, // dès 20 d'énergie ou moins : rachète l'énergie au max (kamas), le farm ne s'arrête pas
    delayMin: 3,         // secondes entre deux combats
    delayMax: 8,
    fastFight: false,    // combat rapide : dès que le serveur a renvoyé le résultat, rechargement (pas d'animation)
    fastFightMinSec: 5,  // combat rapide : au moins N s entre deux lancements de combat
    huntRetries: 3,      // chasse (avis de recherche…) : nouveaux essais après une défaite avant arrêt
    errorReloadSec: 5,   // page d'erreur du site (508 « Resource Limit Is Reached », 5xx…) : rechargée après N s
    reloadGapSec: 30,    // anti-blocage : au plus un rechargement toutes les N s
    bossAlerts: true,    // alerte Discord quand le boss de chasse apparaît (indépendant du ON/OFF)
    notifyWanted: true,  // notifications Discord par type (voir DM.NOTIF)
    notifyDefeat: true,
    notifyEnergy: true,
    notifyErrors: true,
    wantedMinPerGroup: 1, // avis de recherche : nb minimum de monstres recherchés dans le même groupe
    bossPreAlertMin: 0,  // pré-alerte N minutes avant (0 = désactivé)
    bossAuto: true,      // pilote actif : tente le boss de chasse dans un nouvel onglet à son apparition, puis reprend le farm
    sellKeepAbove: true, // Autosell : garde les objets d'un niveau supérieur au personnage
    sellKeepRarities: [4, 5], // Autosell : raretés jamais vendues (indices de DM.RARITIES)
    mode: 'aventure',    // 'aventure' (Chemin), 'chasse' (groupe le plus dur d'une zone en boucle) ou 'ascension' (niv. 200)
    huntZone: null,      // id de zone (/chasse?zone=…)
    huntGroup: null,     // n° de groupe choisi à la main en jeu (null = le plus dur)
    huntZoneName: '',
    updateCheckMin: 180, // vérification d'une nouvelle version sur GitHub, en minutes (0 = jamais automatiquement)
    wins: 0,
    losses: 0,
  },

  // Raretés du jeu : champ « r » des objets (0 = Commun … 5 = Légendaire), même ordre que le filtre de /inventaire.
  RARITIES: ['Commun', 'Peu commun', 'Rare', 'Épique', 'Mythique', 'Légendaire'],

  // Types de notifications Discord, activables un par un dans la popup (clé = réglage dans le stockage).
  NOTIF: [
    { kind: 'wanted', key: 'notifyWanted', label: '🎯 Avis de recherche trouvés',
      tip: 'Message dès que le scan des zones trouve un groupe contenant un monstre recherché, avec un lien « attaque directe ».' },
    { kind: 'boss', key: 'bossAlerts', label: '🐉 Boss de chasse (apparition)',
      tip: 'Message quand le boss de zone apparaît (et la pré-alerte si elle est réglée). Fonctionne même pilote arrêté.' },
    { kind: 'defeat', key: 'notifyDefeat', label: '❌ Combat perdu (pilote arrêté)',
      tip: 'Message quand le pilote s’arrête après une défaite : immédiatement en chasse, après plusieurs défaites d’affilée en aventure.' },
    { kind: 'energy', key: 'notifyEnergy', label: '🔋 Énergie basse / reprise',
      tip: 'Message quand le pilote se met en pause faute d’énergie, puis quand il reprend.' },
    { kind: 'errors', key: 'notifyErrors', label: '⚠️ Problèmes (déconnexion, énergie illisible)',
      tip: 'Message en cas de souci technique : déconnexion du jeu, énergie impossible à lire, etc.' },
  ],

  // Valeurs observées : un boss toutes les 20 min, calé sur l'heure (xx:00, xx:20, xx:40), présent 5 min.
  BOSS_FALLBACK: { anchor: 0, period: 20 * 60000, duration: 5 * 60000, name: null },

  // Extrait les infos du boss de zone depuis le HTML de /chasse (HTML SSR + payload RSC échappé).
  parseBossInfo(html) {
    const s = html.replace(/\\"/g, '"');
    const start = s.search(/boss de zone/i);
    if (start < 0) return null;
    const zone = s.slice(Math.max(0, start - 3000), start + 6000);
    const info = { ...DM.BOSS_FALLBACK };

    const pd = s.match(/toutes les\D{0,40}?(\d+)\D{0,40}?minutes et reste\D{0,40}?(\d+)/);
    if (pd) { info.period = +pd[1] * 60000; info.duration = +pd[2] * 60000; }

    const name = zone.match(/title text-xl leading-tight"\s*,\s*"children"\s*:\s*"([^"]+)"/)
      || zone.match(/class="title text-xl leading-tight"[^>]*>([^<]+)</);
    if (name) info.name = name[1];

    let found = false;
    for (const m of zone.matchAll(/"to"\s*:\s*(\d{12,14})\s*,\s*"prefix"\s*:\s*"([^"]*)"/g)) {
      const to = +m[1];
      info.anchor = /arrive/i.test(m[2]) ? to : to - info.duration;
      info.timerPrefix = m[2];
      found = true;
      break;
    }
    info.parsedTimer = found;
    return info;
  },

  // État du boss à l'instant `now` : actif ? apparu quand ? part quand ? prochain quand ?
  bossStatus(info, now = Date.now()) {
    const b = { ...DM.BOSS_FALLBACK, ...(info || {}) };
    const cur = b.anchor + Math.floor((now - b.anchor) / b.period) * b.period;
    const active = now - cur < b.duration;
    return { active, spawnAt: cur, endsAt: cur + b.duration, nextAt: cur + b.period, name: b.name, duration: b.duration };
  },

  // fetch avec délai maximal : une requête qui ne répond jamais ne doit pas bloquer le pilote.
  // Journal de débogage partagé (stockage local, LOG_MAX dernières lignes), copiable depuis la popup.
  LOG_MAX: 400,
  async log(...parts) {
    const t = new Date().toLocaleTimeString('fr-FR');
    const line = `${t} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
    console.info('[Pilote auto]', line);
    // écritures en file : deux lignes rapprochées ne s'écrasent pas (lecture → ajout → écriture)
    DM.logQueue = (DM.logQueue || Promise.resolve()).then(async () => {
      try {
        const { debugLog = [] } = await chrome.storage.local.get('debugLog');
        debugLog.push(line);
        await chrome.storage.local.set({ debugLog: debugLog.slice(-DM.LOG_MAX) });
      } catch { /* contexte d'extension invalidé */ }
    });
    return DM.logQueue;
  },

  // ---------- Bulles d'information au survol ----------
  // Tout élément [data-tip] affiche une bulle explicative au survol ; DM.tip(texte) produit une pastille « i » à insérer.
  // root : document ou shadow root à surveiller ; la bulle est en position fixe, recadrée dans la fenêtre.
  tipAttr: (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  tip(text) {
    return `<span class="dm-i" data-tip="${DM.tipAttr(text)}">i</span>`;
  },
  installTips(root = document) {
    const mount = root === document ? document.body : root;
    if (!mount || mount.querySelector?.(':scope > .dm-tip')) return;
    const style = document.createElement('style');
    style.className = 'dm-tip-style';
    style.textContent = `
      .dm-i { display: inline-grid; place-items: center; width: 14px; height: 14px; margin-left: 5px; border-radius: 50%;
        background: #3a3f48; color: #cfd3d8; font: italic 700 10px/1 Georgia, serif; cursor: help; vertical-align: middle;
        flex: none; user-select: none; }
      .dm-i:hover { background: #2b5d8a; color: #fff; }
      .dm-tip { position: fixed; z-index: 2147483647; max-width: 260px; padding: 7px 9px; border-radius: 8px;
        background: #0f1114; color: #e8e6e1; border: 1px solid #3a3f48; box-shadow: 0 4px 14px rgba(0,0,0,.6);
        font: 12px/1.4 system-ui, sans-serif; white-space: pre-line; pointer-events: none; display: none; text-align: left; }`;
    const tip = document.createElement('div');
    tip.className = 'dm-tip';
    mount.append(style, tip);
    const show = (el) => {
      tip.textContent = el.dataset.tip;
      tip.style.display = 'block';
      const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
      const x = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 6));
      let y = r.bottom + 6;
      if (y + h > innerHeight - 6) y = Math.max(6, r.top - h - 6);   // pas la place dessous : au-dessus
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    };
    root.addEventListener('mouseover', (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (el) show(el); else tip.style.display = 'none';
    });
    root.addEventListener('mouseout', (e) => { if (!e.relatedTarget?.closest?.('[data-tip]')) tip.style.display = 'none'; });
    root.addEventListener('scroll', () => { tip.style.display = 'none'; }, true);
    // clic sur la pastille « i » dans un <label> / <summary> : ne coche rien, n'ouvre rien
    root.addEventListener('click', (e) => { if (e.target.closest?.('.dm-i')) e.preventDefault(); }, true);
  },

  fetchT(url, opts = {}, ms = 20000) {
    return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  },

  // Résumé de ce que l'Autosell conserve, à partir du résultat d'un aperçu.
  keptSummary(r) {
    const parts = [
      r.aboveCount && `${r.aboveCount} au-dessus du niv. ${r.level}`,
      r.lockedCount && `${r.lockedCount} verrouillé(s)`,
      r.slotCount && `${r.slotCount} familier(s)/dofus`,
      r.rarityCount && `${r.rarityCount} par rareté`,
      r.skipped && `${r.skipped} Rayonnant(s)`,
    ].filter(Boolean);
    return parts.length ? `Conservés : ${parts.join(' · ')}.` : '';
  },

  // Clé d'un objet verrouillé (protégé de l'Autosell).
  lockKey(name, lvl) {
    return `${String(name).trim().toLowerCase()}|${lvl || 0}`;
  },

  // Page de départ du pilote selon le mode.
  homePath(s) {
    if (s.mode === 'ascension') return '/ascension';
    return s.mode === 'chasse' && s.huntZone ? `/chasse?zone=${s.huntZone}` : '/aventure';
  },

  // Libellé court de l'activité du pilote (bouton Démarrer…).
  modeLabel(s) {
    if (s.mode === 'ascension') return 'ascension';
    return s.mode === 'chasse' && s.huntZone ? `chasse : ${s.huntZoneName || 'zone ' + s.huntZone}${s.huntGroup ? ` · G${s.huntGroup}` : ''}` : 'aventure';
  },

  // Liste des zones de chasse lue sur /chasse.
  // all = false : zones proposées à ton niveau, gardées en cache pour le choix de zone ;
  // all = true  : toutes les zones du jeu (~220), pour le scan des avis de recherche.
  // v2 du site : composant ZoneBrowser, props { level, mine: [ids à ton niveau], zones: [{ id, n, area, min, max }] }
  // dans le payload RSC (la page n'affiche qu'une partie des zones). Sinon, liens « /chasse?zone=… » de la page.
  // Utilise DOMParser : popup ou content script uniquement (pas le service worker).
  async fetchZones({ all = false } = {}) {
    const r = await DM.fetchT(DM.ORIGIN + '/chasse', { credentials: 'include', cache: 'no-store' });
    if (r.redirected && /connexion/.test(r.url)) throw new Error('déconnecté');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const browser = DM.zoneBrowserProps(html);
    if (browser) {
      const mid = (z) => (z.min + z.max) / 2;
      const mine = new Set(browser.mine || []);
      const list = all ? browser.zones
        : browser.zones.filter((z) => mine.has(z.id)).sort((a, b) => Math.abs(mid(a) - browser.level) - Math.abs(mid(b) - browser.level));
      const zones = list.map((z) => ({ id: z.id, name: z.n, region: z.area || '', lvlMin: z.min ?? null, lvlMax: z.max ?? null,
        label: z.min != null ? `${z.n} (${z.min}–${z.max})` : z.n }));
      if (zones.length) {
        if (!all) await chrome.storage.local.set({ huntZones: zones });
        return zones;
      }
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const zones = [];
    for (const a of doc.querySelectorAll('a[href*="/chasse?zone="]')) {
      const id = +new URL(a.getAttribute('href'), DM.ORIGIN).searchParams.get('zone');
      if (!id || zones.some((z) => z.id === id)) continue;
      const name = a.querySelector('.font-bold')?.textContent.trim() || `Zone ${id}`;
      const region = a.querySelector('.text-dim')?.textContent.trim() || '';
      const lvl = a.textContent.match(/Niveau\s*(\d+)\s*–\s*(\d+)/);
      zones.push({ id, name, region, lvlMin: lvl ? +lvl[1] : null, lvlMax: lvl ? +lvl[2] : null, label: lvl ? `${name} (${lvl[1]}–${lvl[2]})` : name });
    }
    if (!zones.length) throw new Error('aucune zone trouvée');
    if (!all) await chrome.storage.local.set({ huntZones: zones });
    return zones;
  },

  // Props du ZoneBrowser de /chasse (objet contenant "mine" et "zones") lues dans le payload RSC de la page, ou null.
  zoneBrowserProps(html) {
    let flight = '';
    for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
      try { flight += JSON.parse(m[1]); } catch { /* morceau illisible */ }
    }
    const start = flight.search(/\{"level":\d+,"mine":\[/);
    if (start < 0) return null;
    // fin de l'objet : accolades équilibrées, hors chaînes
    let depth = 0, inStr = false;
    for (let i = start; i < flight.length; i++) {
      const c = flight[i];
      if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if ((c === '}' || c === ']') && --depth === 0) {
        try {
          const p = JSON.parse(flight.slice(start, i + 1));
          return Array.isArray(p.zones) ? p : null;
        } catch { return null; }
      }
    }
    return null;
  },

  hhmm(ts) {
    return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  },

  async getAll() {
    return Object.assign({}, DM.DEFAULTS, await chrome.storage.local.get(null));
  },
};
