// Mise à jour en un clic : télécharge la dernière version depuis GitHub et l'écrit dans le dossier de l'extension
// (File System Access API : l'utilisateur choisit le dossier une fois, le handle est gardé dans IndexedDB),
// puis recharge l'extension. Les réglages sont dans chrome.storage : ils ne sont pas touchés.
const $ = (id) => document.getElementById(id);
const CUR = chrome.runtime.getManifest().version;
const API = `https://api.github.com/repos/${DM.REPO}`;
const OUR_NAMES = /^(Autopilot-DM|DofusMasters Pilote Auto)$/;   // ancien nom accepté (copies d'avant le renommage)
const SRC = 'extension/';   // dossier de l'extension dans le dépôt

// ---------- Handle du dossier, conservé dans IndexedDB ----------
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('autopilot-dm', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const getDir = () => idb('readonly', (s) => s.get('dir')).catch(() => null);
const setDir = (dir) => idb('readwrite', (s) => s.put(dir, 'dir'));

// ---------- Journal à l'écran ----------
let logReset = true;
function log(text, cls = '') {
  if (logReset) { $('log').textContent = ''; logReset = false; }
  const li = document.createElement('li');
  li.textContent = text;
  li.className = cls;
  $('log').appendChild(li);
  return li;
}

// ---------- GitHub ----------
async function gh(path) {
  const r = await DM.fetchT(API + path, { cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } });
  if (r.status === 403 || r.status === 429) throw new Error('limite de requêtes GitHub atteinte : réessaie dans une heure (ou utilise mettre-a-jour.bat)');
  if (!r.ok) throw new Error(`GitHub : HTTP ${r.status}`);
  return r.json();
}
const rawUrl = (sha, path) => `https://raw.githubusercontent.com/${DM.REPO}/${sha}/${path}`;

// Dernier commit de main + version de son manifest (fichiers lus au même commit : jamais un mélange de versions).
async function latest() {
  const { sha } = await gh('/commits/main');
  const r = await DM.fetchT(rawUrl(sha, `${SRC}manifest.json`), { cache: 'no-store' });
  if (!r.ok) throw new Error(`manifest distant : HTTP ${r.status}`);
  return { sha, version: (await r.json()).version };
}

// ---------- Dossier local ----------
async function readManifest(dir) {
  try {
    return JSON.parse(await (await (await dir.getFileHandle('manifest.json')).getFile()).text());
  } catch {
    return null;
  }
}

// Le dossier choisi doit être celui que Chrome a chargé : même nom d'extension et même version.
async function checkFolder(dir) {
  const m = await readManifest(dir);
  if (!m || !OUR_NAMES.test(m.name)) throw new Error(`« ${dir.name} » n’est pas le dossier de l’extension (pas de manifest.json d’Autopilot-DM dedans).`);
  if (m.version !== CUR) {
    throw new Error(`Le dossier « ${dir.name} » contient la version ${m.version}, alors que l’extension chargée est en ${CUR}. `
      + 'Choisis le dossier indiqué dans chrome://extensions → Détails → « Chargée depuis ».');
  }
}

async function access(dir) {
  const o = { mode: 'readwrite' };
  return (await dir.queryPermission(o)) === 'granted' || (await dir.requestPermission(o)) === 'granted';
}

async function pickDir() {
  const dir = await showDirectoryPicker({ id: 'autopilot-dm', mode: 'readwrite', startIn: 'documents' });
  await checkFolder(dir);
  await setDir(dir);
  showFolder(dir);
  return dir;
}

function showFolder(dir) {
  $('folderInfo').textContent = dir ? `Dossier de l’extension : « ${dir.name} »` : 'Dossier de l’extension : pas encore choisi (Chrome le demandera au premier clic).';
}

async function writeFile(root, path, data) {
  const parts = path.split('/');
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(data);
  await w.close();
}

// ---------- Installation ----------
let busy = false;
async function install() {
  if (busy) return;
  busy = true;
  $('go').disabled = $('pick').disabled = true;
  logReset = true;
  try {
    // 1. dossier (+ autorisation d'écriture : doit suivre le clic de près)
    let dir = await getDir();
    if (dir && !(await access(dir))) throw new Error('Autorisation de modifier le dossier refusée.');
    if (dir) {
      try { await checkFolder(dir); } catch (e) { log(`${e.message} Choisis-le à nouveau.`, 'err'); dir = null; }
    }
    if (!dir) {
      log('Choix du dossier de l’extension…');
      dir = await pickDir();
    }
    log(`Dossier : « ${dir.name} » ✔`);

    // 2. version et liste des fichiers au dernier commit
    log('Recherche de la dernière version sur GitHub…');
    const { sha, version } = await latest();
    $('avail').textContent = version;
    if (!DM.isNewer(version, CUR)) { log(`Déjà à jour (version ${CUR}).`, 'ok'); return; }
    const tree = await gh(`/git/trees/${sha}?recursive=1`);
    const files = tree.tree.filter((t) => t.type === 'blob' && t.path.startsWith(SRC)).map((t) => t.path.slice(SRC.length));
    if (!files.includes('manifest.json')) throw new Error('version distante incomplète (pas de manifest.json)');

    // 3. téléchargement complet avant toute écriture
    const line = log(`Téléchargement de ${files.length} fichiers (version ${version})…`);
    const data = {};
    let n = 0;
    await Promise.all(files.map(async (p) => {
      const r = await DM.fetchT(rawUrl(sha, SRC + p), { cache: 'no-store' }, 30000);
      if (!r.ok) throw new Error(`${p} : HTTP ${r.status}`);
      // les .bat doivent rester en fins de ligne Windows (le dépôt les stocke en LF)
      data[p] = /\.(bat|cmd)$/i.test(p) ? (await r.text()).replace(/\r?\n/g, '\r\n') : await r.arrayBuffer();
      line.textContent = `Téléchargement : ${++n}/${files.length}…`;
    }));
    const m = JSON.parse(new TextDecoder().decode(data['manifest.json']));
    if (!OUR_NAMES.test(m.name) || m.version !== version) throw new Error('manifest téléchargé inattendu : mise à jour annulée');

    // 4. écriture (manifest.json en dernier : en cas d'échec, le dossier garde son ancienne version)
    log('Écriture des fichiers…');
    for (const p of files.filter((f) => f !== 'manifest.json')) await writeFile(dir, p, data[p]);
    await writeFile(dir, 'manifest.json', data['manifest.json']);
    DM.log(`mise à jour : ${CUR} → ${version} installée depuis GitHub`);
    log(`Version ${version} installée ✔ — rechargement de l’extension…`, 'ok');
    log('Les onglets du jeu ouverts vont se recharger tout seuls.', 'muted');
    setTimeout(() => chrome.runtime.sendMessage({ type: 'reloadExtension' }), 1500);
  } catch (e) {
    if (e.name === 'AbortError') log('Choix du dossier annulé.', 'err');
    else log(`❌ ${e.message}`, 'err');
  } finally {
    busy = false;
    $('go').disabled = $('pick').disabled = false;
  }
}

$('go').onclick = install;
$('pick').onclick = async () => {
  logReset = true;
  try {
    const dir = await pickDir();
    log(`Dossier « ${dir.name} » enregistré ✔`, 'ok');
  } catch (e) {
    log(e.name === 'AbortError' ? 'Choix du dossier annulé.' : `❌ ${e.message}`, 'err');
  }
};

(async () => {
  DM.installTips(document);
  $('cur').textContent = CUR;
  showFolder(await getDir());
  try {
    const { version } = await latest();
    $('avail').textContent = version;
    await chrome.storage.local.set({ updateVersion: version, updateCheckedAt: Date.now() });
    const newer = DM.isNewer(version, CUR);
    $('go').disabled = !newer;
    if (!newer) $('go').textContent = '✔ Déjà à jour';
  } catch (e) {
    $('avail').textContent = '?';
    log(`❌ ${e.message}`, 'err');
  }
})();
