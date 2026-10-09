// Autopilot-DM — content script : auto par poids.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- Auto par poids : notre propre mode auto (cfg.fightEngine === 'weights') ----------
// L'Auto du jeu joue à la vitesse ×1 ; ici le pilote joue lui-même, comme à la main, par la server action du combat
// « fightAction(action, idOnglet, seq) » : { type:'play', card: uid, target } ou { type:'end' }. Chaque réponse
// contient le nouvel état ({ state, rewards }, ou { wait: ms } si le serveur veut qu'on patiente).
// Choix : chaque carte a un poids (cfg.cardWeights[idCarte] = { w, every }, arme = clé 'w'). À chaque action, parmi
// les cartes jouables, on retient la combinaison qui tient dans les PA avec le plus gros total de poids, et on joue
// sa carte la plus lourde. Poids 0 = jamais jouée ; every = au plus une fois tous les N tours (buffs qui durent) ;
// soins seulement sous cfg.autoHealBelow % de PV. Cible : l'ennemi vivant qui a le moins de PV.
const FIGHT_ACTION_FALLBACK = '70ef177923eabb2dd53cecdb33f2fa0fe42313c618';
// needsTarget du jeu : une ligne visant un ennemi avec un de ces effets demande une cible
const TARGET_EFFECTS = new Set(['dmg', 'steal', 'dmgCasterHp', 'debuff', 'stealStat', 'apRemove', 'apSteal', 'summon', 'bomb', 'trap', 'stun', 'dmgLostHp', 'poison']);
const needsTarget = (card) => (card.eff || []).some((e) => e?.tgt === 'enemy' && TARGET_EFFECTS.has(e.k));
const WEAPON_KEY = 'w';
// Nature d'une carte : 'ap' (gain de PA), 'heal' (soin), 'buff' (sans cible : bouclier, buff…) ou 'dmg'.
function cardKind(card) {
  const eff = card.eff || [];
  if (eff.some((e) => e?.k === 'apGain')) return 'ap';
  if (eff.some((e) => /heal/i.test(e?.k || '') && e.tgt !== 'enemy') && !eff.some((e) => e?.k === 'dmg')) return 'heal';
  if (!needsTarget(card)) return 'buff';
  return 'dmg';
}
const KIND_LABEL = { ap: '⚡ PA', heal: '💚 soin', buff: '🛡️ buff', dmg: '⚔️ dégâts' };
// Réglage par défaut : gain de PA d'abord (100), buffs (90, relancés à la fin de leur durée), soins (80),
// puis les dégâts selon leurs dégâts de base par PA (plafonnés à 79), l'arme à 30.
function defaultWeight(card, weapon = false) {
  if (weapon) return { w: 30, every: 0 };
  const kind = cardKind(card);
  if (kind === 'ap') return { w: 100, every: 0 };
  if (kind === 'buff') return { w: 90, every: Math.max(0, ...(card.eff || []).map((e) => +e?.dur || 0)) };
  if (kind === 'heal') return { w: 80, every: 0 };
  const dmg = spellDamage(card);
  const ap = +card.ap || 0;
  return { w: Math.max(1, Math.min(79, Math.round(dmg && ap ? dmg.avg / ap : dmg?.avg || 10))), every: 0 };
}
const weightOf = (card, weapon = false) => {
  const own = cfg.cardWeights?.[weapon ? WEAPON_KEY : card.id];
  const def = defaultWeight(card, weapon);
  return { w: own?.w ?? def.w, every: own?.every ?? def.every, own: !!own };
};

// Identifiant d'onglet du jeu (sessionStorage « dofusmasters:onglet ») : le serveur refuse les actions d'un autre onglet.
function gameTabId() {
  const k = 'dofusmasters:onglet';
  try {
    let id = sessionStorage.getItem(k);
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(k, id); }
    return id;
  } catch { return null; }
}

// Valeur RSC entièrement résolue (références « $id:chemin » remplacées), pour l'état initial du combat.
function rscDeep(rows, v, depth = 0) {
  if (depth > 40) return v;
  v = rscResolve(rows, v);
  if (Array.isArray(v)) return v.map((x) => rscDeep(rows, x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rscDeep(rows, x, depth + 1)]));
  return v === '$undefined' ? undefined : v;
}

// Pioche (2026-10-09) : action { type: 'draw' }, 0 PA, une carte au hasard parmi celles du deck ni en main, ni jouées, ni
// épuisées. drawsLeft charges sur drawsMax (selon la stat Invocations, jusqu'à 4), +1 par tour. On pioche quand la charge
// serait perdue au tour suivant (déjà au max) ou quand il reste, après le meilleur plan, des PA pour une carte utile du paquet.
function wantDraw(p, pool, apLeft, blocked) {
  const left = +p.drawsLeft || 0;
  if (!(left > 0) || blocked.has('draw') || !pool.length) return false;
  return left >= (+p.drawsMax || 0) || pool.some((x) => x.ap <= apLeft);
}
const drawLabel = (p, pool) => `pioche (${(+p.drawsLeft || 0) - 1}/${+p.drawsMax || 0} restantes, ${pool.length} carte${pool.length > 1 ? 's' : ''} utile${pool.length > 1 ? 's' : ''} au paquet)`;

// Coup final : les cartes de dégâts jouables (sans buff, bouclier, soin ni gain de PA) tuent-elles tous les ennemis ce
// tour ? Ennemis du moins au plus de PV (bouclier compris) : pour chacun, la combinaison de cartes restantes la moins chère
// en PA qui le tue. Dégâts moyens estimés (cardEffect : stats, buffs, résistances et malus de la cible) × KILL_MARGIN, par
// prudence (jets bas, pas de coup critique) ; passif de classe et dégâts de zone sur les autres ennemis ignorés (bonus).
// Renvoie la première carte à jouer et sa cible, ou null (le choix par poids reprend : buffs compris).
const KILL_MARGIN = 0.85;
function lethalPlan(st, cand) {
  const p = st.fighters.p;
  const foes = Object.values(st.fighters).filter((f) => f.team !== p.team && f.alive && f.id !== 'p');
  const hits = cand.filter((x) => cardKind(x.c) === 'dmg' && !apGainOf(x.c));
  if (!foes.length || !hits.length || hits.length > 10) return null;
  let ap = +p.ap || 0, left = hits, first = null;
  for (const f of foes.sort((a, b) => a.hp - b.hp)) {
    const need = (+f.hp || 0) + (f.shields || []).reduce((t, x) => t + (+x.value || +x.v || +x.amount || 0), 0);
    const refl = reflectNow(st).get(f.id);   // Reflet : la part de l'élément renvoyé ne compte pas
    const dm = left.map((x) => cardEffect(x.c, p, f).dmg * KILL_MARGIN * (1 - reflFrac(x.c, refl)));
    let best = null;
    for (let m = 1; m < 1 << left.length; m++) {
      let d = 0, a = 0;
      for (let i = 0; i < left.length; i++) if (m & (1 << i)) { d += dm[i]; a += left[i].ap; }
      if (d >= need && a <= ap && (!best || a < best.a || (a === best.a && d < best.d))) best = { m, a, d };
    }
    if (!best) return null;
    if (!first) {   // la plus grosse carte de la combinaison, sur l'ennemi le plus faible
      const i = left.map((_, k) => k).filter((k) => best.m & (1 << k)).sort((u, v) => dm[v] - dm[u])[0];
      first = { x: left[i], tgt: f };
    }
    ap -= best.a;
    left = left.filter((_, k) => !(best.m & (1 << k)));
  }
  return first;
}

// Prochaine action : la carte la plus lourde de la meilleure combinaison jouable, sinon fin du tour.
// rules (Ascension) : mécaniques des boss → planTurn choisit l'ordre, le nombre de cartes et les cibles qui les respectent.
function chooseFightAction(st, casts, blocked, rules = null) {
  const p = st.fighters.p;
  const foes = Object.values(st.fighters).filter((f) => f.team !== p.team && f.alive && f.id !== 'p').sort((a, b) => a.hp - b.hp);
  // cible d'une carte : l'ennemi le plus faible qui ne renvoie pas (Reflet) l'élément de toute la carte
  const reflected = reflectNow(st);
  const targetFor = (c) => foes.find((f) => reflFrac(c, reflected.get(f.id)) < 1) || null;
  const target = foes[0];
  const lowHp = p.maxHp > 0 && (p.hp * 100) / p.maxHp < (+cfg.autoHealBelow || 0);
  const cards = (p.hand || []).map((uid) => p.cards?.[uid]).filter(Boolean).map((c) => ({ c, key: c.id, weapon: false }));
  if (p.weaponCard && !p.weaponUsed) cards.push({ c: p.weaponCard, key: WEAPON_KEY, weapon: true });
  const usable = (x) => {
    const { w, every } = weightOf(x.c, x.weapon);
    const ap = +x.c.ap || 0;
    if (!(w > 0) || ap > p.ap || p.sealed?.includes(x.c.uid) || blocked.has(x.c.uid)) return null;
    if (needsTarget(x.c) && !targetFor(x.c)) return null;
    if (cardKind(x.c) === 'heal' && !lowHp && !rules) return null;   // Ascension : le plan du tour pèse le soin réel
    if (every > 0 && casts[x.key] != null && p.turnNo - casts[x.key] < every) return null;
    return { ...x, w, ap };
  };
  const cand = cards.map(usable).filter(Boolean);
  // paquet de pioche : cartes utiles qu'on pourrait tirer
  const out = new Set([...(p.hand || []), ...(p.played || []), ...(p.exhausted || [])]);
  const pool = +p.drawsLeft > 0 ? Object.values(p.cards || {}).filter((c) => c?.uid && !out.has(c.uid))
    .map((c) => usable({ c, key: c.id, weapon: false })).filter(Boolean) : [];
  const draw = { action: { type: 'draw' }, label: drawLabel(p, pool) };
  if (rules) {
    const plan = planTurn(st, cand, rules);
    const why = plan.notes.length ? ` [${plan.notes.join(' · ')}]` : '';
    const apLeft = p.ap - plan.plan.reduce((t, { x }) => t + x.ap - apGainOf(x.c), 0);
    if (wantDraw(p, pool, apLeft, blocked)) return { ...draw, label: draw.label + why };
    if (!plan.pick) return { action: { type: 'end' }, label: `fin du tour${why}` };
    const tg = needsTarget(plan.pick.c) ? plan.target || target : null;
    return { action: { type: 'play', card: plan.pick.c.uid, target: tg?.id }, pick: plan.pick,
      label: `${plan.pick.c.name}${tg ? ` → ${tg.name}` : ''}${why}` };
  }
  // coup final possible sans buff : on ne joue que les dégâts (PA et temps gagnés), cible choisie par le plan
  const fin = lethalPlan(st, cand);
  if (fin) return { action: { type: 'play', card: fin.x.c.uid, target: fin.tgt.id }, pick: fin.x, label: `${fin.x.c.name} → ${fin.tgt.name} (coup final, sans buff)` };
  // meilleure combinaison (main de quelques cartes : on les essaie toutes) ; à égalité, la moins chère en PA
  let best = null;
  const n = Math.min(cand.length, 12);
  for (let m = 1; m < 1 << n; m++) {
    let w = 0, ap = 0;
    for (let i = 0; i < n; i++) if (m & (1 << i)) { w += cand[i].w; ap += cand[i].ap; }
    if (ap > p.ap) continue;
    if (!best || w > best.w || (w === best.w && ap < best.ap)) best = { m, w, ap };
  }
  if (wantDraw(p, pool, p.ap - (best?.ap || 0), blocked)) return draw;
  if (!best) return { action: { type: 'end' }, label: 'fin du tour' };
  const pick = cand.filter((_, i) => best.m & (1 << i)).sort((a, b) => b.w - a.w || b.ap - a.ap)[0];
  const tg = needsTarget(pick.c) ? targetFor(pick.c) : null;
  return { action: { type: 'play', card: pick.c.uid, target: tg?.id }, pick, label: `${pick.c.name}${tg ? ` → ${tg.name}` : ''}` };
}

// useGameAuto : sur cette page, on laisse l'Auto du jeu (état illisible, combat déjà en Auto, erreur…).
let weightedBusy = false, useGameAuto = false, weightedDoneAt = 0;
// État de départ du combat, capté par netwatch dans la réponse de lancement : évite de recharger /combat.
let fightInit = null;
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.type !== 'dm-fight-init' || typeof e.data.json !== 'string') return;
  try { fightInit = { st: withFullLog(rscDeep({}, JSON.parse(e.data.json))), at: Date.now() }; } catch { return; }
  if (!weightsOn() || !isOwner()) return;
  // La boucle du pilote attend 3 s après chaque clic de lancement : on démarre le combat sans elle, dès que la page est
  // sur /combat (lancement depuis /aventure ou /chasse : le temps que le jeu y navigue).
  (async () => {
    for (let i = 0; i < 40 && !location.pathname.startsWith('/combat'); i++) await sleep(50);
    if (location.pathname.startsWith('/combat') && cfg.botFight && !weightedBusy && !useGameAuto && weightsOn() && isOwner()) weightedFight();
  })();
});
// ID de la server action du combat : gardé pour l'onglet ; relu dans les chunks seulement s'il est refusé.
const FIGHT_ID_KEY = 'dmFightActionId';
const cachedFightId = () => { try { return sessionStorage.getItem(FIGHT_ID_KEY) || FIGHT_ACTION_FALLBACK; } catch { return FIGHT_ACTION_FALLBACK; } };
async function refreshFightId() {
  const id = await findAction((await fetchFlight('/combat')).chunks, 'fightAction', FIGHT_ACTION_FALLBACK);
  try { sessionStorage.setItem(FIGHT_ID_KEY, id); } catch { /* rien */ }
  return id;
}
// manual = { stop, status(texte) } : combat lancé à la main (Kralamoure…), joué par poids à la demande, sans le pilote.
async function weightedFight(manual = null) {
  if (weightedBusy) return;
  weightedBusy = true;
  let reload = true;
  const fallback = (why) => {
    if (manual) { DM.log(`auto par poids (manuel) : ${why}`); manual.status(`⚠️ ${why}`); reload = false; return; }
    DM.log(`auto par poids : ${why} → Auto du jeu`); useGameAuto = true; reload = false;
  };
  const status = (t) => (manual ? manual.status(t) : setStatus(t));
  try {
    // état de départ : celui capté au lancement (récent), sinon la page /combat (toujours la page à la main :
    // des cartes ont pu être jouées depuis le lancement)
    let st = !manual && fightInit && Date.now() - fightInit.at < 60000 && fightInit.st?.status === 'ongoing' ? fightInit.st : null;
    fightInit = null;
    if (!st) {
      const { flight } = await fetchFlight('/combat');
      const { rows, props } = rscProps(flight, (x) => 'initial' in x && 'charId' in x);
      st = props && rscDeep(rows, props.initial);
    }
    if (!st?.fighters?.p) return fallback('état du combat introuvable');
    winUpdate(st);
    if (st.status !== 'ongoing') return;   // déjà fini : le rechargement affiche l'écran de fin
    if (st.auto) return fallback('combat déjà lancé en Auto');
    let actionId = cachedFightId(), idChecked = false;
    const tabId = gameTabId();
    // dernier tour où chaque carte a été jouée (règle « tous les X tours »), conservé pour ce combat
    const fightKey = `${st.kind}|${Object.values(st.fighters).filter((f) => f.id !== 'p').map((f) => `${f.name}:${f.maxHp}`).join(',')}`;
    let casts = {};
    try { const s = JSON.parse(sessionStorage.getItem('dmAutoCasts') || '{}'); if (s.key === fightKey) casts = s.casts || {}; } catch { /* rien */ }
    const keepCasts = () => { try { sessionStorage.setItem('dmAutoCasts', JSON.stringify({ key: fightKey, casts })); } catch { /* rien */ } };
    // Ascension : mécaniques des boss présents à l'étage en cours (bestiaire), respectées par le plan du tour
    let rules = null;
    if (isAsc() && st.kind === 'boss') {
      const list = await bossMechanics();
      rules = fightMechanics(st, list, +cfg.ascFloor || null, cfg.ascDiff || null);
      // mécaniques vues aux essais précédents de cet étage (les nôtres et celles des amis) : complètent le bestiaire
      if (cfg.ascFloor) {
        const seen = await Promise.race([ascSeenAll(+cfg.ascFloor), sleep(4000).then(() => [])]).catch(() => []);
        rules = mergeObserved(rules, st, seen.flatMap((a) => a.seen || []), list);
      }
      planTurn.lastEl = null;
      DM.log(`ascension${cfg.ascFloor ? ` étage ${cfg.ascFloor}` : ' (étage inconnu)'}${cfg.ascDiff ? ` (${cfg.ascDiff})` : ''} : ${rules.map((r) => `${r.bossName} — ${r.name}`).join(' ; ') || 'aucune mécanique connue'}`);
    }
    let blocked = new Set(), blockedTurn = null, errors = 0;
    for (let i = 0; i < 400 && st.status === 'ongoing'; i++) {
      if (manual ? manual.stop : !isOwner() || !cfg.botFight || !weightsOn()) { reload = false; return; }
      if (presenceDialog()) { reload = false; return; }
      if (st.currentId !== 'p') return fallback(`pas notre tour (${st.currentId})`);
      const p = st.fighters.p;
      if (blockedTurn !== p.turnNo) { blocked = new Set(); blockedTurn = p.turnNo; }
      const { action, pick, label } = chooseFightAction(st, casts, blocked, rules);
      status(`Auto par poids : tour ${p.turnNo}, ${p.ap} PA — ${label}`);
      const lo = Math.max(0, +cfg.autoActMin || 0), hi = Math.max(lo, +cfg.autoActMax || 0);
      await sleep((lo + Math.random() * (hi - lo)) * 1000);
      let res;
      try {
        res = await callAction('combat', actionId, [action, tabId, st.seq]);
      } catch (e) {
        // ID périmé (nouveau déploiement du site) : relu une fois dans les chunks, puis on réessaie
        if (!e.game && !idChecked && (e.status === 404 || e.message === 'Réponse du serveur illisible')) {
          idChecked = true;
          actionId = await refreshFightId();
          continue;
        }
        if (!e.game || ++errors > 5) throw e;
        if (/aucun combat en cours/i.test(e.message)) return;
        DM.log(`auto par poids : « ${label} » refusé (${e.message})`);
        if (action.type === 'play') { blocked.add(action.card); continue; }
        if (action.type === 'draw') { blocked.add('draw'); continue; }   // pioche refusée : plus de pioche ce tour
        return fallback(`fin de tour refusée (${e.message})`);
      }
      progress();
      if (res.wait) { await sleep(+res.wait + 100); continue; }
      if (res.presence) return;   // vérification de présence : la page rechargée l'affiche, le pilote la résout
      if (res.otherTab || !res.state) return fallback(`réponse inattendue (${Object.keys(res).join(', ')})`);
      if (pick) { casts[pick.key] = p.turnNo; keepCasts(); }
      // Onde de choc : élément de la dernière ligne qui a touché un ennemi (le jeu ne le donne pas toujours)
      if (pick && !pick.weapon && res.state.log) {
        const fresh = res.state.log.slice(-Math.max(0, (+res.state.logCount || 0) - (+st.logCount || 0)));
        const hits = fresh.filter((L) => L.t === 'dmg' && res.state.fighters[L.who]?.team !== p.team);
        if (hits.length) planTurn.lastEl = hits[hits.length - 1].el;
      }
      st = withFullLog(res.state);
      winUpdate(st);
      learnCardCrits(st);
      learnCardHeals(st);
      if (res.rewards && st.status !== 'ongoing') { dropOnRewards(res.rewards, `${st.kind}|${st.logCount}`); farmOnRewards(st, res.rewards); }
      if (st.status !== 'ongoing') combatOnEnd(st, res.rewards);
    }
    if (st.status !== 'ongoing') DM.log(`auto par poids : combat ${st.status === 'won' ? 'gagné' : 'perdu'}`);
  } catch (e) {
    fallback(e.message);
  } finally {
    weightedBusy = false;
    weightedDoneAt = Date.now();   // l'anti-blocage laisse la page se recharger d'elle-même (voir stuckCheck)
    // la page n'a rien vu de nos actions : on la recharge, elle affiche l'écran de fin (ou l'état à jour)
    if (reload && (manual || isOwner())) location.reload();
  }
}

// Bouton « 🎯 Jouer par poids » sur un combat lancé à la main (Kralamoure, faille, boss…) : le combat en cours est
// joué avec les poids des cartes, comme l'Auto par poids du pilote, mais sans relance à la fin.
let manualRun = null;
function scanManualWeightsButton() {
  let b = document.querySelector('.dm-manual-weights');
  const show = location.pathname.startsWith('/combat') && modOn('weights') && !endTitle() && !(isOwner() && cfg.botFight)
    && !!document.querySelector('button') && !presenceDialog();
  if (!show && !manualRun) { b?.remove(); return; }
  if (b) return;
  b = document.createElement('button');
  b.type = 'button';
  b.className = 'dm-manual-weights';
  b.style.cssText = 'position:fixed;right:16px;bottom:80px;z-index:2147483000;max-width:min(360px,calc(100vw - 32px));padding:9px 14px;border-radius:10px;border:1px solid #c9a24a;background:#2a231a;color:#f0d78c;font:700 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 16px #000a;text-align:left';
  b.textContent = '🎯 Jouer ce combat par poids';
  b.title = 'Autopilot-DM : joue ce combat avec les poids des cartes (🎯 Poids des cartes), sans animation. Recliquer pour arrêter. La page se recharge à la fin.';
  b.addEventListener('click', () => {
    if (manualRun) { manualRun.stop = true; b.textContent = 'Arrêt…'; return; }
    if (weightedBusy) return;
    manualRun = { stop: false, status: (t) => { b.textContent = `■ ${t}`; } };
    b.textContent = '■ Lecture du combat…';
    weightedFight(manualRun).finally(() => {
      manualRun = null;
      if (b.isConnected && !b.textContent.startsWith('■ ⚠️')) b.textContent = '🎯 Jouer ce combat par poids';
      else if (b.isConnected) setTimeout(() => { if (!manualRun) b.textContent = '🎯 Jouer ce combat par poids'; }, 6000);
    });
  });
  document.body.appendChild(b);
}

// Écran de réglage : poids des cartes du deck actif (+ arme), soins et rythme.
async function openCardWeights() {
  document.querySelector('.dm-picker')?.remove();
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const ov = document.createElement('div');
  ov.className = 'dm-picker';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:#000a;display:grid;justify-items:center;align-items:start;padding:4vh 16px 16px;font:13px system-ui,sans-serif;color:#eee';
  ov.innerHTML = '<div style="background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:16px">Lecture de ton deck…</div>';
  document.body.appendChild(ov);
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', (e) => e.stopPropagation());

  // toute la collection (une entrée par carte) + la composition de chaque deck
  let all, decks, active;
  try {
    const { flight } = await fetchFlight('/deck');
    const { rows, props } = rscProps(flight, (x) => Array.isArray(x.collection) && 'initialDecks' in x);
    if (!props) throw new Error('Deck introuvable sur /deck');
    const res = (v) => rscResolve(rows, v);
    active = +res(props.initialActive) || 0;
    decks = (res(props.initialDecks) || []).map((d) => (res(d) || []).map((k) => +String(k).split(':')[0]));
    const byId = new Map();
    for (const raw of props.collection) {
      const card = rscDeep(rows, res(raw)?.card);
      if (card?.id && !byId.has(card.id)) byId.set(card.id, { ...card, name: card.n });
    }
    all = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  } catch (e) {
    ov.firstElementChild.textContent = `❌ ${e.message}`;
    return;
  }
  // arme : nom et icône de celle du dernier combat
  const wc = lastFight()?.fighters?.p?.weaponCard;
  const WEAPON = { id: WEAPON_KEY, name: wc?.name ? `Arme : ${wc.name}` : 'Arme équipée', ap: wc?.ap ?? '—', eff: [], icon: wc?.icon, iconKind: 'item' };
  const iconOf = (c) => (c.icon ? `<img src="/img/${c.iconKind === 'item' ? 'items/' : 'spells/sort_'}${+c.icon}.png" alt="" draggable="false" style="width:32px;height:32px;object-fit:contain;flex:none">`
    : '<span style="width:32px;flex:none"></span>');
  const r1 = (x) => Math.round(x * 10) / 10;
  const inp = 'background:#2a231a;border:1px solid #5a4a33;border-radius:8px;color:#eee;padding:4px 6px;font:13px system-ui,sans-serif;width:64px';
  const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:5px 10px;color:#fff;cursor:pointer;font:600 12px system-ui,sans-serif;background:#2a231a';
  ov.innerHTML = `
    <div style="width:min(640px,100%);max-height:90vh;display:flex;flex-direction:column;gap:10px;background:#1d1812;border:1px solid #5a4a33;border-radius:14px;padding:14px;box-shadow:0 10px 40px #000">
      <div style="display:flex;align-items:center;gap:8px"><b style="flex:1;font-size:15px">🎯 Poids des cartes${DM.tip('Utilisé par le mode de combat « Auto par poids ». À chaque action, le pilote garde la combinaison de cartes jouables qui tient dans tes PA avec le plus gros total de poids, et joue la plus lourde en premier. 0 = jamais jouée. « Tous les » : au plus une fois tous les N tours (buffs qui durent) ; vide ou 0 = dès que possible. Les réglages sont par carte : ils suivent la carte si tu changes de deck.')}</b><button data-a="reset" style="${btn}" data-tip="Remet les cartes affichées (et l’arme) aux valeurs par défaut : gain de PA 100, buffs 90 (relancés à la fin de leur durée), soins 80, dégâts selon leurs dégâts de base par PA, arme 30.">↺ Par défaut</button><button data-a="x" style="${btn};background:transparent">✕</button></div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;font-size:12px;color:#b9a98c">
        <label data-tip="Les cartes de soin ne sont jouées que si tes PV sont sous ce pourcentage.">Soigner sous <input data-o="autoHealBelow" type="number" min="0" max="100" style="${inp}"> % PV</label>
        <label data-tip="Pause aléatoire entre deux actions (carte ou fin de tour), en secondes.">Entre deux actions <input data-o="autoActMin" type="number" min="0" step="0.1" style="${inp}"> à <input data-o="autoActMax" type="number" min="0" step="0.1" style="${inp}"> s</label>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center" data-k="tabs"></div>
      <input data-k="q" placeholder="Rechercher une carte…" style="${inp};width:100%;display:none">
      <div style="overflow-y:auto;display:flex;flex-direction:column;gap:4px" data-k="list"></div>
      <div style="font-size:12px;color:#b9a98c">Mode de combat actuel : <b data-k="engine"></b> (menu 🤖 → Activité → Combat).</div>
    </div>`;
  const $ = (q) => ov.querySelector(q);
  let view = active;   // n° de deck affiché, ou 'all' (toute la collection)
  const byId = new Map(all.map((c) => [c.id, c]));
  const shown = () => {
    if (view === 'all') {
      const q = normName($('[data-k="q"]').value);
      return all.filter((c) => !q || normName(c.name).includes(q));
    }
    return [...new Set(decks[view] || [])].map((id) => byId.get(id)).filter(Boolean);
  };
  // cartes affichées + arme, de la plus prioritaire à la dernière jouée (à poids égal : par nom)
  const sorted = () => {
    const list = shown();
    if (!list.length) return [];
    return [...list, WEAPON].map((c) => ({ c, w: weightOf(c, c === WEAPON).w }))
      .sort((a, b) => b.w - a.w || a.c.name.localeCompare(b.c.name, 'fr')).map((x) => x.c);
  };
  const render = () => {
    $('[data-k="engine"]').textContent = cfg.fightEngine === 'weights' ? 'Auto par poids' : 'Auto du jeu';
    for (const el of ov.querySelectorAll('[data-o]')) el.value = cfg[el.dataset.o] ?? '';
    $('[data-k="tabs"]').innerHTML = decks.map((d, i) => `<button data-v="${i}" style="${btn};${view === i ? 'background:#2e6fbf' : ''}"${d.length ? '' : ' disabled'}>Deck ${i + 1}${i === active ? ' ★' : ''}</button>`).join('')
      + `<button data-v="all" style="${btn};${view === 'all' ? 'background:#2e6fbf' : ''}">Toute la collection (${all.length})</button>`;
    $('[data-k="q"]').style.display = view === 'all' ? '' : 'none';
    const list = sorted();
    $('[data-k="list"]').innerHTML = list.map((c) => {
      const weapon = c === WEAPON;
      const { w, every, own } = weightOf(c, weapon);
      const kind = weapon ? '🗡️ arme' : KIND_LABEL[cardKind(c)];
      return `<div data-row="${esc(c.id)}" style="display:flex;align-items:center;gap:8px;background:#241e16;border:1px solid #3a3024;border-radius:8px;padding:4px 8px;${w > 0 ? '' : 'opacity:.55'}">
        <span data-grip style="cursor:grab;color:#8a7d66;font-size:16px;padding:0 2px;user-select:none" title="Glisser pour changer la priorité">⠿</span>
        ${iconOf(c)}
        <span style="flex:1;min-width:0"><b>${esc(c.name)}</b> <span style="color:#b9a98c;font-size:12px">· ${esc(c.ap)} PA · ${kind}${own ? '' : ' · défaut'}</span></span>
        <label style="font-size:12px;color:#b9a98c">Poids <input data-w="${esc(c.id)}" type="number" min="0" max="100" step="0.1" value="${w}" style="${inp}"></label>
        <label style="font-size:12px;color:#b9a98c">tous les <input data-e="${esc(c.id)}" type="number" min="0" max="20" value="${every || ''}" placeholder="—" style="${inp};width:52px"> tours</label>
      </div>`;
    }).join('') || '<div style="color:#b9a98c">Aucune carte.</div>';
  };
  render();
  DM.installTips(ov);
  $('[data-k="q"]').addEventListener('input', render);
  // Glisser-déposer : la carte déplacée prend un poids entre ses nouvelles voisines (au dixième) ; s'il n'y a pas la
  // place, les cartes du dessous descendent de 0,1 pour garder l'ordre. Sous une carte à 0 (jamais jouée) → 0.
  const listEl = $('[data-k="list"]');
  let dragId = null;
  const mark = document.createElement('div');
  mark.style.cssText = 'height:3px;border-radius:2px;background:#f0d78c;margin:-2px 0';
  listEl.addEventListener('mousedown', (e) => { const row = e.target.closest('[data-grip]') && e.target.closest('[data-row]'); if (row) row.draggable = true; });
  listEl.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('[data-row]');
    if (!row?.draggable) return;
    dragId = row.dataset.row;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    setTimeout(() => { row.style.opacity = '.35'; }, 0);
  });
  const dropIndex = (y) => {
    const rows = [...listEl.querySelectorAll('[data-row]')].filter((r) => r.dataset.row !== dragId);
    const i = rows.findIndex((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
    return { rows, i: i < 0 ? rows.length : i };
  };
  listEl.addEventListener('dragover', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    const { rows, i } = dropIndex(e.clientY);
    if (i < rows.length) rows[i].before(mark); else rows[rows.length - 1]?.after(mark);
  });
  listEl.addEventListener('dragend', () => { mark.remove(); dragId = null; render(); });
  listEl.addEventListener('drop', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    const { rows, i } = dropIndex(e.clientY);
    const cardOf = (id) => (id === WEAPON_KEY ? WEAPON : byId.get(+id));
    const wOf = (id) => weightOf(cardOf(id), id === WEAPON_KEY).w;
    const ids = rows.map((r) => r.dataset.row);
    const hi = i > 0 ? wOf(ids[i - 1]) : null, lo = i < ids.length ? wOf(ids[i]) : null;
    let w;
    if (hi == null) w = Math.min(100, (lo ?? 50) + 5);
    else if (lo == null) w = hi > 0 ? Math.max(Math.min(1, hi / 2), hi - 5) : 0;
    else w = hi > 0 ? r1((hi + lo) / 2) : 0;
    w = r1(Math.max(0, Math.min(100, w)));
    if (hi != null && hi > 0 && w >= hi) w = r1(hi - 0.1);
    const next = { ...(cfg.cardWeights || {}) };
    const put = (id, v) => { next[id] = { every: weightOf(cardOf(id), id === WEAPON_KEY).every, ...next[id], w: v }; };
    put(dragId, w);
    // place à faire en dessous (aussi tout en haut quand la 1re est déjà à 100) : chaque carte reste sous la précédente
    let prev = w;
    for (let k = i; k < ids.length && prev > 0; k++) {
      const v = wOf(ids[k]);
      if (v < prev) break;
      prev = r1(Math.max(0, prev - 0.1));
      put(ids[k], prev);
    }
    save({ cardWeights: next });
    mark.remove(); dragId = null;
    render();
  });
  const setCard = (id, patch) => {
    const w = { ...(cfg.cardWeights || {}) };
    const card = id === WEAPON_KEY ? WEAPON : byId.get(+id);
    const cur = weightOf(card, id === WEAPON_KEY);
    w[id] = { w: cur.w, every: cur.every, ...patch };
    save({ cardWeights: w });
  };
  ov.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.w) setCard(t.dataset.w, { w: Math.max(0, Math.min(100, r1(+t.value || 0))) });
    else if (t.dataset.e) setCard(t.dataset.e, { every: Math.max(0, Math.min(20, Math.round(+t.value || 0))) });
    else if (t.dataset.o) save({ [t.dataset.o]: Math.max(0, +t.value || 0) });
    else return;
    render();
  });
  ov.addEventListener('click', (e) => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (v != null) { view = v === 'all' ? 'all' : +v; render(); if (view === 'all') $('[data-k="q"]').focus(); return; }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'x') close();
    if (a === 'reset') {   // cartes affichées (deck ou collection) + arme
      const w = { ...(cfg.cardWeights || {}) };
      for (const c of shown()) delete w[c.id];
      delete w[WEAPON_KEY];
      save({ cardWeights: w });
      render();
    }
  });
}

// Bouton « 🎯 Poids des cartes » sur la page /deck (module Auto par poids).
function scanDeckButton() {
  let b = document.querySelector('.dm-deck-weights');
  if (!location.pathname.startsWith('/deck') || !modOn('weights')) { b?.remove(); return; }
  if (b) return;
  b = document.createElement('button');
  b.type = 'button';
  b.className = 'dm-deck-weights';
  b.textContent = '🎯 Poids des cartes';
  b.title = 'Autopilot-DM : priorité de chaque carte pour l’Auto par poids';
  b.style.cssText = 'position:fixed;right:16px;bottom:80px;z-index:2147483000;padding:9px 14px;border-radius:10px;border:1px solid #c9a24a;background:#2a231a;color:#f0d78c;font:700 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 16px #000a';
  b.addEventListener('click', () => openCardWeights());
  document.body.appendChild(b);
}
