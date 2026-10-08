// Autopilot-DM — content script : préparation d'un étage d'Ascension (boss, mécaniques, deck conseillé).
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.
//
// La page /ascension donne l'étage (props { floor }), la difficulté (« difficulté Cauchemar »), les 3 boss (<li key=monsterId>)
// et les decks ({ active, decks: [{ label, size, names }] }). Le conseiller simule des tours avec un deck de 5 cartes
// (toujours la même main) contre ces boss — mécaniques comprises, via planTurn — et cherche dans la collection les échanges
// de cartes qui améliorent le score (dégâts utiles + boucliers − PV perdus). « Appliquer » enregistre le deck dans un
// emplacement (saveDeck sur /deck) puis l'active (selectDeck sur /ascension).
const ASC_DECK_SIZE = 5;
const ASC_DECK_SLOT = 5;   // Deck 6 : réservé au deck conseillé
const SELECT_DECK_FALLBACK = '4073c2992e75439598aa66fea0fe140b07a9d11302';
// boss inconnus avant le combat ; chaque boss « mène » (ses mécaniques s'appliquent) pendant 2 tours : 1-2, 3-4, 5-6
const ASC_SIM = { hpPct: 0.7, bossHp: 15000, bossAtk: 1700, bossRes: 30, roundsPerBoss: 2 };

// Étage, difficulté, boss et decks de la page Ascension.
async function readAscPage() {
  const { flight, chunks } = await fetchFlight('/ascension');
  const floor = +(flight.match(/"floor":(\d+)/)?.[1] || 0) || null;
  const diff = flight.match(/"children":"(Initiation|Facile|Normale|Difficile|Cauchemar)"\}\]/)?.[1] || null;
  const ids = [...flight.matchAll(/\["\$","li","(\d+)",\{"className":"[^"]*border-ember/g)].map((m) => +m[1]);
  const names = [...flight.matchAll(/"src":"\/img\/monsters\/\d+\.png","alt":"([^"]+)"/g)].map((m) => m[1]);
  const bosses = ids.map((id, i) => ({ id, name: names[i] || `boss ${id}` }));
  const { rows, props } = rscProps(flight, (x) => Array.isArray(x.decks) && 'active' in x);
  const dk = props ? rscDeep(rows, props) : null;
  return { floor, diff, bosses, decks: dk?.decks || [], active: +dk?.active || 0, chunks };
}

// Toute la collection (/deck), cartes non offensives comprises, avec leurs lignes critiques apprises.
async function fetchCollection() {
  const { flight, chunks } = await fetchFlight('/deck');
  const { rows, props } = rscProps(flight, (x) => Array.isArray(x.collection) && 'initialDecks' in x);
  if (!props) throw new Error('Collection de cartes introuvable sur /deck');
  const cards = rscDeep(rows, props.collection).map((e) => e?.card && { ...e.card, usable: e.usable !== false }).filter((c) => c?.id);
  for (const c of cards) c.crit = critLinesOf(c);
  return { cards, chunks };
}

// Personnage pour la simulation : stats, PV, PA de combat et arme du dernier combat capté.
function ascSimPlayer() {
  const f = lastFight()?.fighters?.p;
  if (!f?.stats) return null;
  return { id: 'p', team: 0, kind: 'player', name: f.name, level: +f.level || 200, stats: f.stats, buffs: [], maxHp: +f.maxHp || 10000,
    basePa: +f.basePa || 12, weaponCard: f.weaponCard || null };
}

// Une carte compte si elle frappe (les cartes « une fois par combat » sont écartées : la main doit rester la même), protège, donne des PA, soigne ou affaiblit.
const usefulCard = (c) => c.usable && !c.once && (c.eff || []).some((e) => e && (DMG_FIXED.has(e.k) || /shield|apGain|apRemove|heal|buff|debuff/.test(e.k)));

// Score moyen d'un deck sur quelques tours simulés (planTurn : mécaniques, ordre, cibles).
function evalAscDeck(deck, sim) {
  let total = 0, dmg = 0, n = 0;
  for (let lead = 0; lead < sim.bosses.length; lead++) for (let k = 1; k <= ASC_SIM.roundsPerBoss; k++) {
    const round = lead * ASC_SIM.roundsPerBoss + k;
    n++;
    const cards = Object.fromEntries(deck.map((c, i) => [`c${i}`, { ...c, uid: `c${i}`, name: c.n || c.name }]));
    const p = { ...sim.p, cards, hand: Object.keys(cards), ap: sim.p.basePa, hp: sim.p.maxHp * ASC_SIM.hpPct, cardsThisTurn: 0, shields: [],
      lastEl: null, weaponUsed: false, alive: true };
    const fighters = { p };
    sim.bosses.forEach((b, i) => {
      if (i < lead) return;   // déjà tombé
      const res = Object.fromEntries(EL_RES_PCT.map((k) => [k, ASC_SIM.bossRes]));
      fighters[`b${i}`] = { id: `b${i}`, team: 1, isBoss: true, alive: true, monsterId: b.id, name: b.name, stats: res, resCap: 100,
        hp: ASC_SIM.bossHp, maxHp: ASC_SIM.bossHp, atk: ASC_SIM.bossAtk, intent: { k: 'attack', value: ASC_SIM.bossAtk } };
    });
    const st = { round, fighters, log: [], order: ['p', ...sim.bosses.map((_, i) => `b${i}`)] };
    const cand = Object.values(cards).map((c) => ({ c, key: c.id, weapon: false, w: weightOf(c).w, ap: +c.ap || 0 }));
    if (p.weaponCard) cand.push({ c: p.weaponCard, key: WEAPON_KEY, weapon: true, w: weightOf(p.weaponCard, true).w, ap: +p.weaponCard.ap || 0 });
    planTurn.lastEl = null;
    const plan = planTurn(st, cand, sim.rules);
    total += plan.score;
    dmg += plan.plan.reduce((t, q) => t + (q.x.isDmg && q.target ? cardEffect(q.x.c, p, q.target).dmg : 0), 0);
  }
  return { score: total / n, dmg: dmg / n };
}

// Deck conseillé : part du deck actif (5 cartes) ou des 5 meilleures seules, puis échanges carte par carte tant que ça gagne.
async function adviseAscDeck(page, say = () => {}) {
  const p = ascSimPlayer();
  if (!p) throw new Error('fais d’abord un combat (stats du personnage inconnues)');
  say('Lecture de ta collection…');
  const { cards, chunks } = await fetchCollection();
  const list = await bossMechanics();
  const fake = { fighters: { p: { team: 0 }, ...Object.fromEntries(page.bosses.map((b, i) => [`b${i}`, { id: `b${i}`, team: 1, isBoss: true, monsterId: b.id, name: b.name }])) } };
  const attempts = page.floor ? await ascSeenAll(page.floor).catch(() => []) : [];
  const rules = mergeObserved(fightMechanics(fake, list, page.floor, page.diff), fake, attempts.flatMap((a) => a.seen || []), list);
  const sim = { p: { ...p, _fx: new Map() }, bosses: page.bosses, rules };   // _fx : estimations partagées entre les simulations
  const byName = new Map(cards.map((c) => [c.n, c]));
  const current = (page.decks[page.active]?.names || []).map((n) => byName.get(n)).filter(Boolean);
  say('Classement des cartes…');
  const pool = cards.filter(usefulCard);
  const solo = pool.map((c) => ({ c, v: evalAscDeck([c], sim).score })).sort((a, b) => b.v - a.v);
  const cands = [...new Set([...solo.slice(0, 30).map((x) => x.c), ...current])];
  let deck = current.length === ASC_DECK_SIZE ? [...current] : solo.slice(0, ASC_DECK_SIZE).map((x) => x.c);
  let best = evalAscDeck(deck, sim).score;
  for (let pass = 0; pass < 8; pass++) {
    say(`Recherche du meilleur deck… (passe ${pass + 1})`);
    await sleep(0);
    let move = null;
    for (let i = 0; i < deck.length; i++) {
      for (const c of cands) {
        if (deck.includes(c)) continue;
        const d = deck.map((x, j) => (j === i ? c : x));
        const v = evalAscDeck(d, sim).score;
        if (v > best + 1 && (!move || v > move.v)) move = { d, v };
      }
    }
    if (!move) break;
    deck = move.d; best = move.v;
  }
  const evCur = current.length ? evalAscDeck(current, sim) : null, evNew = evalAscDeck(deck, sim);
  return { rules, current, deck, evCur, evNew, add: deck.filter((c) => !current.includes(c)), remove: current.filter((c) => !deck.includes(c)), chunks };
}

// Tour d'application d'une règle (après observation), affiché à côté du texte du bestiaire.
const ascRuleTiming = (r) => (!r.seenRound ? '' : r.k === 'mirror' ? ` <b>[tours ${r.from}–${r.to}]</b>` : r.k === 'apExact' || r.k === 'swap' ? ` <b>[tour ${r.turn}]</b>` : '');

// Raison courte d'un ajout / retrait, selon les mécaniques en jeu.
function ascCardReason(c, rules, adding) {
  const eff = c.eff || [];
  const k = new Set(rules.map((r) => r.k));
  const steals = eff.some((e) => e?.k === 'steal' || (e?.tgt === 'self' && /heal/.test(e.k)));
  const out = [];
  if (k.has('curse') && steals && !adding) out.push('vols de vie / soins : te blessent sous Malédiction des soins');
  if (eff.some((e) => /shield/.test(e?.k || ''))) out.push(k.has('shield') ? 'bouclier : indispensable contre Peau dure' : 'bouclier : encaisse les attaques des boss');
  if (eff.some((e) => e?.k === 'apGain')) out.push(`+${apGainOf(c)} PA : plus de cartes jouées par tour`);
  if (eff.some((e) => e?.k === 'apRemove' && e.tgt === 'enemy')) out.push('retire des PA : affaiblit la prochaine attaque');
  if (k.has('mirror') && eff.some((e) => e?.zone) && !adding) out.push('sort de zone : touche le boss sous Miroir');
  if (k.has('fureur') && adding && (+c.ap || 0) >= 3) out.push('carte forte : rentable avec peu de cartes par tour (Fureur)');
  if (k.has('onde') && adding && eff.some((e) => DMG_FIXED.has(e?.k))) out.push('enchaînement d’éléments compatible avec l’Onde de choc');
  if (!out.length) out.push(adding ? 'plus de dégâts utiles par tour' : 'moins utile que la carte proposée');
  return out.join(' · ');
}

// Enregistre le deck dans l'emplacement réservé puis l'active pour l'Ascension.
async function applyAscDeck(deck, page) {
  const { chunks } = await fetchFlight('/deck');
  const saveId = saveDeckId || (saveDeckId = await findAction(chunks, 'saveDeck', SAVE_DECK_FALLBACK));
  await callAction('deck', saveId, [deck.map((c) => ({ id: c.id, f: 0 })), ASC_DECK_SLOT]);
  const selId = await findAction(page.chunks, 'selectDeck', SELECT_DECK_FALLBACK);
  await callAction('ascension', selId, [ASC_DECK_SLOT]);
}

// ---------- Panneau 🧠 sur /ascension ----------
// Il prend la place du bloc « Comment ça marche » de la page (à côté des boss) ; la flèche ⇄ en haut à droite rebascule
// vers le texte du jeu (choix gardé pour l'onglet). Le site peut re-rendre ce bloc : le panneau (déjà calculé) y est remis.
// Bloc introuvable : panneau flottant en bas à droite.
const ASC_VIEW_KEY = 'dmAscView';
let ascPanelFor = null, ascPanelEl = null;
const ascShowGame = () => { try { return sessionStorage.getItem(ASC_VIEW_KEY) === 'game'; } catch { return false; } };
function scanAscPanel() {
  const on = location.pathname.startsWith('/ascension') && modOn('spells');
  if (!on) { document.querySelectorAll('.dm-asc, .dm-asc-toggle').forEach((x) => x.remove()); ascPanelFor = null; ascPanelEl = null; return; }
  if (ascPanelFor !== location.href || !ascPanelEl) {
    ascPanelFor = location.href;
    ascPanelEl = document.createElement('div');
    ascPanelEl.className = 'dm-asc';
    ascPanelEl.innerHTML = '<b>🧠 Préparer l’étage</b> <span style="color:#b9a98c">lecture de la page…</span>';
    renderAscPanel(ascPanelEl).catch((e) => { ascPanelEl.innerHTML = `<b>🧠 Préparer l’étage</b><div style="color:#ff7b6b">${e.message}</div>`; });
  }
  const aside = [...document.querySelectorAll('aside')].find((x) => /Comment ça marche/.test(x.querySelector('h3')?.textContent || ''));
  const el = ascPanelEl;
  if (!aside) {   // repli : panneau flottant
    el.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483600;width:min(420px,calc(100vw - 24px));max-height:70vh;overflow:auto;background:#1d1812;border:1px solid #5a4a33;border-radius:12px;padding:10px 12px;font:13px system-ui,sans-serif;color:#eee;box-shadow:0 8px 30px #000a';
    if (el.parentNode !== document.body) document.body.appendChild(el);
    return;
  }
  el.style.cssText = 'font:13px system-ui,sans-serif;color:#eee';
  if (getComputedStyle(aside).position === 'static') aside.style.position = 'relative';
  if (el.parentNode !== aside) aside.appendChild(el);
  let tg = aside.querySelector(':scope > .dm-asc-toggle');
  if (!tg) {
    tg = document.createElement('button');
    tg.className = 'dm-asc-toggle';
    tg.style.cssText = 'position:absolute;top:8px;right:8px;z-index:2;border:1px solid #5a4a33;border-radius:8px;padding:2px 8px;background:#2a231a;color:#eee;cursor:pointer;font:600 12px system-ui,sans-serif';
    tg.onclick = () => { try { sessionStorage.setItem(ASC_VIEW_KEY, ascShowGame() ? 'ext' : 'game'); } catch { /* rien */ } scanAscPanel(); };
    aside.appendChild(tg);
  }
  const game = ascShowGame();
  tg.textContent = game ? '🧠 ⇄' : '⇄';
  tg.title = game ? 'Revenir aux infos de l’extension (boss, mécaniques, deck conseillé)' : 'Afficher « Comment ça marche » (texte du jeu)';
  for (const c of aside.children) if (c !== el && c !== tg) c.style.display = game ? '' : 'none';
  el.style.display = game ? 'none' : '';
}
async function renderAscPanel(el) {
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const btn = 'border:1px solid #5a4a33;border-radius:8px;padding:5px 10px;color:#fff;cursor:pointer;font:600 12px system-ui,sans-serif;background:#2a231a';
  const page = await readAscPage();
  if (page.floor) save({ ascFloor: page.floor, ascDiff: page.diff || null, ascBosses: page.bosses.map((b) => b.id) });
  const list = await bossMechanics();
  const fake = { fighters: { p: { team: 0 }, ...Object.fromEntries(page.bosses.map((b, i) => [`b${i}`, { id: `b${i}`, team: 1, isBoss: true, monsterId: b.id, name: b.name }])) } };
  const attempts = page.floor ? await ascSeenAll(page.floor).catch(() => []) : [];
  const rules = mergeObserved(fightMechanics(fake, list, page.floor, page.diff), fake, attempts.flatMap((a) => a.seen || []), list);
  const head = `<div style="padding-right:44px"><b style="font-size:15px">🧠 Étage ${page.floor ?? '?'}${page.diff ? ` · ${esc(page.diff)}` : ''}</b><div style="font-size:11px;color:#8a7d66">Mécaniques du premier boss encore debout ; à sa chute, le suivant prend le relais.</div></div>`;
  const mech = page.bosses.map((b, i) => `<div style="margin-top:6px"><b>${i + 1}. ${esc(b.name)}</b>${rules.filter((r) => r.boss === `b${i}`).map((r) => `<div style="font-size:12px;color:#d8cbb3">• <b>${esc(r.name)}</b>${r.learned ? ' <span style="color:#8fd4ee" title="Absente du bestiaire pour cette difficulté, mais vue en combat à cet étage">(vue en combat)</span>' : r.seenRound ? ' <span style="color:#8fd4ee" title="Tour confirmé par un combat à cet étage">(tour confirmé)</span>' : ''} — ${esc(r.text)}${ascRuleTiming(r)}</div>`).join('') || '<div style="font-size:12px;color:#8a7d66">aucune mécanique connue</div>'}</div>`).join('');
  const deckNow = page.decks[page.active];
  const fmtAt = (t) => new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const hist = attempts.slice(0, 6).map((a) => `<div style="font-size:12px;margin-top:3px"><span style="color:${a.status === 'won' ? '#6fcf7a' : '#ff7b6b'}">${a.status === 'won' ? '✔' : '✖'}</span> <b>${esc(a.player)}</b> <span style="color:#8a7d66">${fmtAt(a.at)}${a.rounds ? `, ${a.rounds} tours` : ''}</span>${a.cause ? ` — ${esc(a.cause)}` : ''}${(a.seen || []).length ? `<div style="color:#b9a98c;padding-left:14px">vu : ${a.seen.map((o) => `${esc(o.bossName)} ${esc(o.name || o.text)} (t${o.round})`).join(' · ')}</div>` : ''}</div>`).join('');
  el.innerHTML = `${head}${mech}
    ${hist ? `<div style="margin-top:8px"><b style="font-size:12px">📜 Essais à cet étage</b>${hist}</div>` : ''}
    <div style="margin-top:8px;font-size:12px;color:#b9a98c">Deck actif : <b>${esc(deckNow?.label || '?')}</b> — ${esc((deckNow?.names || []).join(', ') || 'vide')}</div>
    <div style="margin-top:8px"><button data-a="advise" style="${btn};background:#2e6fbf">🃏 Conseiller un deck (${ASC_DECK_SIZE} cartes)</button></div>
    <div data-k="out" style="margin-top:8px"></div>`;
  const out = el.querySelector('[data-k="out"]');
  let advice = null;
  el.querySelector('[data-a="advise"]').onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      advice = await adviseAscDeck(page, (m) => { out.innerHTML = `<span style="color:#b9a98c">${esc(m)}</span>`; });
      const fmt = (n) => Math.round(n).toLocaleString('fr-FR');
      const same = !advice.add.length;
      out.innerHTML = `
        ${advice.evCur ? `<div style="font-size:12px">Dégâts estimés par tour : ${fmt(advice.evCur.dmg)} → <b>${fmt(advice.evNew.dmg)}</b> · score ${fmt(advice.evCur.score)} → <b>${fmt(advice.evNew.score)}</b></div>` : ''}
        ${same ? '<div style="color:#6fcf7a;margin-top:4px">Ton deck actif est déjà le meilleur trouvé pour cet étage.</div>' : `
        ${advice.remove.map((c) => `<div style="font-size:12px;margin-top:4px;color:#ff9b8b">− ${esc(c.n)} <span style="color:#b9a98c">(${esc(ascCardReason(c, advice.rules, false))})</span></div>`).join('')}
        ${advice.add.map((c) => `<div style="font-size:12px;margin-top:4px;color:#8fe39a">+ ${esc(c.n)} (${c.ap} PA) <span style="color:#b9a98c">(${esc(ascCardReason(c, advice.rules, true))})</span></div>`).join('')}`}
        <div style="font-size:12px;margin-top:6px">Deck conseillé : <b>${advice.deck.map((c) => esc(c.n)).join(', ')}</b></div>
        ${same ? '' : `<div style="margin-top:6px"><button data-a="apply" style="${btn};background:#2e7d32">✔ Enregistrer dans le Deck ${ASC_DECK_SLOT + 1} et l’activer</button></div>`}
        <div style="font-size:11px;color:#8a7d66;margin-top:6px">Simulation : 3 boss à ${fmt(ASC_SIM.bossHp)} PV, ${ASC_SIM.bossRes} % de résistances, attaques de ${fmt(ASC_SIM.bossAtk)} (inconnus avant le combat) ; boucliers en PV épargnés (ceux « selon le niveau » estimés, à vérifier), gain de PA compris.</div>`;
      const ap = out.querySelector('[data-a="apply"]');
      if (ap) ap.onclick = async () => {
        ap.disabled = true; ap.textContent = 'Enregistrement…';
        try {
          await applyAscDeck(advice.deck, page);
          ap.textContent = `✔ Deck ${ASC_DECK_SLOT + 1} actif`;
          DM.log(`ascension : deck conseillé appliqué (${advice.deck.map((c) => c.n).join(', ')})`);
          setTimeout(() => location.reload(), 800);
        } catch (err) { ap.disabled = false; ap.textContent = `❌ ${err.message}`; }
      };
    } catch (err) {
      out.innerHTML = `<span style="color:#ff7b6b">${esc(err.message)}</span>`;
    } finally { b.disabled = false; }
  };
}
