// Autopilot-DM — content script : menus auto-équipement et fusion.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- Auto-équipement (menu) ----------
let equipBusy = false, eqPlanState = null, eqState = null, eqMsg = '', eqMsgCls = '';
const setEqMsg = (text, cls = '') => { eqMsg = text; eqMsgCls = cls; renderUi(); };
const equipStats = () => [...(cfg.equipStats || []), '', '', '', '', ''].slice(0, 5);
const equipEnabled = () => cfg.equipSlots || {};
const statShort = (k) => STAT_LABELS[k] || k;

async function previewEquip() {
  if (equipBusy) return;
  equipBusy = true;
  setEqMsg('Lecture de l’inventaire…');
  try {
    eqState = await fetchEquipState();
    eqPlanState = equipPlan(eqState, equipStats(), equipEnabled());
    const n = eqPlanState.changes.length;
    setEqMsg(n ? `${n} objet(s) à changer, ${eqPlanState.unchanged} déjà optimal(aux).` : 'Ton équipement est déjà le meilleur pour ces caractéristiques ✔', n ? '' : 'ok');
  } catch (e) {
    eqPlanState = null;
    setEqMsg(`❌ ${e.message}`, 'err');
  } finally {
    equipBusy = false;
    renderUi();
  }
}

async function applyEquip() {
  if (equipBusy) return;
  equipBusy = true;
  setEqMsg('Recalcul…');
  let done = 0;
  try {
    eqState = await fetchEquipState();   // inventaire peut-être changé depuis l'aperçu
    const plan = equipPlan(eqState, equipStats(), equipEnabled());
    eqPlanState = plan;
    if (!plan.changes.length) { setEqMsg('Rien à changer : équipement déjà optimal ✔', 'ok'); return; }
    done = await runEquip(plan, eqState.chunks, (i, total, c) => setEqMsg(`Équipement ${i}/${total} : ${c.to.name}…`));
    setEqMsg(`✔ ${done} objet(s) équipé(s).`, 'ok');
    eqPlanState = null;
  } catch (e) {
    setEqMsg(`❌ ${done ? `${done} équipé(s), puis : ` : ''}${e.message}`, 'err');
  } finally {
    equipBusy = false;
    renderUi();
    if (done && location.pathname.startsWith('/inventaire')) setTimeout(() => location.reload(), 1500);
  }
}

// ---------- Auto-équipement automatique (Off / Semi / Auto) ----------
// Toutes les cfg.equipCheckMin minutes (popup → Réglages, 3 par défaut), on recalcule le meilleur équipement (mêmes stats et emplacements que le menu).
// Auto : équipe directement. Semi : fenêtre de proposition, avec l'écart de stats ; « Non » = objet jamais reproposé
// (cfg.equipDeclined, par personnage : le stockage est commun aux deux comptes). Jamais pendant un combat ni sur /inventaire.
const equipCheckMs = () => Math.max(0.5, +cfg.equipCheckMin || 3) * 60000;
const EQUIP_SNOOZE_MS = 30 * 60000;   // proposition fermée (✕) : pas reproposée avant 30 min
let eqTimer = null, eqAutoBusy = false, eqAsk = null;
const eqSnooze = new Map();           // changement (emplacement > objet) → fermé à
const eqAcct = () => myName() || (chrome.extension?.inIncognitoContext ? 'privé' : 'normal');
const eqDeclined = () => new Set(cfg.equipDeclined?.[eqAcct()] || []);
const eqChangeKey = (c) => `${c.slot}>${eqItemKey(c.to)}`;
const statIdx = (k) => { const i = STAT_ORDER.indexOf(k); return i < 0 ? 999 : i; };

// Écart complet de stats (toutes les caractéristiques). Arme à deux mains : le bouclier retiré compte comme une perte.
function fullDiff(c, state) {
  const before = { ...(c.from?.eff || {}) };
  const shield = c.slot === 'arme' && c.to.two && !c.from?.two && state.slots.find((s) => s.slot === 'bouclier')?.cur;
  if (shield) for (const [k, v] of Object.entries(shield.eff)) before[k] = (before[k] || 0) + v;
  const keys = new Set([...Object.keys(before), ...Object.keys(c.to.eff)]);
  const diff = [...keys].map((k) => [k, (c.to.eff[k] || 0) - (before[k] || 0)]).filter(([, d]) => d)
    .sort((a, b) => statIdx(a[0]) - statIdx(b[0]));
  return { diff, shield };
}

async function autoEquipTick(force = false) {
  const mode = cfg.equipAuto || 'off';
  if (dead || mode === 'off' || !modOn('equip') || eqAutoBusy || equipBusy || !equipStats()[0] || eqAsk?.host.isConnected) return;
  const path = location.pathname;
  if (/^\/(inventaire|connexion)/.test(path) || (path.startsWith('/combat') && !endTitle())) return;
  if (!isOwner() && document.visibilityState !== 'visible') return;   // onglet du pilote, ou onglet affiché
  const acct = eqAcct(), now = Date.now();
  if (!force && now - (cfg.equipCheckAt?.[acct] || 0) < equipCheckMs()) return;
  eqAutoBusy = true;
  try {
    await save({ equipCheckAt: { ...(cfg.equipCheckAt || {}), [acct]: now } });
    const state = await fetchEquipState();
    const plan = equipPlan(state, equipStats(), equipEnabled(), eqDeclined());
    if (!plan.changes.length) return;
    if (mode === 'auto') {
      let done = 0;
      try {
        done = await runEquip(plan, state.chunks, (i) => { done = i; });
      } finally {
        const names = plan.changes.slice(0, done).map((c) => itemLabel(c.to));
        if (names.length) tradeToast(`🛡️ Auto-équipement : ${names.join(', ')}`, 'ok');
        eqState = null; eqPlanState = null;
        renderUi();
      }
      return;
    }
    const fresh = plan.changes.filter((c) => now - (eqSnooze.get(eqChangeKey(c)) || 0) > EQUIP_SNOOZE_MS);
    if (fresh.length && !eqAsk?.host.isConnected) showEquipAsk(plan, state);
  } catch (e) {
    DM.log(`auto-équipement : ${e.message || e}`);
  } finally {
    eqAutoBusy = false;
  }
}

const ASK_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, sans-serif; }
  .box { position: fixed; right: 12px; top: 12px; z-index: 2147483646; width: 360px; max-width: calc(100vw - 24px);
    max-height: calc(100vh - 24px); overflow-y: auto; background: #1b1d22; color: #e8e6e1; border: 1px solid #2e6fbf;
    border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.55); font-size: 12px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .top { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 800; }
  .x { margin-left: auto; background: none; border: 0; color: #9aa0a8; cursor: pointer; font-size: 15px; }
  .muted { color: #9aa0a8; font-weight: 400; font-size: 11px; }
  .row { background: #262a31; border: 1px solid #3a3f48; border-radius: 8px; padding: 7px; display: flex; flex-direction: column; gap: 5px; }
  .items { display: flex; align-items: center; gap: 6px; }
  .it { flex: 1; display: flex; align-items: center; gap: 5px; min-width: 0; }
  .it img { width: 30px; height: 30px; object-fit: contain; flex: none; }
  .it span { overflow: hidden; text-overflow: ellipsis; }
  .it.to { font-weight: 700; }
  .slot { font-weight: 800; color: #8fb8ee; }
  .diff { display: flex; flex-wrap: wrap; gap: 3px 8px; }
  .up { color: #6fcf7a; } .down { color: #ff7b6b; } .main { font-weight: 800; text-decoration: underline; }
  .btns { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  button.b { border: 0; border-radius: 6px; padding: 6px; color: #fff; font-weight: 700; cursor: pointer; background: #3a3f48; }
  button.b.yes { background: #2e7d32; } button.b.no { background: #8a3a32; }
  button.b:disabled { opacity: .5; cursor: default; }
  .res { font-weight: 700; } .res.ok { color: #6fcf7a; } .res.err { color: #ff7b6b; }
`;

function showEquipAsk(plan, state) {
  if (!document.body) return;
  eqAsk?.host.remove();
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const icon = (it) => (it?.icon ? `<img src="/img/items/${+it.icon}.png" alt="">` : '');
  const host = document.createElement('div');
  host.id = 'dm-equip-ask';
  const root = host.attachShadow({ mode: 'open' });
  const chosen = new Set(plan.stats);
  const rows = plan.changes.map((c, i) => {
    const { diff, shield } = fullDiff(c, state);
    const d = diff.map(([k, v]) => `<span class="${v > 0 ? 'up' : 'down'}${chosen.has(k) ? ' main' : ''}">${v > 0 ? '+' : ''}${v} ${esc(statShort(k))}</span>`).join('');
    return `<div class="row" data-i="${i}">
      <div><span class="slot">${esc(c.label)}</span>${c.to.lvl ? ` <span class="muted">niv. ${+c.to.lvl}</span>` : ''}</div>
      <div class="items">
        <div class="it">${icon(c.from)}<span>${c.from ? esc(itemLabel(c.from)) : '<i class="muted">vide</i>'}</span></div>
        <span>→</span>
        <div class="it to">${icon(c.to)}<span>${esc(itemLabel(c.to))}</span></div>
      </div>
      ${shield ? `<div class="muted">Arme à deux mains : retire aussi ${esc(itemLabel(shield))}</div>` : ''}
      <div class="diff">${d || '<span class="muted">aucun écart de stats</span>'}</div>
      <div class="btns"><button class="b yes" data-a="yes">✔ Équiper</button><button class="b no" data-a="no">✖ Non, ne plus proposer</button></div>
    </div>`;
  }).join('');
  root.innerHTML = `<style>${ASK_CSS}</style><div class="box">
    <div class="top">🛡️ Nouveaux objets à équiper<button class="x" data-a="close" title="Plus tard (reproposé dans 30 min)">✕</button></div>
    <div class="muted">Selon tes caractéristiques ${plan.stats.map((k) => `<b>${esc(statShort(k))}</b>`).join(', ')} (soulignées ci-dessous).</div>
    ${rows}</div>`;
  document.body.appendChild(host);
  eqAsk = { host };
  const pending = new Set(plan.changes.map((_, i) => i));
  const close = () => {
    for (const i of pending) eqSnooze.set(eqChangeKey(plan.changes[i]), Date.now());
    host.remove();
    if (eqAsk?.host === host) eqAsk = null;
  };
  const answered = (i) => { pending.delete(i); if (!pending.size) setTimeout(close, 1500); };
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b || b.disabled) return;
    if (b.dataset.a === 'close') return close();
    const row = b.closest('.row');
    const i = +row.dataset.i, c = plan.changes[i];
    const done = (text, cls) => { row.querySelector('.btns').outerHTML = `<div class="res ${cls}">${esc(text)}</div>`; };
    if (b.dataset.a === 'no') {
      const acct = eqAcct();
      const list = [...new Set([...(cfg.equipDeclined?.[acct] || []), eqItemKey(c.to)])];
      await save({ equipDeclined: { ...(cfg.equipDeclined || {}), [acct]: list } });
      done('Refusé : ne sera plus proposé', 'err');
      renderUi();
      return answered(i);
    }
    if (equipBusy || eqAutoBusy) return;
    row.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    eqAutoBusy = true;
    try {
      await runEquip({ changes: [c], stats: plan.stats }, state.chunks);
      done('✔ Équipé', 'ok');
      eqState = null; eqPlanState = null;
      renderUi();
    } catch (err) {
      done(`❌ ${err.message || err}`, 'err');
    } finally {
      eqAutoBusy = false;
      answered(i);
    }
  });
}

function renderEquip() {
  const $ = ui.$;
  const stats = equipStats();
  [1, 2, 3, 4, 5].forEach((n) => { const el = $(`eqS${n}`); if (ui.root.activeElement !== el) el.value = stats[n - 1] || ''; });
  const enabled = equipEnabled();
  const cur = Object.fromEntries((eqState?.slots || []).map((s) => [s.slot, s.cur]));
  const changing = new Set((eqPlanState?.changes || []).map((c) => c.slot));
  const slotHtml = (d) => {
    const it = cur[d.slot];
    const tip = `${d.label} : ${it ? `${it.name}${it.fusion ? ` (${it.fusion >= FUSION_MAX ? 'Rayonnant' : `Tiers ${it.fusion + 1}`})` : ''}` : (eqState ? 'vide' : '?')}${enabled[d.slot] === false ? ' — désactivé' : ''}`;
    return `<button data-eqslot="${d.slot}" class="eqslot${enabled[d.slot] === false ? '' : ' on'}${changing.has(d.slot) ? ' chg' : ''}" data-tip="${DM.tipAttr(tip)}">`
      + (it?.icon ? `<img src="/img/items/${+it.icon}.png" alt="">` : `<span class="em">${d.em}</span>`)
      + `<span>${d.dofus ? d.label.replace('Dofus ', 'D') : d.label}</span></button>`;
  };
  const html = EQUIP_SLOTS.filter((d) => !d.dofus).map(slotHtml).join('');
  const htmlD = EQUIP_SLOTS.filter((d) => d.dofus).map(slotHtml).join('');
  if ($('eqSlots').dmHtml !== html) { $('eqSlots').dmHtml = html; $('eqSlots').innerHTML = html; }
  if ($('eqDofus').dmHtml !== htmlD) { $('eqDofus').dmHtml = htmlD; $('eqDofus').innerHTML = htmlD; }
  for (const b of ui.root.querySelectorAll('[data-eqmode]')) b.classList.toggle('on', b.dataset.eqmode === (cfg.equipAuto || 'off'));
  const nDecl = cfg.equipDeclined?.[eqAcct()]?.length || 0;
  $('eqDeclBox').hidden = !nDecl;
  $('eqDecl').textContent = `${nDecl} objet(s) refusé(s), plus proposé(s)`;
  $('eqPreview').disabled = equipBusy || !stats[0];
  $('eqGo').disabled = equipBusy || !eqPlanState?.changes.length;
  $('eqGo').textContent = eqPlanState?.changes.length ? `✅ Équiper (${eqPlanState.changes.length})` : '✅ Équiper';
  const msg = $('eqMsg');
  msg.textContent = eqMsg || (stats[0] ? '' : 'Choisis au moins la caractéristique 1.');
  msg.className = `status ${eqMsgCls}`;
  const ul = $('eqPlan');
  ul.textContent = '';
  for (const c of eqPlanState?.changes || []) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = `${c.label} : `;
    li.append(b, `${c.from ? itemLabel(c.from) : '(vide)'} → `);
    const to = document.createElement('b');
    to.textContent = itemLabel(c.to);
    li.append(to, document.createElement('br'));
    c.delta.forEach(([k, d], i) => {
      const sp = document.createElement('span');
      sp.className = d > 0 ? 'up' : 'down';
      sp.textContent = `${i ? ', ' : ''}${d > 0 ? '+' : ''}${d} ${statShort(k)}`;
      li.append(sp);
    });
    ul.appendChild(li);
  }
}

// ---------- Fusion (menu) ----------
let fuseList = null, fuseBusy = false, fuseMsg = '', fuseMsgCls = '';
const setFuseMsg = (text, cls = '') => { fuseMsg = text; fuseMsgCls = cls; renderUi(); };

async function scanFusions(keepMsg) {
  if (fuseBusy) return;
  fuseBusy = true;
  if (!keepMsg) setFuseMsg('Lecture de l’inventaire…');
  try {
    fuseList = await fusePlan();
    if (!keepMsg) setFuseMsg(fuseList.length ? `${fuseList.length} objet(s) fusionnable(s).` : 'Aucun objet en 3 exemplaires (hors objets portés).');
  } catch (e) {
    fuseActionId = null;
    setFuseMsg(`❌ ${e.message || e}`, 'err');
  } finally {
    fuseBusy = false;
    renderUi();
  }
}

async function runFusions(items) {
  if (fuseBusy || !items.length) return;
  fuseBusy = true;
  renderUi();
  let done = 0;
  try {
    done = await fuseItems(items, (n, total, it) => setFuseMsg(`Fusion ${n}/${total} : ${it.name}…`));
    setFuseMsg(`✔ ${done} fusion(s) faite(s).`, 'ok');
  } catch (e) {
    fuseActionId = null;   // l'ID a peut-être changé (nouveau déploiement) : on le relira
    setFuseMsg(`❌ ${e.message || e}`, 'err');
  } finally {
    fuseBusy = false;
  }
  await scanFusions(true);   // liste à jour après fusion
  if (done && location.pathname.startsWith('/inventaire')) setTimeout(() => location.reload(), 1500);
}

function renderFuse() {
  const $ = ui.$;
  $('fuseScan').disabled = fuseBusy;
  $('fuseAll').disabled = fuseBusy || !fuseList?.length;
  $('fuseAll').style.display = fuseList?.length ? '' : 'none';
  const msg = $('fuseMsg');
  msg.textContent = fuseMsg || (fuseList ? '' : 'Repère les objets en 3 exemplaires ou plus du même tier.');
  msg.className = `status ${fuseMsgCls}`;
  const ul = $('fuseList');
  ul.textContent = '';
  for (const it of fuseList || []) {
    const li = document.createElement('li');
    const txt = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = it.name;
    const have = Object.entries(it.tiers).filter(([, q]) => q).map(([f, q]) => `${q}× ${tierLabel(+f)}`).join(', ');
    txt.append(b, ` niv. ${it.lvl}`, document.createElement('br'),
      `${have} → ${it.steps.length} fusion${it.steps.length > 1 ? 's' : ''}, jusqu’à ${tierLabel(it.best)}`);
    const btn = document.createElement('button');
    btn.textContent = 'Fusionner';
    btn.dataset.fuse = it.id;
    btn.disabled = fuseBusy;
    li.append(txt, btn);
    ul.appendChild(li);
  }
}

function renderUi() {
  if (dead || !document.body) return;
  if (!ui || !ui.host.isConnected) ui = buildUi();   // le site peut remplacer le <body>
  const mine = cfg.ownerTabId === myTabId;
  const on = cfg.enabled && mine;
  const state = !cfg.enabled ? 'off' : !mine ? 'other' : cfg.paused ? 'pause' : 'on';
  ui.bubble.style.setProperty('--st', ST_COLOR[state]);
  ui.bubble.title = on ? `Pilote ON — ${cfg.status || ''}` : cfg.enabled ? 'Pilote actif dans un autre onglet' : 'Pilote OFF';
  {
    const pb = ui.root.querySelector('.bubble.play');
    pb.textContent = on ? '⏸' : '▶';
    pb.style.background = on ? '#a33' : '#2e7d32';
    pb.style.borderColor = on ? '#d66' : '#5c5';
    pb.title = on ? 'Pause : arrêter le pilote' : 'Lecture : enchaîner les combats de cette page en boucle (chasse, aventure, ascension)';
  }
  for (const g of ui.root.querySelectorAll('.bubble.gear')) {
    const slot = +g.dataset.gear, b = GEAR_BUBBLES[slot];
    g.title = `${b.label} : équiper « ${presetName(slot) || `équipement enregistré n° ${slot + 1}`} » (équipement enregistré n° ${slot + 1} de la page Personnage)`;
  }
  if (ui.panel.hidden) return;

  const $ = ui.$;
  const hunt = cfg.mode === 'chasse';
  $('stats').textContent = `${cfg.wins || 0} V / ${cfg.losses || 0} D`;
  { const h = timeLines() || 'Pas encore de mesure : lance le pilote.'; if ($('times').innerHTML !== h) $('times').innerHTML = h; }
  {
    const run = cfg.dropRun;
    const cartN = (cfg.dropCart || []).length;
    $('dropBox').style.display = run?.active || cartN ? 'flex' : 'none';
    $('dropStop').style.display = run?.active ? '' : 'none';
    $('dropOpen').textContent = `🛒 Liste de courses${cartN ? ` (${cartN})` : ''}`;
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const h = run?.active
      ? `<b>🐉 Farm de drop</b> · ${esc(dropZoneName(run.zone))}${run.items.map((it) => `<div>${it.got >= it.need ? '✔' : '•'} ${esc(it.name)} : ${it.got}/${it.need}</div>`).join('')}`
      : `<b>🐉 Farm de drop</b> · arrêté — liste de courses gardée`;
    if ($('dropInfo').innerHTML !== h) $('dropInfo').innerHTML = h;
  }
  $('status').textContent = on ? (cfg.status || '—') : cfg.enabled ? 'Actif dans un autre onglet' : 'Arrêté';
  const tg = $('toggle');
  tg.textContent = cfg.enabled ? '■ Arrêter' : `▶ Démarrer (${DM.modeLabel(cfg)})`;
  tg.style.background = cfg.enabled ? '#a33' : '#2e7d32';
  $('energy').textContent = cfg.energy != null ? `⚡ ${cfg.energy}/${cfg.energyMax}` : '';

  for (const b of ui.root.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === cfg.mode);
  for (const b of ui.root.querySelectorAll('[data-engine]')) b.classList.toggle('on', b.dataset.engine === (cfg.fightEngine || 'game'));
  // modules désactivés dans la popup : leurs sections du menu sont masquées
  for (const el of ui.root.querySelectorAll('[data-mod]')) {
    const k = el.dataset.mod;
    el.style.display = (k === 'tools' ? modOn('spells') || modOn('build') : modOn(k)) ? '' : 'none';
  }
  $('zoneBox').style.display = hunt ? '' : 'none';
  $('groupInfo').textContent = cfg.huntGroup ? `Groupe ${cfg.huntGroup} (choisi en jeu)` : 'Groupe le plus dur';
  $('groupReset').style.display = cfg.huntGroup ? '' : 'none';
  const sel = $('zone');
  let zones = cfg.huntZones || [];
  if (cfg.huntZone && !zones.some((z) => z.id === cfg.huntZone)) zones = [{ id: cfg.huntZone, name: cfg.huntZoneName || `Zone ${cfg.huntZone}` }, ...zones];
  const sig = zones.map((z) => z.id).join(',') + '|' + cfg.huntZone;
  if (sel.dataset.sig !== sig) {   // ne reconstruit la liste que si elle change (sinon le menu déroulant se refermerait)
    sel.dataset.sig = sig;
    sel.innerHTML = '';
    if (!cfg.huntZone) sel.add(new Option('— choisir une zone —', ''));
    for (const z of zones) sel.add(new Option(z.label || z.name, z.id, false, z.id === cfg.huntZone));
  }

  $('keepAbove').checked = cfg.sellKeepAbove !== false;
  DM.RARITIES.forEach((_, i) => { ui.$(`rar${i}`).checked = (cfg.sellKeepRarities || []).includes(i); });
  renderFuse();
  renderEquip();
  // Avis de recherche
  const st = cfg.wantedScan;
  const missing = st?.zones?.filter((z) => !['ok', 'empty'].includes(z.status)).length || 0;
  $('scan').textContent = scanRunning ? (scanStop ? 'Arrêt…' : '■ Arrêter le scan') : 'Scanner les zones';
  $('wantedLoop').checked = !!cfg.wantedLoop;
  $('scanWanted').checked = cfg.scanWanted !== false;
  $('scanArchi').checked = cfg.scanArchi !== false;
  if (ui.root.activeElement !== $('minPerGroup')) $('minPerGroup').value = cfg.wantedMinPerGroup || 1;
  // ne pas écraser un champ en cours de saisie
  for (const [k, key] of [['lvlMin', 'wantedLvlMin'], ['lvlMax', 'wantedLvlMax']]) {
    if (ui.root.activeElement !== $(k)) $(k).value = cfg[key] || '';
  }
  $('scanResume').style.display =!scanRunning && missing && st?.zones?.length ? '' : 'none';
  $('scanResume').textContent = `Reprendre (${missing})`;
  $('scanAge').textContent = st?.finishedAt ? `scan ${DM.hhmm(st.finishedAt)}` : '';
  $('scanMsg').textContent = scanMsg || (st?.zones ? `${scanMatches().length} cible(s) trouvée(s)${missing ? ` · ${missing} zone(s) non scannée(s)` : ''}` : `${WANTED_KEYS.length} avis et ${ARCHI_KEYS.size} archis connus — lance un scan.`);
  const wl = $('wanted');
  wl.textContent = '';
  const now = Date.now();
  for (const f of scanMatches()) {
    const li = document.createElement('li');
    const old = f.rotateAt && now > f.rotateAt;
    li.dataset.href = old ? `/chasse?zone=${f.zoneId}` : attackLink(f);
    if (old) li.className = 'old';
    li.title = old ? 'Groupes renouvelés depuis le scan : ouvrir la zone' : 'Attaquer ce groupe (pilote auto, combats relancés en boucle)';
    if (f.img) {
      const ic = document.createElement('img');
      ic.src = f.img;
      ic.alt = '';
      li.appendChild(ic);
    }
    const txt = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = `${KIND_ICON[f.kind] || '🎯'} ${f.monster}`;
    txt.append(b, f.lvl ? ` niv. ${f.lvl}` : '', document.createElement('br'),
      `${f.zoneName} · G${f.group}${f.total ? ` (total ${f.total})` : ''}${f.count > 1 ? ` · ${f.count} cibles` : ''}`,
      f.rotateAt ? ` · ${old ? 'expiré' : `jusqu’à ${DM.hhmm(f.rotateAt)}`}` : '');
    li.appendChild(txt);
    wl.appendChild(li);
  }

  const ls = lockStateOf();
  const locks = ls ? [...Object.entries(ls.manual || {}).map(([k, it]) => [k, { ...it, why: 'à la main' }]),
    ...Object.entries(ls.auto || {}).filter(([k]) => !ls.manual?.[k] && !ls.optOut?.[k]).map(([k, it]) => [k, { ...it, why: it.src.join(', ') }])]
    : Object.entries(cfg.lockedItems || {}).map(([k, it]) => [k, { ...it, why: 'à la main' }]);
  locks.sort((a, b) => a[1].name.localeCompare(b[1].name));
  $('lockTitle').textContent = `🔒 ${locks.length} objet${locks.length > 1 ? 's' : ''} verrouillé${locks.length > 1 ? 's' : ''}`;
  const ul = $('locks');
  ul.textContent = '';
  for (const [k, it] of locks) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = `${it.name} (niv. ${it.lvl})`;
    span.title = `Verrouillé : ${it.why}`;
    const why = document.createElement('small');
    why.className = 'muted';
    why.textContent = ` — ${it.why}`;
    span.appendChild(why);
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Déverrouiller';
    x.dataset.unlock = k;
    li.append(span, x);
    ul.appendChild(li);
  }
}
