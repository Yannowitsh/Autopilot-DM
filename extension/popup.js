const $ = (id) => document.getElementById(id);
const NUM = ['minEnergy', 'resumeEnergy', 'delayMin', 'delayMax', 'fastFightMinSec', 'huntRetries', 'errorReloadSec', 'reloadGapSec', 'updateCheckMin'];
const BOOL = ['sellKeepAbove', 'bossAuto', 'fastFight'];

async function render() {
  const s = await DM.getAll();
  const t = $('toggle');
  const what = DM.modeLabel(s);
  t.textContent = s.enabled ? (s.paused ? '⏸ EN PAUSE — cliquer pour arrêter' : `■ ACTIF (${what}) — cliquer pour arrêter`) : `▶ Démarrer (${what})`;
  t.style.background = s.enabled ? (s.paused ? 'var(--pause)' : 'var(--on)') : 'var(--off)';
  $('status').textContent = s.status || '—';
  const upd = DM.pendingUpdate(s);
  $('update').hidden = !upd;
  $('updateVersion').textContent = upd || '';
  $('energy').textContent = s.energy != null ? `${s.energy}/${s.energyMax} (${DM.hhmm(s.energyAt)})` : '—';
  $('stats').textContent = `${s.wins || 0} / ${s.losses || 0}`;
  const b = DM.bossStatus(s.bossInfo);
  const name = b.name || 'Boss';
  $('boss').textContent = b.active ? `${name} : là jusqu'à ${DM.hhmm(b.endsAt)}` : `${name} à ${DM.hhmm(b.nextAt)}`;
}

function renderZones(zones, selected) {
  const sel = $('huntZone');
  sel.innerHTML = '';
  if (selected && !zones.some((z) => z.id === selected.id)) zones = [selected, ...zones];
  for (const z of zones) sel.add(new Option(z.label || z.name, z.id, false, z.id === selected?.id));
}

async function loadZones(force) {
  const s = await DM.getAll();
  const selected = s.huntZone ? { id: s.huntZone, name: s.huntZoneName } : null;
  if (s.huntZones?.length && !force) return renderZones(s.huntZones, selected);
  try {
    renderZones(await DM.fetchZones(), selected);
  } catch (e) {
    renderZones(s.huntZones || [], selected);
    $('msg').textContent = `Zones de chasse : ${e.message}`;
  }
}

const syncMode = () => { $('zoneRow').style.display = $('mode').value === 'chasse' ? '' : 'none'; };

async function loadForm() {
  const s = await DM.getAll();
  $('webhookUrl').value = s.webhookUrl;
  for (const k of NUM) $(k).value = s[k];
  for (const k of BOOL) $(k).checked = !!s[k];
  $('autoBuyEnergy').checked = !!s.autoBuyEnergy;
  $('mode').value = s.mode;
  syncMode();
  await loadZones(false);
}

async function saveForm() {
  const o = { webhookUrl: $('webhookUrl').value.trim() };
  o.mode = $('mode').value;
  const zoneOpt = $('huntZone').selectedOptions[0];
  if (zoneOpt) {
    o.huntZone = +zoneOpt.value;
    o.huntZoneName = zoneOpt.text.replace(/\s*\(\d+–\d+\)$/, '');
    const prev = await DM.getAll();
    if (o.huntZone !== prev.huntZone) o.huntGroup = null;   // autre zone : retour au groupe le plus dur
  }
  if (o.mode === 'chasse' && !o.huntZone) { $('msg').textContent = 'Choisis une zone de chasse.'; return; }
  for (const k of NUM) o[k] = Math.max(0, Number($(k).value) || 0);
  for (const k of BOOL) o[k] = $(k).checked;
  if (o.delayMax < o.delayMin) o.delayMax = o.delayMin;
  await chrome.storage.local.set(o);
  $('msg').textContent = 'Réglages enregistrés.';
}

$('toggle').onclick = async () => { await chrome.runtime.sendMessage({ type: 'toggle' }); render(); };
$('save').onclick = saveForm;
$('autoBuyEnergy').onchange = () => chrome.storage.local.set({ autoBuyEnergy: $('autoBuyEnergy').checked, buyNextTry: 0 });
$('mode').onchange = syncMode;
$('reloadZones').onclick = () => loadZones(true);
$('test').onclick = async () => {
  await saveForm();
  const r = await chrome.runtime.sendMessage({ type: 'discord', text: '✅ Test du pilote auto DofusMasters : les alertes fonctionnent.' });
  $('msg').textContent = r?.ok ? 'Message envoyé sur Discord ✔' : `Échec : ${r?.error}`;
};
$('resume').onclick = async () => {
  await chrome.storage.local.set({ pauseReason: null, paused: false });
  $('msg').textContent = 'Pause levée.';
};
let sellArmed = false;
// Enregistré tout de suite (pas besoin de « Enregistrer ») ; annule une confirmation de vente en attente.
const disarmSell = () => {
  sellArmed = false;
  $('autosell').textContent = '🧹 Autosell';
  $('autosell').style.background = '';
  $('sellMsg').textContent = '';
};
$('sellKeepAbove').onchange = async () => {
  await chrome.storage.local.set({ sellKeepAbove: $('sellKeepAbove').checked });
  disarmSell();
};
// Raretés conservées par l'Autosell : une case par rareté, enregistrée tout de suite.
async function renderRarities() {
  const keep = (await DM.getAll()).sellKeepRarities || [];
  const box = $('rars');
  box.innerHTML = '';
  DM.RARITIES.forEach((name, i) => {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = keep.includes(i);
    cb.onchange = async () => {
      const sel = [...box.querySelectorAll('input')].map((c, j) => c.checked && j).filter((j) => j !== false);
      await chrome.storage.local.set({ sellKeepRarities: sel });
      disarmSell();
    };
    const lab = document.createElement('label');
    lab.append(name, cb);
    box.append(lab);
  });
}
renderRarities();
$('autosell').onclick = async () => {
  const btn = $('autosell');
  btn.disabled = true;
  try {
    if (!sellArmed) {
      $('sellMsg').textContent = 'Calcul…';
      const r = await chrome.runtime.sendMessage({ type: 'autosell', dryRun: true });
      if (!r?.ok) { $('sellMsg').textContent = `Échec : ${r?.error}`; return; }
      if (!r.count) { $('sellMsg').textContent = `Rien à vendre. ${DM.keptSummary(r)}`; return; }
      sellArmed = true;
      btn.textContent = `⚠️ Confirmer : ${r.count} objets (~${r.estimate.toLocaleString('fr-FR')} K)`;
      btn.style.background = 'var(--pause)';
      $('sellMsg').textContent = DM.keptSummary(r);
    } else {
      sellArmed = false;
      btn.textContent = '🧹 Autosell';
      btn.style.background = '';
      $('sellMsg').textContent = 'Vente en cours…';
      const r = await chrome.runtime.sendMessage({ type: 'autosell', dryRun: false });
      $('sellMsg').textContent = r?.ok ? `✔ ${r.count} objets vendus : +${r.kamas.toLocaleString('fr-FR')} kamas` : `Échec : ${r?.error}`;
    }
  } finally {
    btn.disabled = false;
  }
};
$('reset').onclick =async () => { await chrome.storage.local.set({ wins: 0, losses: 0 }); render(); };

// Notifications Discord : une case par type (DM.NOTIF), enregistrée immédiatement.
async function renderNotifs() {
  const s = await DM.getAll();
  const box = $('notifs');
  box.textContent = '';
  for (const n of DM.NOTIF) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = s[n.key] !== false;
    cb.onchange = () => chrome.storage.local.set({ [n.key]: cb.checked });
    const text = document.createElement('span');
    text.innerHTML = DM.tip(n.tip);
    text.prepend(n.label);
    label.append(text, cb);
    box.appendChild(label);
  }
  $('bossPreAlertMin').value = s.bossPreAlertMin;
}
$('bossPreAlertMin').onchange = () => chrome.storage.local.set({ bossPreAlertMin: Math.max(0, Number($('bossPreAlertMin').value) || 0) });
renderNotifs();

chrome.storage.onChanged.addListener(render);
chrome.runtime.sendMessage({ type: 'refreshBoss' }).then(render);
chrome.runtime.sendMessage({ type: 'checkUpdate' }).then(render);
DM.installTips(document);
$('version').textContent = `v${chrome.runtime.getManifest().version}`;
$('checkNow').onclick = async () => {
  $('msg').textContent = 'Vérification…';
  await chrome.runtime.sendMessage({ type: 'checkUpdate', force: true });
  const upd = DM.pendingUpdate(await DM.getAll());
  $('msg').textContent = upd ? `🆕 Version ${upd} disponible (voir en haut).` : `À jour (v${chrome.runtime.getManifest().version}).`;
};
$('installUpdate').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('update.html') });
$('openRepo').onclick = () => chrome.tabs.create({ url: DM.REPO_URL });
loadForm();
render();

// ---------- Journal de débogage ----------
async function renderLog() {
  const { debugLog = [] } = await chrome.storage.local.get('debugLog');
  $('logInfo').textContent = debugLog.length ? `${debugLog.length} ligne(s), dernière : ${debugLog.at(-1).slice(0, 60)}…` : 'Vide.';
}
$('logCopy').onclick = async () => {
  const { debugLog = [] } = await chrome.storage.local.get('debugLog');
  const s = await DM.getAll();
  // contexte utile, sans le webhook Discord ni le journal lui-même
  const { webhookUrl, debugLog: _, huntZones, wantedScan, lockedItems, tradeQueues, tradeHistory, tradeLastRun, ...state } = s;
  await navigator.clipboard.writeText(`version ${chrome.runtime.getManifest().version}\nétat ${JSON.stringify(state)}\n\n${debugLog.join('\n')}`);
  $('logInfo').textContent = `Copié (${debugLog.length} lignes) : colle-le dans la discussion.`;
};
$('logClear').onclick = async () => { await chrome.storage.local.set({ debugLog: [] }); renderLog(); };
renderLog();
