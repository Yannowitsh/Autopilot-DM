// Autopilot-DM — content script : bouton ▶/⏸, bulle + menu.
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.

// ---------- Bouton ▶ / ⏸ (au-dessus de la bulle 🤖) ----------
// ▶ : le pilote démarre sur cet onglet et relance en boucle le combat de la page : zone de chasse (/chasse?zone=…),
// aventure, ascension ; sur /combat, le type du combat est lu dans la page (onPath, onAscension, huntZone). Un combat
// qui ne se relance pas (boss de chasse, Kralamoure…) : rien ne démarre. Autre page : l'activité choisie dans le menu.
// ⏸ : arrêt du pilote.
async function playContext() {
  const p = location.pathname, zone = +new URLSearchParams(location.search).get('zone');
  const zoneName = (z) => (cfg.huntZones || []).find((x) => x.id === z)?.name || (location.pathname.startsWith('/chasse') && document.querySelector('h1')?.textContent.trim()) || `Zone ${z}`;
  if (p.startsWith('/chasse')) return zone ? { mode: 'chasse', huntZone: zone, huntZoneName: zoneName(zone), huntGroup: null, huntTarget: null } : { error: 'choisis d’abord une zone de chasse' };
  if (p.startsWith('/aventure')) return { mode: 'aventure' };
  if (p.startsWith('/ascension')) return { mode: 'ascension' };
  if (p.startsWith('/combat')) {
    const { flight } = await fetchFlight('/combat');
    const props = rscProps(flight, (x) => 'charId' in x && 'onPath' in x).props;
    if (!props) return { error: 'combat illisible' };
    if (+props.huntZone) return { mode: 'chasse', huntZone: +props.huntZone, huntZoneName: zoneName(+props.huntZone), huntGroup: null, huntTarget: null };
    if (props.onAscension) return { mode: 'ascension' };
    if (props.onPath) return { mode: 'aventure' };
    return { error: 'ce combat (boss de chasse, Kralamoure…) ne se relance pas — pour le jouer : 🎯 Jouer ce combat par poids' };
  }
  return {};
}
let playBusy = false;
async function onPlayPause() {
  if (playBusy) return;
  if (cfg.enabled && isOwner()) { send({ type: 'toggle', fromPage: true }).catch(() => {}); return; }   // ⏸
  playBusy = true;
  try {
    const ctx = await playContext();
    if (ctx.error) { tradeToast(`▶ ${ctx.error}`, 'err'); return; }
    if (dropOn() && ctx.mode) await dropStop('remplacé par ▶ sur une autre activité');
    if (sampleOn() && ctx.mode) await sampleStop('remplacé par ▶ sur une autre activité');
    if (levelOn() && ctx.mode) await levelStop('remplacé par ▶ sur une autre activité');
    await save({ ...ctx, pauseReason: null, lossStreak: 0 });
    await send({ type: 'claim', start: true, status: 'Démarrage…' }).catch(() => {});
    // combat en cours sur la page : le pilote le prend en main (Auto du jeu ou par poids), puis relance en boucle
    if (location.pathname.startsWith('/combat') && !endTitle()) { lastAutoClick = 0; await save({ botFight: true }); markLaunch(); }
    tradeToast(`▶ Pilote : ${DM.modeLabel(cfg)}`, 'ok');
  } catch (e) {
    tradeToast(`▶ ${e.message}`, 'err');
  } finally {
    playBusy = false;
  }
}

// Bulles ⚔️ / 🍀 : équipements enregistrés n° 1 (Combat : stuff dégâts) et n° 2 (Loot : stuff prospection), équipés d'un clic.
const GEAR_BUBBLES = [{ icon: '⚔️', label: 'Combat' }, { icon: '🍀', label: 'Loot' }];
const presetName = (slot) => cfg.lockState?.[myName() || '']?.presets?.find((x) => +x.slot === slot)?.name;
let gearBusy = false;
async function onGearPreset(slot, el) {
  if (gearBusy) return;
  const b = GEAR_BUBBLES[slot], name = presetName(slot) || `équipement ${slot + 1}`;
  gearBusy = true;
  el.classList.add('busy');
  try {
    await equipGearPreset(slot);
    DM.log(`équipement rapide : ${b.label} (« ${name} ») équipé`);
    tradeToast(`${b.icon} ${b.label} : « ${name} » équipé`, 'ok');
    if (/^\/(personnage|inventaire)/.test(location.pathname)) setTimeout(() => location.reload(), 600);   // page à jour
  } catch (e) {
    tradeToast(`${b.icon} ${b.label} : ${e.message}`, 'err');
  } finally {
    gearBusy = false;
    el.classList.remove('busy');
  }
}

// ---------- Bulle en bas à gauche + menu (pilote, chasse, autosell) ----------
// Shadow DOM : le CSS du site (Tailwind) ne déteint pas sur le menu, et inversement.
const MENU_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, sans-serif; }
  .bubble { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; width: 44px; height: 44px; border-radius: 50%;
    display: grid; place-items: center; font-size: 22px; cursor: pointer; user-select: none;
    background: #262a31; border: 3px solid var(--st, #666); box-shadow: 0 2px 10px rgba(0,0,0,.5); transition: transform .15s; }
  .bubble:hover { transform: scale(1.08); }
  .bubble.play { bottom: 64px; left: 16px; width: 36px; height: 36px; font-size: 15px; border-width: 2px; color: #fff; }
  .panel:not([hidden]) ~ .bubble.play, .panel:not([hidden]) ~ .bubble.gear { display: none; }
  .bubble.gear { bottom: 64px; width: 36px; height: 36px; font-size: 16px; border-width: 2px; border-color: #8a6d3b; }
  .bubble.gear.g0 { left: 60px; } .bubble.gear.g1 { left: 104px; }
  .bubble.gear.busy { opacity: .5; cursor: progress; }
  .bubble.fav { left: 64px; width: 36px; height: 36px; bottom: 16px; font-size: 16px; border-width: 2px; border-color: #c0485a; }
  .panel { position: fixed; left: 12px; bottom: 64px; z-index: 2147483647; width: 290px; max-width: calc(100vw - 24px);
    max-height: calc(100vh - 80px); overflow-y: auto; background: #1b1d22; color: #e8e6e1;
    border: 1px solid #3a3f48; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.55);
    font-size: 13px; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
  .panel[hidden], .row[hidden] { display: none; }
  .sec { background: #262a31; border-radius: 8px; padding: 9px; display: flex; flex-direction: column; gap: 7px; }
  .head { display: flex; justify-content: space-between; align-items: center; font-weight: 700; }
  .muted { color: #9aa0a8; font-size: 12px; font-weight: 400; }
  .status { font-size: 12px; overflow-wrap: anywhere; }
  button { border: 0; border-radius: 6px; padding: 7px 9px; font-weight: 600; font-size: 13px; cursor: pointer;
    color: #fff; background: #3a3f48; }
  button:hover:not(:disabled) { filter: brightness(1.15); }
  button:disabled { opacity: .6; cursor: default; }
  .seg { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px; }
  .seg button.on { background: #2e6fbf; }
  select { width: 100%; background: #14161a; color: #e8e6e1; border: 1px solid #3a3f48; border-radius: 5px; padding: 5px; font-size: 13px; }
  .num { width: 56px; background: #14161a; color: #e8e6e1; border: 1px solid #3a3f48; border-radius: 5px; padding: 4px; font-size: 12px; }
  .row { display: flex; gap: 4px; }
  .row select { flex: 1; min-width: 0; }
  .ok { color: #6fcf7a; } .err { color: #ff7b6b; }
  summary { cursor: pointer; }
  .check { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
  .rars { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; margin-bottom: 4px; }
  .locks { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; max-height: 160px; overflow-y: auto; }
  .locks li { display: flex; justify-content: space-between; align-items: center; gap: 6px; font-size: 12px; }
  .locks button { padding: 1px 7px; font-size: 12px; background: transparent; color: #9aa0a8; }
  .wanted { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
  .wanted li { background: #1b1d22; border: 1px solid #5a4a20; border-radius: 6px; padding: 5px 7px; font-size: 12px; cursor: pointer;
    display: flex; align-items: center; gap: 7px; }
  .wanted li img { width: 34px; height: 34px; object-fit: contain; flex: none; }
  .wanted li:hover { border-color: #e0b040; }
  .wanted li.old { opacity: .5; }
  .wanted b { color: #e0b040; }
  .fuse { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; }
  .fuse li { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 12px;
    background: #1b1d22; border: 1px solid #3a3f48; border-radius: 6px; padding: 5px 7px; }
  .fuse li b { color: #e0b040; }
  .fuse button { padding: 3px 8px; font-size: 12px; flex: none; background: #8a6a1a; }
  .eqstats { display: grid; grid-template-columns: auto 1fr; gap: 4px 6px; align-items: center; font-size: 12px; }
  .eqstats b { color: #e0b040; text-align: center; }
  .eqslots { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
  .eqslots.dofus { grid-template-columns: repeat(6, 1fr); }
  .eqslot { display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 4px 1px; border-radius: 7px;
    background: #1b1d22; border: 1px solid #3a3f48; font-size: 9.5px; font-weight: 600; color: #9aa0a8; min-width: 0; }
  .eqslot span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .eqslot.on { border-color: #e0b040; color: #e8e6e1; background: #2b2618; }
  .eqslot img { width: 26px; height: 26px; object-fit: contain; }
  .eqslot .em { font-size: 17px; line-height: 26px; }
  .eqslot:not(.on) img, .eqslot:not(.on) .em { opacity: .3; filter: grayscale(1); }
  .eqslot.chg { box-shadow: 0 0 0 2px #2e9e44 inset; }
  .eqplan { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; max-height: 220px; overflow-y: auto; }
  .eqplan li { background: #1b1d22; border: 1px solid #3a3f48; border-radius: 6px; padding: 4px 7px; font-size: 12px; }
  .eqplan .up { color: #6fcf7a; } .eqplan .down { color: #ff7b6b; }
`;
const ST_COLOR = { off: '#666', on: '#2e9e44', pause: '#d18b00', other: '#2e6fbf' };

let ui = null, sellArmed = null, sellBusy = false, sellResetTimer;
const fmtK = (n) => (n || 0).toLocaleString('fr-FR');
const SELL_LABEL = 'Vendre l’inventaire';

function buildUi() {
  const host = document.createElement('div');
  host.id = 'dm-pilot-ui';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${MENU_CSS}</style>
    <div class="panel" hidden>
      <div class="sec">
        <div class="head"><span>🤖 Pilote auto${DM.tip("Démarre ou arrête le pilote sur cet onglet. Il enchaîne les combats en Auto selon l’activité choisie ci-dessous. Compteur : victoires / défaites du pilote.")}</span><span class="muted" data-k="stats"></span></div>
        <div class="status" data-k="status"></div>
        <button data-k="toggle"></button>
        <div data-k="dropBox" class="muted" style="display:none;flex-direction:column;gap:3px;border:1px solid #6a3fa0;border-radius:6px;padding:6px">
          <div data-k="dropInfo"></div>
          <div class="row" style="gap:4px">
            <button data-k="dropOpen" style="padding:2px 7px;font-size:12px;flex:1" data-tip="Ouvre la bulle ❤️ Favoris, où se trouve la liste de courses (gardée) : objets, tiers, puis lancer ou relancer le farm.">🛒 Liste de courses</button>
            <button data-k="dropStop" style="padding:2px 7px;font-size:12px" data-tip="Arrête le farm de drop (le pilote s’arrête aussi). La liste de courses est gardée.">■ Arrêter</button>
          </div>
        </div>
        <div data-k="sampleBox" class="muted" style="display:none;flex-direction:column;gap:3px;border:1px solid #2b6d8a;border-radius:6px;padding:6px">
          <div data-k="sampleInfo"></div>
          <div class="row" style="gap:4px">
            <button data-k="sampleOpen2" style="padding:2px 7px;font-size:12px;flex:1">🧪 Détail par zone</button>
            <button data-k="sampleStop" style="padding:2px 7px;font-size:12px" data-tip="Arrête l’échantillonnage (le pilote s’arrête aussi).">■ Arrêter</button>
          </div>
        </div>
        <div data-k="levelBox" class="muted" style="display:none;flex-direction:column;gap:3px;border:1px solid #6a8a2b;border-radius:6px;padding:6px">
          <div data-k="levelInfo"></div>
          <div class="row" style="gap:6px;flex-wrap:wrap;font-size:12px">
            <label class="check" style="margin:0"><input type="checkbox" data-k="levelStop200"> arrêter à 200${DM.tip("Au niveau 200, le leveling s’arrête toujours (notification Discord avec le temps mis). Coché : le pilote s’arrête aussi. Décoché : il continue en chasse sur le dernier groupe.")}</label>
            <span>notif tous les <input type="number" data-k="levelEvery" min="0" max="100" class="num" style="width:44px"> niv.${DM.tip("Notification Discord tous les N niveaux pendant la montée (0 = seulement au lancement, à l’arrêt et au niveau 200). Type « 📈 Leveling » dans la popup de l’extension.")}</span>
            <button data-k="levelStopBtn" style="padding:2px 7px;font-size:12px;margin-left:auto" data-tip="Arrête le leveling (le pilote s’arrête aussi). Le chrono de cette montée est gardé : relancer le reprend.">■ Arrêter</button>
          </div>
        </div>
        <details data-k="timesBox">
          <summary class="muted">⏱ Chronomètre des combats${DM.tip("Durée moyenne d’un combat du pilote (du lancement à l’écran de fin) et de la boucle complète (d’un lancement au suivant, pauses de plus de 5 min exclues), par activité et par mode de combat. Pour comparer l’Auto du jeu et l’Auto par poids sur la durée.")}</summary>
          <div class="muted" data-k="times" style="display:flex;flex-direction:column;gap:3px;margin-top:4px"></div>
          <button data-k="timesReset" style="padding:2px 7px;font-size:12px;margin-top:4px" data-tip="Remet le chronomètre à zéro.">↺ Remettre à zéro</button>
        </details>
      </div>
      <div class="sec">
        <div class="head"><span>🗺️ Activité${DM.tip("Aventure : étapes du Chemin.\nChasse : refait en boucle un groupe d’une zone.\nAscension : étages de boss (niveau 200).\nÀ droite : ta dernière énergie connue.")}</span><span class="muted" data-k="energy"></span></div>
        <div class="seg">
          <button data-mode="aventure">Aventure</button>
          <button data-mode="chasse">Chasse</button>
          <button data-mode="ascension" data-tip="Étages de boss, débloqué au niveau 200">Ascension</button>
        </div>
        <div data-k="zoneBox">
          <div class="muted" style="margin-bottom:4px">Zone${DM.tip("Zone farmée en mode Chasse (zones à ton niveau). Par défaut le pilote attaque le groupe le plus dur ; si tu attaques toi-même un groupe, c’est celui-là qui est relancé.")}</div>
          <div class="row"><select data-k="zone"></select><button data-k="reload" data-tip="Recharger la liste des zones depuis le jeu.">↻</button></div>
          <div class="row" style="align-items:center;justify-content:space-between;margin-top:5px">
            <span class="muted" data-k="groupInfo"></span>
            <button data-k="groupReset" data-tip="Oublier le groupe choisi à la main et revenir au groupe le plus dur de la zone." style="padding:2px 7px;font-size:12px">↺ plus dur</button>
          </div>
          <div class="muted" style="margin-top:4px">Astuce : clique toi-même sur « Attaquer » dans n’importe quelle zone, le pilote relancera ce groupe en Auto.</div>
        </div>
        <div data-mod="weights">
        <div class="muted" style="margin:6px 0 4px">Combat${DM.tip("Auto du jeu : le bouton Auto du site (animations à vitesse ×1).\nAuto par poids : le pilote joue lui-même les cartes selon tes poids (🎯), sans animation, avec une courte pause entre deux actions. Récompenses entières, comme l’Auto du jeu.")}</div>
        <div class="seg" style="grid-template-columns:1fr 1fr">
          <button data-engine="game">Auto du jeu</button>
          <button data-engine="weights">Auto par poids</button>
        </div>
        <button data-k="weights" style="margin-top:4px;width:100%" data-tip="Régler la priorité de chaque carte (decks et collection) pour l’Auto par poids.">🎯 Poids des cartes</button>
        </div>
      </div>
      <div class="sec" data-mod="autosell">
        <div class="head"><span>🧹 Autosell${DM.tip("Vend au marchand, en un clic, tous les objets non équipés sauf ceux que tu conserves. 1er clic : aperçu ; 2e clic dans les 8 s : vente.")}</span></div>
        <div class="muted">Vend les objets non équipés (familiers, dofus, Rayonnants et objets 🔒 conservés).</div>
        <label class="check"><input type="checkbox" data-k="keepAbove"> Garder les objets au-dessus de mon niveau${DM.tip("Ne vend pas les objets d’un niveau supérieur à ton personnage : tu pourras les porter plus tard.")}</label>
        <div class="muted" style="margin-top:4px">Garder les raretés :${DM.tip("Les objets des raretés cochées ne sont jamais vendus par l’Autosell.")}</div>
        <div class="rars">${DM.RARITIES.map((n, i) => `<label class="check"><input type="checkbox" data-k="rar${i}"> ${n}</label>`).join('')}</div>
        <button data-k="sell">${SELL_LABEL}</button>
        <div class="status" data-k="sellMsg"></div>
        <details data-k="lockBox">
          <summary class="muted"><span data-k="lockTitle"></span>${DM.tip("Cadenas du jeu (ni vendu, ni brisé, ni fusionné, ni mis à l’HDV), synchronisés avec ce compte toutes les 5 min et après chaque clic sur un cadenas, un équipement enregistré ou la liste de drops. Tous les tiers d’un objet suivent. Verrouillés d’office : les objets des équipements enregistrés (/personnage) et de la liste de drops (option dans la bulle ❤️). Pour en ajouter : cadenas du jeu sur l’objet dans /inventaire. ✕ pour déverrouiller (aussi en jeu).")}</summary>
          <ul class="locks" data-k="locks"></ul>
          <button data-k="lockSync" style="margin-top:4px;padding:2px 7px;font-size:12px">⟳ Synchroniser maintenant</button>
        </details>
      </div>
      <div class="sec" data-mod="fusion">
        <div class="head"><span>✨ Fusion${DM.tip("3 exemplaires d’un même objet au même tier → 1 exemplaire du tier suivant (+10 % de stats), jusqu’au tier Rayonnant. Les objets portés ne sont pas touchés.")}</span><span class="muted">3 identiques → tier +1</span></div>
        <div class="row">
          <button data-k="fuseScan" style="flex:1" data-tip="Liste les objets que tu peux fusionner, avec le résultat des fusions en cascade.">Chercher les doublons</button>
          <button data-k="fuseAll" data-tip="Fusionne tout ce qui est listé, en cascade jusqu’au Rayonnant (3 T1 → 1 T2, 3 T2 → 1 Rayonnant). Au-delà (l’objet + des Rayonnants), via la liste de courses ou à la main.">Tout fusionner</button>
        </div>
        <div class="status" data-k="fuseMsg"></div>
        <ul class="fuse" data-k="fuseList"></ul>
      </div>
      <div class="sec" data-mod="equip">
        <div class="head"><span>🛡️ Auto-équipement${DM.tip("Équipe automatiquement les meilleurs objets de ton inventaire selon jusqu’à 5 caractéristiques par ordre de priorité. La 1re compte pleinement, la 2e pour 35 %, la 3e pour 15 %, puis les 4e et 5e (facultatives) pour 8 % et 4 % : elles départagent les objets proches. Un emplacement vide est toujours rempli, même par un objet sans ces stats. Chaque stat est comparée au meilleur objet du même type (ex. meilleur chapeau). Les bonus de panoplie ne sont pas pris en compte.")}</span></div>
        <div class="seg eqmode">
          <button data-eqmode="off" data-tip="Pas de vérification automatique : utilise Aperçu / Équiper ci-dessous.">Off</button>
          <button data-eqmode="semi" data-tip="Régulièrement (toutes les 3 min par défaut, réglable dans la popup de l’extension → Réglages), vérifie l’inventaire. Si un objet ferait mieux, une fenêtre le propose avec l’écart de stats : ✔ pour l’équiper, ✖ pour ne plus jamais le proposer.">Semi</button>
          <button data-eqmode="auto" data-tip="Régulièrement (toutes les 3 min par défaut, réglable dans la popup → Réglages), équipe directement les meilleurs objets (hors objets refusés en mode Semi).">Auto</button>
        </div>
        <div class="row" style="align-items:center;justify-content:space-between" data-k="eqDeclBox">
          <span class="muted" data-k="eqDecl"></span>
          <button data-k="eqDeclReset" data-tip="Oublier les objets refusés : ils pourront de nouveau être proposés." style="padding:2px 7px;font-size:12px">↺ Oublier</button>
        </div>
        <div class="eqstats">
          ${[1, 2, 3, 4, 5].map((n) => `<b>${n}</b><select data-k="eqS${n}"></select>`).join('')}
        </div>
        <div class="muted">Emplacements à optimiser${DM.tip("Clique sur un emplacement pour l’activer ou le désactiver. Un emplacement désactivé (grisé) garde son objet actuel. Les icônes des objets portés s’affichent après un aperçu ; un contour vert = l’objet de cet emplacement va changer.")}</div>
        <div class="eqslots" data-k="eqSlots"></div>
        <div class="eqslots dofus" data-k="eqDofus"></div>
        <div class="row">
          <button data-k="eqPreview" style="flex:1" data-tip="Calcule le meilleur équipement sans rien changer : liste des objets qui seraient équipés, avec l’écart sur tes caractéristiques.">🔍 Aperçu</button>
          <button data-k="eqGo" data-tip="Équipe les objets de l’aperçu (recalculé juste avant, au cas où ton inventaire a changé).">✅ Équiper</button>
        </div>
        <div class="status" data-k="eqMsg"></div>
        <ul class="eqplan" data-k="eqPlan"></ul>
      </div>
      <div class="sec" data-mod="tools">
        <div class="head"><span>📚 Tierlist des sorts${DM.tip("Classe tous tes sorts à dégâts : dégâts totaux (toutes lignes et éléments additionnés), dégâts par PA ou coût en PA, avec filtres cible unique / zone et par élément. Le cadenas met un sort en favori sur le site.")}</span></div>
        <div class="row"><button data-k="spells" data-mod="spells" style="flex:1">Ouvrir la tierlist</button><button data-k="build" data-mod="build" style="flex:1" data-tip="Cherche l’équipement qui maximise tes dégâts sur un tour (sorts, PA, panoplies, prestige ; HDV en option).">🧬 Optimiser mon build</button></div>
      </div>
      <div class="sec" data-mod="wanted">
        <div class="head"><span>🎯 Avis & 👑 archis${DM.tip("Parcourt toutes les zones de chasse et repère les groupes contenant des monstres d’avis de recherche et / ou des archimonstres (selon les cases cochées). Chaque trouvaille s’affiche ici et peut être envoyée sur Discord.")}</span><span class="muted" data-k="scanAge"></span></div>
        <div class="row" style="align-items:center;gap:10px;font-size:12px">
          <span class="muted">Chercher</span>
          <label class="check" style="margin:0"><input type="checkbox" data-k="scanWanted"> 🎯 Avis de recherche</label>
          <label class="check" style="margin:0"><input type="checkbox" data-k="scanArchi"> 👑 Archimonstres${DM.tip("Les 306 archimonstres de dofusdb (archi.js), reconnus au nom exact. Archis seuls : seules les zones avec le badge « Archi » sont scannées.")}</label>
        </div>
        <div class="row">
          <button data-k="scan" style="flex:1" data-tip="Scanne toutes les zones dans la plage de niveaux choisie (les groupes changent toutes les ~3 min).">Scanner les zones</button>
          <button data-k="scanResume" data-tip="Ne rescanne que les zones en échec lors du dernier scan.">Reprendre</button>
        </div>
        <div class="row" style="align-items:center;gap:6px;font-size:12px">
          <span class="muted">Niveaux${DM.tip("Ne scanne que les zones dont les niveaux croisent cette plage. Vide = pas de limite.")}</span>
          <input type="number" data-k="lvlMin" min="0" max="200" placeholder="min" class="num">
          <span class="muted">à</span>
          <input type="number" data-k="lvlMax" min="0" max="200" placeholder="max" class="num">
          <span class="muted" style="margin-left:auto">plus hauts d’abord</span>
        </div>
        <div class="row" style="align-items:center;gap:6px;font-size:12px">
          <span class="muted">Au moins${DM.tip("Ne garde que les groupes contenant au moins ce nombre de cibles. Avis et archis cochés tous les deux : ils s’additionnent (1 avis + 1 archi = 2 cibles).")}</span>
          <input type="number" data-k="minPerGroup" min="1" max="8" class="num">
          <span class="muted">cible(s) dans le même combat</span>
        </div>
        <label class="check"><input type="checkbox" data-k="wantedLoop"> Scanner en continu (à chaque renouvellement des groupes)${DM.tip("Relance automatiquement un scan juste après chaque renouvellement des groupes, tant que l’onglet reste ouvert.")}</label>
        <div class="status" data-k="scanMsg"></div>
        <ul class="wanted" data-k="wanted"></ul>
        <button data-k="farmStats" style="margin-top:6px;width:100%" data-tip="XP et drops (revente marchand) de chaque combat de chasse, calculés monstre par monstre (le nombre de monstres compte), ramenés à ta Sagesse / Prospection actuelles ; mesures partagées via la synchro ; estimations pour les groupes du dernier scan. Bouton ▶ pour y envoyer le pilote.">📈 Rentabilité des zones</button>
        <button data-k="archiDrops" style="margin-top:6px;width:100%" data-tip="Tout ce qui est tombé dans les combats contre des archimonstres (ou des avis de recherche), les tiens et ceux de tes amis de la synchro : par monstre, nombre de combats et taux de chaque objet ; ★ = objet que le bestiaire attribue à ce monstre.">👑 Drops d’archimonstres</button>
        <button data-k="levelStart" style="margin-top:6px;width:100%" data-tip="Monte au niveau 200 le plus vite possible, tout seul : scan régulier des zones autour de ton niveau (à chaque renouvellement des groupes), attaque du groupe qui rapporte le plus d’XP (XP mesurée, sinon estimée : les archimonstres et avis de recherche en donnent environ 3 fois plus) et du plus haut niveau que tu bats — la prudence monte toutes les 5 victoires, baisse à chaque défaite. Équipement automatique Sagesse > Puissance > Vitalité, points de caractéristiques en Sagesse dès que tu en gagnes. Au niveau 200 : arrêt et notification Discord. Chrono de chaque montée, et moyenne par Prestige.">📈 Leveling jusqu’au niveau 200</button>
        <button data-k="sampleOpen" style="margin-top:6px;width:100%" data-tip="Le pilote farme en chasse jusqu’à avoir au moins N combats mesurés dans chaque zone d’une plage de niveaux (les tiens + ceux de la synchro), en allant toujours dans la zone la moins mesurée et en variant le nombre de monstres. Pour fiabiliser 📈 Rentabilité des zones.">🧪 Échantillonner les zones</button>
        <button data-k="selfDiag" style="margin-top:6px;width:100%" data-tip="Auto-diagnostic : l'extension vérifie seule si son calcul des dégâts dérive (formule du jeu changée), si une mécanique de boss ou un effet de carte inconnu apparaît, ou si une page du jeu devient illisible. Elle prévient une fois par problème (message + Discord). Ce bouton copie le récap à transmettre.">🩺 Diagnostic</button>
      </div>
    </div>
    <div class="bubble" title="Autopilot-DM">🤖</div>
    <div class="bubble fav" data-mod="build" title="Favoris : builds enregistrés et objets à looter">❤️</div>
    <div class="bubble play" data-k="play"></div>
    <div class="bubble gear g0" data-gear="0">⚔️</div>
    <div class="bubble gear g1" data-gear="1">🍀</div>`;
  DM.installTips(root);
  const $ = (k) => root.querySelector(`[data-k="${k}"]`);
  const panel = root.querySelector('.panel');
  const bubble = root.querySelector('.bubble');
  root.querySelector('.bubble.fav').addEventListener('click', () => { setOpen(false); openFavorites(); });
  root.querySelector('.bubble.play').addEventListener('click', onPlayPause);
  for (const g of root.querySelectorAll('.bubble.gear')) g.addEventListener('click', () => onGearPreset(+g.dataset.gear, g));

  // Ouverture du panneau mémorisée pour l'onglet : il reste ouvert après les rechargements de l'avance rapide.
  const setOpen = (open) => {
    panel.hidden = !open;
    try { sessionStorage.setItem('dmPanelOpen', open ? '1' : ''); } catch {}
    if (open) renderUi();
  };
  try { panel.hidden = !sessionStorage.getItem('dmPanelOpen'); } catch {}
  bubble.addEventListener('click', () => setOpen(panel.hidden));
  // Fermeture : clic de l'utilisateur ailleurs sur la page (pas les clics du pilote) ou Échap.
  document.addEventListener('click', (e) => { if (e.isTrusted && !e.composedPath().includes(host)) setOpen(false); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

  $('toggle').addEventListener('click', () => send({ type: 'toggle', fromPage: true }).catch(() => {}));
  for (const b of root.querySelectorAll('[data-mode]')) {
    b.addEventListener('click', async () => {
      await save({ mode: b.dataset.mode });
      renderUi();
      if (b.dataset.mode === 'chasse' && !cfg.huntZones?.length) await loadZones();
    });
  }
  $('zone').addEventListener('change', () => {
    const id = +$('zone').value;
    if (!id) return;
    const z = (cfg.huntZones || []).find((x) => x.id === id);
    save({ huntZone: id, huntZoneName: z?.name || $('zone').selectedOptions[0].text, huntGroup: null });
  });
  $('groupReset').addEventListener('click', () => save({ huntGroup: null }));
  $('reload').addEventListener('click', loadZones);
  $('sell').addEventListener('click', onSell);
  $('keepAbove').addEventListener('change', () => { disarmSell(); setSellMsg(''); save({ sellKeepAbove: $('keepAbove').checked }); });
  DM.RARITIES.forEach((_, i) => $(`rar${i}`).addEventListener('change', () => {
    disarmSell(); setSellMsg('');
    save({ sellKeepRarities: DM.RARITIES.map((__, j) => j).filter((j) => $(`rar${j}`).checked) });
  }));
  $('fuseScan').addEventListener('click', () => scanFusions());
  $('spells').addEventListener('click', () => { setOpen(false); openSpellList(); });
  $('timesReset').addEventListener('click', () => save({ fightTimes: {} }));
  $('dropStop').addEventListener('click', () => dropStop('arrêté à la main'));
  $('dropOpen').addEventListener('click', () => { setOpen(false); openFavorites(); });   // liste de courses : avec les favoris
  $('weights').addEventListener('click', () => { setOpen(false); openCardWeights(); });
  for (const b of root.querySelectorAll('[data-engine]')) {
    b.addEventListener('click', async () => { await save({ fightEngine: b.dataset.engine }); renderUi(); });
  }
  $('build').addEventListener('click', () => { setOpen(false); openBuildOptimizer(); });
  $('fuseAll').addEventListener('click', () => runFusions(fuseList || []));
  $('fuseList').addEventListener('click', (e) => {
    const id = +e.target.closest('button[data-fuse]')?.dataset.fuse;
    const it = id && fuseList?.find((x) => x.id === id);
    if (it) runFusions([it]);
  });
  $('scan').addEventListener('click', () => { if (scanRunning) scanStop = true; else runScan(false); renderUi(); });
  $('scanResume').addEventListener('click', () => runScan(true));
  $('wantedLoop').addEventListener('change', () => save({ wantedLoop: $('wantedLoop').checked }));
  $('scanWanted').addEventListener('change', () => save({ scanWanted: $('scanWanted').checked }).then(renderUi));
  $('scanArchi').addEventListener('change', () => save({ scanArchi: $('scanArchi').checked }).then(renderUi));
  $('farmStats').addEventListener('click', () => { setOpen(false); openFarmStats(); });
  for (const k of ['sampleOpen', 'sampleOpen2']) $(k).addEventListener('click', () => { setOpen(false); openSampleFarm(); });
  $('sampleStop').addEventListener('click', () => sampleStop('arrêté à la main'));
  $('levelStopBtn').addEventListener('click', () => levelStop('arrêté à la main'));
  $('archiDrops').addEventListener('click', () => { setOpen(false); openArchiDrops(); });
  $('levelStart').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (b.dataset.busy) return;
    b.dataset.busy = '1';
    b.textContent = '📈 Démarrage…';
    try { await startLeveling(); } catch (err) { tradeToast(`📈 ${err.message}`, 'err'); } finally { delete b.dataset.busy; renderUi(); }
  });
  $('levelStop200').addEventListener('change', (e) => save({ levelStopAt200: e.target.checked }));
  $('levelEvery').addEventListener('change', (e) => save({ levelNotifyEvery: Math.max(0, Math.round(+e.target.value || 0)) }));
  $('selfDiag').addEventListener('click', () => selfCopy());
  // Appliqué aussitôt à la liste affichée (le scan garde tous les groupes) et aux prochaines notifications.
  $('minPerGroup').addEventListener('change', () => {
    if (!scanRunning) scanMsg = '';   // le compteur « N avis trouvé(s) » est recalculé avec le nouveau seuil
    save({ wantedMinPerGroup: Math.max(1, Math.min(8, Math.round(+$('minPerGroup').value || 1))) }).then(renderUi);
  });
  for (const k of ['lvlMin', 'lvlMax']) {
    $(k).addEventListener('change', () => {
      const v = Math.max(0, Math.min(200, Math.round(+$(k).value || 0)));
      save({ [k === 'lvlMin' ? 'wantedLvlMin' : 'wantedLvlMax']: v });   // pris en compte au prochain scan
    });
  }
  $('wanted').addEventListener('click', (e) => {
    const href = e.target.closest('li[data-href]')?.dataset.href;
    if (href) location.assign(href);   // avis encore valable : attaque directe en pilote auto ; sinon ouverture de la zone
  });
  $('locks').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-unlock]');
    if (!b) return;
    b.disabled = true;
    syncLocks({ unlock: new Set([b.dataset.unlock]), reload: true }).catch((err) => DM.log(`verrous : ${err.message}`));
  });
  $('lockSync').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await syncLocks({ force: true, reload: true }); } catch (err) { DM.log(`verrous : ${err.message}`); }
    e.target.disabled = false;
  });

  for (const n of [1, 2, 3, 4, 5]) {
    const sel = $(`eqS${n}`);
    sel.add(new Option(n === 1 ? '— choisir —' : '— aucune —', ''));
    for (const k of STAT_ORDER) sel.add(new Option(STAT_LABELS[k] || k, k));
    sel.addEventListener('change', () => {
      const stats = [1, 2, 3, 4, 5].map((i) => $(`eqS${i}`).value);
      eqPlanState = null;
      save({ equipStats: stats }).then(renderUi);
    });
  }
  const onSlotClick = (e) => {
    const b = e.target.closest('button[data-eqslot]');
    if (!b || equipBusy) return;
    const slots = { ...(cfg.equipSlots || {}) };
    slots[b.dataset.eqslot] = slots[b.dataset.eqslot] === false;
    eqPlanState = null;
    save({ equipSlots: slots }).then(renderUi);
  };
  $('eqSlots').addEventListener('click', onSlotClick);
  $('eqDofus').addEventListener('click', onSlotClick);
  for (const b of root.querySelectorAll('[data-eqmode]')) {
    b.addEventListener('click', async () => {
      await save({ equipAuto: b.dataset.eqmode });
      renderUi();
      if (b.dataset.eqmode !== 'off') autoEquipTick(true);   // première vérification tout de suite
    });
  }
  $('eqDeclReset').addEventListener('click', async () => {
    const equipDeclined = { ...(cfg.equipDeclined || {}) };
    delete equipDeclined[eqAcct()];
    eqSnooze.clear();
    await save({ equipDeclined });
    renderUi();
  });
  $('eqPreview').addEventListener('click', () => previewEquip());
  $('eqGo').addEventListener('click', () => applyEquip());

  document.body.appendChild(host);
  return { host, root, panel, bubble, $ };
}

async function loadZones() {
  ui.$('reload').disabled = true;
  try { cfg.huntZones = await DM.fetchZones(); } catch (e) { setSellMsg(`Zones de chasse : ${e.message}`, 'err'); }
  ui.$('reload').disabled = false;
  renderUi();
}

function setSellMsg(text, cls = '') {
  const el = ui.$('sellMsg');
  el.textContent = text;
  el.className = `status ${cls}`;
}

function disarmSell() {
  clearTimeout(sellResetTimer);
  sellArmed = null;
  ui.$('sell').textContent = SELL_LABEL;
  ui.$('sell').style.background = '';
}

// Autosell : 1er clic = aperçu, 2e clic (dans les 8 s) = vente.
async function onSell() {
  if (sellBusy) return;
  sellBusy = true;
  const btn = ui.$('sell');
  btn.disabled = true;
  try {
    if (!sellArmed) {
      setSellMsg('Calcul…');
      const r = await runAutosell(true);
      if (!r.ok) return setSellMsg(`❌ ${r.error}`, 'err');
      if (!r.count) return setSellMsg(`Rien à vendre. ${DM.keptSummary(r)}`);
      sellArmed = r;
      btn.textContent = `⚠️ Confirmer : ${r.count} objets (~${fmtK(r.estimate)} K)`;
      btn.style.background = '#b07400';
      setSellMsg(DM.keptSummary(r));
      sellResetTimer = setTimeout(disarmSell, 8000);
    } else {
      disarmSell();
      setSellMsg('Vente en cours…');
      const r = await runAutosell(false);
      setSellMsg(r.ok ? `✔ ${r.count} objets vendus : +${fmtK(r.kamas)} kamas` : `❌ ${r.error}`, r.ok ? 'ok' : 'err');
    }
  } finally {
    btn.disabled = false;
    sellBusy = false;
  }
}
