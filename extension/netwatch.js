// Exécuté dans le contexte de la page (world MAIN, document_start) : surveille les requêtes du jeu.
// Les server actions (en-tête Next-Action : combat, relance…) et les navigations RSC passent par window.fetch.
// Une requête sans réponse est publiée dans <html data-dm-pending="nombre:début le plus ancien"> ;
// content.js (monde isolé) la lit et recharge la page si elle traîne (voir stuckCheck).
// <html data-dm-actions="n"> : nombre de server actions lancées par la page depuis son chargement.
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
    return p;
  };
})();
