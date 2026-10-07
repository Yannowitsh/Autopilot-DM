// Autopilot-DM — content script : fusion + auto-équipement (calcul).
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- Fusion : 3 exemplaires d'un même tiers → 1 du tiers suivant (+10 % de stats), jusqu’au tier 5 « Rayonnant » (fusion 4) ----------
// Server action « fuseItem(itemId, fusion) » → { newFusion } ou { error }. Les objets portés ne sont pas dans `entries`.
const FUSE_ACTION_FALLBACK = '60e1cb4d715df40bfc2d5e6af8032e5ae119fd0915';
const FUSE_COPIES = 3;
let fuseActionId = null, fuseChunks = null;
const tierLabel = (f) => (f >= FUSION_MAX ? 'Rayonnant ★' : f ? `T${f + 1}` : 'base');   // comme le jeu : fusion 1 = « Tiers 2 »

// Objets fusionnables, regroupés par objet : fusions en cascade simulées (3 base → 1 T1 ; 3 T1 → 1 T2…).
async function fusePlan() {
  const { entries, chunks } = await fetchInventory();
  fuseChunks = chunks;
  const byId = new Map();
  for (const e of entries) {
    if (e.fusion >= FUSION_MAX) continue;
    const g = byId.get(e.id) || { id: e.id, name: e.name, lvl: e.lvl, rarity: e.rarity, tiers: {}, locks: [] };
    g.tiers[e.fusion] = (g.tiers[e.fusion] || 0) + e.qty;
    if (e.locked) g.locks.push(e.fusion || 0);
    byId.set(e.id, g);
  }
  const plan = [];
  for (const g of byId.values()) {
    const t = { ...g.tiers };
    const steps = [];
    for (let f = 0; f < FUSION_MAX; f++) {
      while ((t[f] || 0) >= FUSE_COPIES) {
        steps.push(f);
        t[f] -= FUSE_COPIES;
        t[f + 1] = (t[f + 1] || 0) + 1;
      }
    }
    if (!steps.length) continue;
    const best = Math.max(...Object.keys(t).filter((f) => t[f] > 0).map(Number));
    plan.push({ ...g, steps, best, after: t });
  }
  return plan.sort((a, b) => b.best - a.best || b.lvl - a.lvl || a.name.localeCompare(b.name));
}

// Exécute les fusions de `items` (sous-ensemble de fusePlan) ; s'arrête à la première erreur.
// Le jeu refuse de fusionner un objet verrouillé (`locks` : tiers sous cadenas) : on ouvre ses cadenas le temps de fusionner,
// puis la synchro des verrous les referme sur tous les tiers (résultat compris).
async function fuseItems(items, onProgress) {
  if (!fuseActionId) fuseActionId = await findAction(fuseChunks || (await fetchFlight('/inventaire')).chunks, 'fuseItem', FUSE_ACTION_FALLBACK);
  let done = 0;
  const total = items.reduce((n, it) => n + it.steps.length, 0);
  // verrous à jour avant d'ouvrir des cadenas (sinon une synchro les prendrait pour un clic en jeu), puis cadenas relus
  let opened = false;
  try {
    await syncLocks({ force: true });
    const { entries } = await fetchInventory();
    for (const it of items) it.locks = entries.filter((e) => e.id === it.id && e.locked).map((e) => e.fusion || 0);
  } catch (e) { DM.log(`fusion : synchro des verrous impossible (${e.message})`); }
  try {
    for (const it of items) {
      for (const f of it.locks || []) {
        opened = true;
        await setItemLock(it.id, f, false);
        await lockSeen(it.id, f, false);
      }
      for (const f of it.steps) {
        const r = await callAction('inventaire', fuseActionId, [it.id, f]);
        if (r.newFusion !== f + 1) throw new Error(`${it.name} : réponse inattendue (${JSON.stringify(r)})`);
        done++;
        onProgress?.(done, total, it);
        if (done < total) await sleep(400 + Math.random() * 400);
      }
    }
  } finally {
    if (opened) await syncLocks({ force: true }).catch((e) => DM.log(`fusion : cadenas pas refermés (${e.message}), nouvel essai à la prochaine synchro`));
  }
  DM.log(`fusion: ${done} fusion(s) sur ${items.length} objet(s)`);
  return done;
}

// Fusion ciblée (liste de courses du farm de drop) : seulement les objets de `targets` (id → tier voulu, 1 à 5), en cascade
// depuis le tier de base, jamais au-delà du tier voulu. Exemplaires de l'inventaire seulement (pas l'objet porté).
// Les autres objets ne sont pas touchés (contrairement à « Tout fusionner »). → nombre de fusions faites.
async function fuseTowards(targets) {
  if (!targets.size) return 0;
  const { entries, chunks } = await fetchInventory();
  fuseChunks = chunks;
  const items = [];
  for (const [id, tier] of targets) {
    const top = Math.min(FUSION_MAX, tier - 1);   // fusion visée (T2 = 1)
    const t = {};
    for (const e of entries) if (e.id === id) t[e.fusion || 0] = (t[e.fusion || 0] || 0) + e.qty;
    const steps = [];
    for (let f = 0; f < top; f++) {
      while ((t[f] || 0) >= FUSE_COPIES) { steps.push(f); t[f] -= FUSE_COPIES; t[f + 1] = (t[f + 1] || 0) + 1; }
    }
    const locks = entries.filter((e) => e.id === id && e.locked).map((e) => e.fusion || 0);
    if (steps.length) items.push({ id, name: entries.find((e) => e.id === id)?.name || `objet ${id}`, steps, locks });
  }
  if (!items.length) return 0;
  try {
    return await fuseItems(items);
  } catch (e) {
    fuseActionId = null;   // l'ID a peut-être changé : relu au prochain essai
    DM.log(`fusion ciblée : ${e.message}`);
    return 0;
  }
}

// Bouton « ⚡ Tout fusionner » sous le bouton du jeu « Fusionner 3 → Tiers 2 (130/3) » (fiche d'objet de /inventaire) :
// enchaîne toutes les fusions possibles à ce tier (130/3 → 43), sans cascade vers les tiers suivants. 2e clic = confirmation.
// Le jeu désactive son bouton (objet verrouillé, pas assez d'exemplaires) : le nôtre suit.
// Bouton « Tout retirer » à gauche de « Vendre (ou briser) plusieurs objets » (/inventaire) : retire tous les objets
// portés, emplacement par emplacement (server action « unequipItem(emplacement) »). 2e clic = confirmation.
const UNEQUIP_ACTION_FALLBACK = '405fdd8f47dcc7595578823c1750c0209b9a25b227';
// Bouton « Retirer toutes les ventes » à côté du titre « Mes ventes en cours » (/hdv?onglet=vendre) : retire chaque
// annonce une par une (server action « cancelListing(idAnnonce) »), les objets reviennent dans l'inventaire. 2e clic = confirmation.
function scanCancelAllButton() {
  if (!location.pathname.startsWith('/hdv')) return;
  const h2 = [...document.querySelectorAll('h2')].find((h) => h.textContent.trim() === 'Mes ventes en cours');
  const head = h2?.parentElement;
  if (!head || head.querySelector('.dm-cancel-all')) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-ghost !py-1 text-sm ml-auto dm-cancel-all';
  b.textContent = '🧹 Retirer toutes les ventes';
  b.title = 'Autopilot-DM : retire toutes tes annonces de l’HDV, les objets reviennent dans ton inventaire (2e clic pour confirmer). La page se recharge à la fin.';
  b.addEventListener('click', onCancelAll);
  h2.after(b);
}

async function onCancelAll(e) {
  const btn = e.currentTarget;
  if (btn.dataset.busy) return;
  const label = '🧹 Retirer toutes les ventes';
  if (!btn.dataset.armed) {
    const n = +(btn.parentElement?.textContent.match(/(\d+)\s*\/\s*\d+\s*offres/) || [])[1];
    btn.dataset.armed = '1';
    btn.textContent = `⚠️ Confirmer : retirer ${n ? `${n} vente${n > 1 ? 's' : ''}` : 'tout'}`;
    setTimeout(() => { if (!btn.dataset.busy) { delete btn.dataset.armed; btn.textContent = label; } }, 6000);
    return;
  }
  delete btn.dataset.armed;
  btn.dataset.busy = '1';
  btn.disabled = true;
  let done = 0, failed = 0;
  try {
    btn.textContent = 'Lecture de mes ventes…';
    const { own } = await fetchSellable();
    for (const l of own) {
      btn.textContent = `Retrait ${done + failed + 1}/${own.length}…`;
      try {
        await hdvCall('cancelListing', [l.id], '?onglet=vendre');
        done++;
      } catch (err) {
        failed++;
        DM.log(`retirer toutes les ventes : ${l.name || `annonce ${l.id}`} : ${err.message}`);
      }
      await sleep(150 + Math.random() * 150);
    }
    DM.log(`retirer toutes les ventes : ${done} retirée(s)${failed ? `, ${failed} échec(s)` : ''}`);
    tradeToast(own.length ? `🧹 ${done} vente(s) retirée(s)${failed ? ` · ${failed} échec(s) (voir le journal)` : ''}` : '🧹 Aucune vente en cours.', failed ? 'err' : 'ok');
  } catch (err) {
    tradeToast(`🧹 Échec : ${err.message}`, 'err');
  } finally {
    delete btn.dataset.busy;
    btn.disabled = false;
    btn.textContent = label;
    if (done) setTimeout(() => location.reload(), 1200);
  }
}

function scanUnequipAllButton() {
  if (!location.pathname.startsWith('/inventaire')) return;
  const anchor = [...document.querySelectorAll('button')].find((b) => /^(Vendre ou briser plusieurs objets|Vendre plusieurs objets|Quitter la sélection)$/.test(b.textContent.trim()));
  if (!anchor || anchor.previousElementSibling?.classList.contains('dm-unequip-all')) return;
  document.querySelector('.dm-unequip-all')?.remove();
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-ghost !py-1.5 text-sm ml-auto min-h-9 dm-unequip-all';
  b.textContent = '🧺 Tout retirer';
  b.title = 'Autopilot-DM : retire tous les objets portés (2e clic pour confirmer). La page se recharge à la fin.';
  b.addEventListener('click', onUnequipAll);
  anchor.before(b);
}

async function onUnequipAll(e) {
  const btn = e.currentTarget;
  if (btn.dataset.busy) return;
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = '⚠️ Confirmer : tout retirer';
    setTimeout(() => { if (!btn.dataset.busy) { delete btn.dataset.armed; btn.textContent = '🧺 Tout retirer'; } }, 6000);
    return;
  }
  delete btn.dataset.armed;
  btn.dataset.busy = '1';
  btn.disabled = true;
  let done = 0, failed = 0;
  try {
    btn.textContent = 'Lecture de l’équipement…';
    const { slots, chunks } = await fetchEquipState();
    const worn = slots.filter((s) => s.cur);
    const id = await findAction(chunks, 'unequipItem', UNEQUIP_ACTION_FALLBACK);
    for (const s of worn) {
      btn.textContent = `Retrait ${done + failed + 1}/${worn.length}…`;
      try {
        await callAction('inventaire', id, [s.slot]);
        done++;
      } catch (err) {
        failed++;
        DM.log(`tout retirer : ${s.label || s.slot} (${s.cur.name}) : ${err.message}`);
      }
      await sleep(150);
    }
    DM.log(`tout retirer : ${done} objet(s) retiré(s)${failed ? `, ${failed} échec(s)` : ''}`);
    if (done) await syncLocks({ force: true }).catch((e) => DM.log(`verrous : ${e.message}`));   // cadenas des objets revenus
    tradeToast(worn.length ? `🧺 ${done} objet(s) retiré(s)${failed ? ` · ${failed} échec(s) (voir le journal)` : ''}` : '🧺 Aucun objet porté.', failed ? 'err' : 'ok');
  } catch (err) {
    tradeToast(`🧺 Échec : ${err.message}`, 'err');
  } finally {
    delete btn.dataset.busy;
    btn.disabled = false;
    btn.textContent = '🧺 Tout retirer';
    if (done) setTimeout(() => location.reload(), 1200);
  }
}

function scanFuseButtons() {
  if (!location.pathname.startsWith('/inventaire')) return;
  for (const b of document.querySelectorAll('aside button.btn-gold')) {
    const m = b.textContent.match(/Fusionner\s*\d+\s*→\s*(.+?)\s*\((\d+)\s*\/\s*(\d+)\)/);
    let extra = b.nextElementSibling?.classList.contains('dm-fuse-all') ? b.nextElementSibling : null;
    const n = m ? Math.floor(+m[2] / +m[3]) : 0;
    const target = !m ? 0 : /Rayonnant/.test(m[1]) ? FUSION_MAX : +(m[1].match(/T(?:iers\s*)?(\d)/)?.[1] || 0) - 1;
    if (n < 2 || target < 1) { if (!extra?.dataset.busy) extra?.remove(); continue; }
    if (!extra) {
      extra = document.createElement('button');
      extra.type = 'button';
      extra.className = 'btn btn-ghost w-full dm-fuse-all';
      extra.title = 'Autopilot-DM : enchaîne toutes les fusions possibles à ce tier (2e clic pour confirmer). La page se recharge à la fin.';
      extra.addEventListener('click', onFuseAll);
      b.after(extra);
    }
    const key = `${target}|${m[2]}`;
    if (extra.dataset.key !== key && !extra.dataset.busy && !extra.dataset.armed) {
      Object.assign(extra.dataset, { key, n, from: target - 1 });
      extra.textContent = `⚡ Tout fusionner : ${n} fusions → ${n} × ${tierLabel(target)}`;
    }
    extra.disabled = b.disabled || !!extra.dataset.busy;
  }
}

async function onFuseAll(e) {
  const btn = e.currentTarget;
  if (btn.dataset.busy) return;
  const n = +btn.dataset.n, from = +btn.dataset.from;
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = `⚠️ Confirmer : ${n} fusions (${n * FUSE_COPIES} exemplaires)`;
    setTimeout(() => {
      if (!btn.dataset.armed || btn.dataset.busy) return;
      delete btn.dataset.armed;
      btn.dataset.key = '';
      scanFuseButtons();
    }, 6000);
    return;
  }
  delete btn.dataset.armed;
  btn.dataset.busy = '1';
  btn.disabled = true;
  try {
    btn.textContent = 'Lecture de l’inventaire…';
    const { entries, chunks } = await fetchInventory();
    fuseChunks = chunks;
    // l'objet affiché : nom présent dans la fiche, au bon tier (le plus long si plusieurs noms correspondent)
    const text = btn.closest('aside')?.textContent || '';
    const it = entries.filter((x) => x.fusion === from && x.qty >= FUSE_COPIES && text.includes(x.name))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!it) throw new Error('objet introuvable dans l’inventaire');
    const steps = new Array(Math.min(n, Math.floor(it.qty / FUSE_COPIES))).fill(from);
    await fuseItems([{ id: it.id, name: it.name, steps }], (k, total) => { btn.textContent = `Fusion ${k}/${total} : ${it.name}…`; });
    btn.textContent = `✔ ${steps.length} fusions faites — rechargement…`;
    setTimeout(() => location.reload(), 1200);
  } catch (err) {
    fuseActionId = null;   // l'ID a peut-être changé (nouveau déploiement)
    delete btn.dataset.busy;
    btn.disabled = false;
    btn.textContent = `❌ ${err.message || err} — recliquer pour réessayer`;
  }
}


// ---------- Auto-équipement : meilleurs objets pour 5 caractéristiques (dont 2 facultatives) par ordre de priorité ----------
// Server action « equipItem(itemId, fusion, emplacement) » sur /inventaire → {} ou { error }.
// Emplacements (props.slots de /inventaire) : chapeau, cape, amulette, anneau1-2, ceinture, bottes, arme, bouclier,
// familier, dofus1-6 ; chacun « accepte » un type d'objet (champ s de l'objet). Les objets portés ne sont pas dans entries.
const EQUIP_ACTION_FALLBACK = '706383ea472542e23da3f7d81239188959e316dda0';
// Poids des stats choisies, par position : la 1re décide, les suivantes départagent / ajoutent un peu de valeur.
// Les 4e et 5e sont facultatives (poids faibles) : non choisies, elles ne changent rien.
const EQUIP_WEIGHTS = [1, 0.35, 0.15, 0.08, 0.04];
const EQUIP_N = EQUIP_WEIGHTS.length;
// Constantes du jeu (FUSION et libellés), pour calculer les stats réelles d'un objet fusionné comme le site.
const FUSION_RULES = { stepPct: 10, excluded: ['pa', 'pm', 'po', 'invocations'], dofusRadiantPct: 100, radiantPa: 2 };
const STAT_LABELS = { pv: 'Points de vie', pa: 'PA', pm: 'PM', po: 'Portée', invocations: 'Invocations', vitalite: 'Vitalité', sagesse: 'Sagesse', force: 'Force', intelligence: 'Intelligence', chance: 'Chance', agilite: 'Agilité', critique: '% Critique', prospection: 'Prospection', initiative: 'Initiative', puissance: 'Puissance', soins: 'Soins', dommages: 'Dommages', dommagesTerre: 'Dommages Terre', dommagesFeu: 'Dommages Feu', dommagesEau: 'Dommages Eau', dommagesAir: 'Dommages Air', dommagesNeutre: 'Dommages Neutre', dommagesCritiques: 'Dommages Critiques', resCritiques: 'Résistance Critiques', dommagesPoussee: 'Dommages Poussée', resPoussee: 'Résistance Poussée', resPctTerre: '% Résistance Terre', resPctFeu: '% Résistance Feu', resPctEau: '% Résistance Eau', resPctAir: '% Résistance Air', resPctNeutre: '% Résistance Neutre', resTerre: 'Résistance Terre', resFeu: 'Résistance Feu', resEau: 'Résistance Eau', resAir: 'Résistance Air', resNeutre: 'Résistance Neutre', fuite: 'Fuite', tacle: 'Tacle', esquivePA: 'Esquive PA', esquivePM: 'Esquive PM', retraitPA: 'Retrait PA', retraitPM: 'Retrait PM', renvoi: 'Renvoi de dommages', pods: 'Pods', dmgPctDistance: '% Dommages distance', dmgPctMelee: '% Dommages mêlée', dmgPctArmes: '% Dommages d’armes', dmgPctSorts: '% Dommages aux sorts', resPctDistance: '% Résistance distance', resPctMelee: '% Résistance mêlée', resPctAll: '% Résistance (tous éléments)', resAll: 'Réduction de dommages' };
const STAT_ORDER = ['pa', 'pm', 'po', 'invocations', 'vitalite', 'sagesse', 'force', 'intelligence', 'chance', 'agilite', 'puissance', 'critique', 'dommages', 'dommagesNeutre', 'dommagesTerre', 'dommagesFeu', 'dommagesEau', 'dommagesAir', 'dommagesCritiques', 'dommagesPoussee', 'soins', 'prospection', 'initiative', 'resPctNeutre', 'resPctTerre', 'resPctFeu', 'resPctEau', 'resPctAir', 'resNeutre', 'resTerre', 'resFeu', 'resEau', 'resAir', 'resCritiques', 'resPoussee', 'tacle', 'fuite', 'retraitPA', 'retraitPM', 'esquivePA', 'esquivePM', 'renvoi', 'dmgPctSorts', 'dmgPctArmes', 'dmgPctMelee', 'dmgPctDistance', 'resPctMelee', 'resPctDistance', 'pods'];
// Emplacements dans l'ordre de la grille du menu (emoji affiché tant qu'on ne connaît pas l'objet porté).
const EQUIP_SLOTS = [
  { slot: 'chapeau', label: 'Chapeau', em: '🎩' }, { slot: 'amulette', label: 'Amulette', em: '📿' },
  { slot: 'cape', label: 'Cape', em: '🧥' }, { slot: 'familier', label: 'Familier', em: '🐾' },
  { slot: 'anneau1', label: 'Anneau 1', em: '💍' }, { slot: 'anneau2', label: 'Anneau 2', em: '💍' },
  { slot: 'ceinture', label: 'Ceinture', em: '🎗️' }, { slot: 'bottes', label: 'Bottes', em: '👢' },
  { slot: 'arme', label: 'Arme', em: '⚔️' }, { slot: 'bouclier', label: 'Bouclier', em: '🛡️' },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ slot: `dofus${n}`, label: `Dofus ${n}`, em: '🥚', dofus: true })),
];
let equipActionId = null;
const eqItemKey = (it) => `${it.id}|${it.fusion || 0}`;

// Stats réelles d'un objet au tier de fusion donné (même calcul que itemStats du site).
function fusedStats(st, type, fusion) {
  if (!fusion) return st || {};
  const out = {};
  if (type === 'dofus' && fusion >= FUSION_MAX) {
    for (const [k, v] of Object.entries(st || {})) out[k] = v > 0 ? Math.round(v * (1 + FUSION_RULES.dofusRadiantPct / 100)) : v;
    return out;
  }
  const mult = 1 + fusion * FUSION_RULES.stepPct / 100;
  for (const [k, v] of Object.entries(st || {})) out[k] = v > 0 && !FUSION_RULES.excluded.includes(k) ? Math.round(v * mult) : v;
  if (fusion >= FUSION_MAX && (out.pa ?? 0) > 0) out.pa = Math.max(out.pa, FUSION_RULES.radiantPa);
  return out;
}
// Inverse approché de fusedStats (stats de base d'un objet fusionné, à l'arrondi près) : repli quand seules les stats
// fusionnées sont connues (banque lue par une ancienne version de l'extension).
function unfusedStats(eff, type, fusion) {
  if (!fusion) return eff || {};
  const radiant = type === 'dofus' && fusion >= FUSION_MAX;
  const mult = radiant ? 1 + FUSION_RULES.dofusRadiantPct / 100 : 1 + fusion * FUSION_RULES.stepPct / 100;
  const out = {};
  for (const [k, v] of Object.entries(eff || {})) out[k] = v > 0 && (radiant || !FUSION_RULES.excluded.includes(k)) ? Math.round(v / mult) : v;
  return out;
}

// Inventaire + objets portés, lus dans le payload RSC de /inventaire.
async function fetchEquipState() {
  const { flight, chunks } = await fetchFlight('/inventaire');
  const { rows, props } = rscProps(flight, (x) => Array.isArray(x.entries) && Array.isArray(x.slots));
  if (!props) throw new Error('Inventaire introuvable dans la page');
  const res = (v) => rscResolve(rows, v);
  const norm = (raw, fusion) => {
    const it = res(raw) || {};
    const type = it.s;
    return { id: it.id, name: it.n, lvl: it.lvl, type, rarity: it.r, icon: it.icon, fusion: fusion || 0, setName: it.setName || null,
      two: !!res(it.w)?.twoHanded, eff: fusedStats(res(it.st), type, fusion || 0), baseEff: res(it.st) || {} };
  };
  const entries = props.entries.map((e) => ({ ...norm(e.item, e.fusion), qty: e.qty })).filter((e) => Number.isInteger(e.id) && e.qty > 0);
  const slots = props.slots.map((s) => ({ slot: s.slot, label: s.label, accepts: s.accepts, cur: s.item ? norm(s.item, s.fusion) : null }));
  return { entries, slots, level: +props.level || 0, chunks, scrolls: res(props.scrollValues) || {} };
}

// Plan d'équipement : pour chaque type d'emplacement activé, les meilleurs objets (distincts) selon les stats choisies.
// Un objet déjà porté et retenu reste à sa place ; seuls les emplacements qui gagnent au change sont modifiés.
// `exclude` : clés « id|fusion » d'objets de l'inventaire à ignorer (refusés dans la proposition automatique).
function equipPlan(state, statKeys, enabled, exclude = null) {
  const weighted = statKeys.slice(0, EQUIP_N).map((k, i) => [k, EQUIP_WEIGHTS[i]]).filter(([k]) => k);
  const stats = weighted.map(([k]) => k);
  if (!stats.length) throw new Error('Choisis au moins une caractéristique');
  const on = (slot) => enabled[slot] !== false;
  const ok = (c) => c && !(c.lvl > state.level);   // niveau requis
  const pool = [
    ...state.entries.filter((e) => ok(e) && !exclude?.has(eqItemKey(e))).map((e) => ({ ...e, from: null })),
    ...state.slots.filter((s) => on(s.slot) && ok(s.cur)).map((s) => ({ ...s.cur, qty: 1, from: s.slot })),
  ];
  // normalisation par type d'objet : valeur / meilleure valeur du type (une cape à 400 Vita ≠ un anneau à 400 Vita)
  const best = {};
  for (const c of [...pool, ...state.slots.map((s) => s.cur).filter(Boolean)]) {
    for (const k of stats) best[`${c.type}|${k}`] = Math.max(best[`${c.type}|${k}`] || 0, c.eff[k] || 0);
  }
  const score = (c) => (c ? weighted.reduce((n, [k, w]) => n + w * (c.eff[k] || 0) / (best[`${c.type}|${k}`] || 1), 0) : -Infinity);
  // à égalité, l'objet déjà porté passe avant un exemplaire identique de l'inventaire : sinon ce 2e exemplaire
  // serait retenu, le porté écarté (même id), et le même objet finirait dans deux emplacements (anneaux, dofus)
  const rank = (a, b) => score(b) - score(a) || !!b.from - !!a.from || b.lvl - a.lvl || b.rarity - a.rarity || b.fusion - a.fusion;
  const EPS = 1e-9;

  // Arme à deux mains : retire le bouclier → on la compare à (meilleure arme à une main + meilleur bouclier).
  const shieldSlot = state.slots.find((s) => s.slot === 'bouclier');
  const shields = pool.filter((c) => c.type === 'bouclier').sort(rank);
  const shieldScore = on('bouclier') ? Math.max(0, score(shields[0]) || 0, score(shieldSlot?.cur) || 0) : Math.max(0, score(shieldSlot?.cur) || 0);
  const weapons = pool.filter((c) => c.type === 'arme').sort(rank);
  const bestOne = weapons.find((c) => !c.two), bestTwo = weapons.find((c) => c.two);
  let allowTwo = !!bestTwo && (on('bouclier') || !shieldSlot?.cur)
    && score(bestTwo) > Math.max(0, score(bestOne) || 0) + shieldScore + EPS;
  if (!on('arme')) allowTwo = !!state.slots.find((s) => s.slot === 'arme')?.cur?.two;   // arme non touchée : on garde sa règle
  const usable = (c) => c.type !== 'arme' || (allowTwo ? c === bestTwo : !c.two);

  const changes = [];
  let unchanged = 0;
  const types = [...new Set(state.slots.filter((s) => on(s.slot)).map((s) => s.accepts))];
  for (const type of types) {
    if (type === 'bouclier' && allowTwo) { unchanged += 1; continue; }   // l'arme à deux mains retirera le bouclier
    const group = state.slots.filter((s) => s.accepts === type && on(s.slot));
    // objets portés dans un emplacement désactivé du même type : ils restent, pas de doublon
    const locked = new Set(state.slots.filter((s) => s.accepts === type && !on(s.slot) && s.cur).map((s) => s.cur.id));
    const picks = [];
    const seen = new Set(locked);
    for (const c of pool.filter((x) => x.type === type && usable(x)).sort(rank)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      picks.push(c);
      if (picks.length === group.length) break;
    }
    // déjà porté dans un emplacement du groupe : il ne bouge pas
    const free = group.filter((s) => !picks.some((p) => p.from === s.slot));
    const toPlace = picks.filter((p) => !p.from || !group.some((s) => s.slot === p.from));
    free.sort((a, b) => score(a.cur) - score(b.cur));   // vides d'abord, puis les moins bons
    unchanged += group.length - free.length;
    free.forEach((s, i) => {
      const p = toPlace[i];
      // emplacement vide : rempli même par un objet sans aucune des stats choisies (mieux que rien),
      // le classement (niveau, rareté, fusion) départage ; sinon il faut faire mieux que l'objet porté
      if (p && (s.cur ? score(p) > Math.max(score(s.cur), 0) + EPS : score(p) >= 0)) {
        const delta = stats.map((k) => [k, (p.eff[k] || 0) - (s.cur?.eff[k] || 0)]).filter(([, d]) => d);
        changes.push({ slot: s.slot, label: s.label, from: s.cur, to: p, delta });
      } else unchanged++;
    });
  }
  // l'arme avant le bouclier (une arme à deux mains retire le bouclier, un bouclier retire une arme à deux mains)
  changes.sort((a, b) => (a.slot === 'arme' ? -1 : b.slot === 'arme' ? 1 : 0));
  return { changes, unchanged, stats };
}

async function runEquip(plan, chunks, onProgress) {
  if (!equipActionId) equipActionId = await findAction(chunks || (await fetchFlight('/inventaire')).chunks, 'equipItem', EQUIP_ACTION_FALLBACK);
  let done = 0;
  for (const c of plan.changes) {
    // erreur technique (5xx, réseau, ID d'action périmé) : 2 nouveaux essais ; refus du jeu : arrêt immédiat
    for (let attempt = 0; ; attempt++) {
      try {
        if (!equipActionId) equipActionId = await findAction(chunks || (await fetchFlight('/inventaire')).chunks, 'equipItem', EQUIP_ACTION_FALLBACK);
        await callAction('inventaire', equipActionId, [c.to.id, c.to.fusion, c.slot]);
        break;
      } catch (e) {
        if (!e.game) equipActionId = null;   // ID peut-être périmé : relu au prochain essai
        if (e.game || attempt >= 2) throw Object.assign(new Error(`${c.label} (${c.to.name}) : ${e.message}`), { done });
        await sleep(attempt ? 5000 : 2000);
      }
    }
    done++;
    onProgress?.(done, plan.changes.length, c);
    if (done < plan.changes.length) await sleep(350 + Math.random() * 350);
  }
  DM.log(`équipement auto : ${done} objet(s) équipé(s) (${plan.stats.join(', ')})`);
  if (done) scheduleLockSync(5000);   // objets retirés revenus dans l'inventaire : cadenas à reposer
  return done;
}
