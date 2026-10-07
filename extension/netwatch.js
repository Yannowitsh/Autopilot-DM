// Exécuté dans le contexte de la page (world MAIN, document_start) : surveille les requêtes du jeu.
// Les server actions (en-tête Next-Action : combat, relance…) et les navigations RSC passent par window.fetch.
// Une requête sans réponse est publiée dans <html data-dm-pending="nombre:début le plus ancien"> ;
// content.js (monde isolé) la lit et recharge la page si elle traîne (voir stuckCheck).
// <html data-dm-actions="n"> : nombre de server actions lancées par la page depuis son chargement.
// <html data-dm-fight-end="won|lost:heure"> : une réponse de combat contient l'état final (le serveur joue tout le
// combat Auto d'un coup ; la page ne fait ensuite que rejouer l'animation) → utilisé par le « combat rapide ».
// Chaque état de combat reçu est aussi transmis à content.js (postMessage « dm-fight ») : stats du personnage
// et journal des coups, pour la tierlist des sorts et son test de calcul.
(() => {
  if (window.__dmNetwatch) return;
  window.__dmNetwatch = true;
  if (document.documentElement) document.documentElement.dataset.dmNetwatch = '1';   // content.js sait que la surveillance tourne
  const pending = new Map();
  let seq = 0, actions = 0;
  const publish = () => {
    const el = document.documentElement;
    if (!el) return;
    if (pending.size) el.dataset.dmPending = `${pending.size}:${Math.min(...pending.values())}`;
    else delete el.dataset.dmPending;
  };
  const tracked = (input, init) => {
    try {
      const h = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      if (h.has('next-action')) return 'action';
      return h.has('rsc') && !h.has('next-router-prefetch') ? 'rsc' : null;
    } catch {
      return null;
    }
  };
  // Objet « "initial":{…} » (état de départ du combat) d'une réponse de lancement, en texte JSON.
  const initialState = (t) => {
    const i = t.indexOf('"initial":{"v":');
    if (i < 0) return null;
    let depth = 0, str = false;
    for (let k = i + 10; k < t.length; k++) {
      const c = t[k];
      if (str) { if (c === '\\') k++; else if (c === '"') str = false; continue; }
      if (c === '"') str = true;
      else if (c === '{' || c === '[') depth++;
      else if ((c === '}' || c === ']') && --depth === 0) return t.slice(i + 10, k + 1);
    }
    return null;
  };
  const orig = window.fetch;
  window.fetch = function (input, init) {
    const kind = tracked(input, init);
    if (!kind) return orig.apply(this, arguments);
    if (kind === 'action' && document.documentElement) document.documentElement.dataset.dmActions = String(++actions);
    const id = ++seq;
    pending.set(id, Date.now());
    publish();
    const done = () => { pending.delete(id); publish(); };
    const p = orig.apply(this, arguments);
    p.then(done, done);
    if (kind === 'action') {
      p.then((r) => r.clone().text()).then((t) => {
        const m = t.match(/"logCount":\d+,"status":"(won|lost)"/);   // état final du combat (pas « ongoing »)
        if (m && document.documentElement) document.documentElement.dataset.dmFightEnd = `${m[1]}:${Date.now()}`;
        const line = t.split('\n').find((l) => l.startsWith('1:{"state":{'));
        if (line) window.postMessage({ type: 'dm-fight', line: line.slice(2) }, location.origin);
        const init = initialState(t);   // lancement d'un combat : son état de départ (Auto par poids)
        if (init) window.postMessage({ type: 'dm-fight-init', json: init }, location.origin);
      }).catch(() => {});
    }
    return p;
  };
})();
