// Autopilot-DM — content script : auto-diagnostic (dérive du calcul, mécaniques / effets inconnus, pages illisibles).
// Les fichiers content/*.js et content.js partagent la même portée globale (monde isolé), chargés dans l’ordre du manifest.
//
// Tout ce qui vient des données s'adapte seul ; ce diagnostic repère ce qui demande une mise à jour du code et prévient
// une seule fois par problème (message dans le jeu + Discord « erreurs »). Clic sur le message : récap copié, à coller
// à la personne qui maintient l'extension. État par personnage dans le localStorage de la page.
const SELF_KEY = 'dmSelfCheck';
const SELF_WINDOW = 400;          // coups gardés pour mesurer la dérive du calcul des dégâts
const SELF_MIN_HITS = 80;         // pas d'alerte avant ce nombre de coups comparables
const SELF_DRIFT_OK = 0.9;        // alerte si moins de 90 % des coups tombent dans la fourchette estimée
const SELF_REALERT_MS = 3 * 86400000;   // un problème déjà signalé l'est de nouveau au plus tous les 3 jours
// effets de cartes que l'extension sait interpréter (les autres sont signalés)
const KNOWN_EFFECTS = new Set([...DMG_FIXED, ...DMG_VARIABLE, 'heal', 'healPct', 'shieldHp', 'shieldLvl', 'apGain', 'apRemove', 'apSteal',
  'buff', 'debuff', 'stealStat', 'summon', 'stun']);

const selfState = () => { try { return JSON.parse(localStorage.getItem(SELF_KEY) || '{}'); } catch { return {}; } };
const selfSave = (s) => { try { localStorage.setItem(SELF_KEY, JSON.stringify(s)); } catch { /* stockage plein */ } };

// Problème repéré : noté (compteur, dernier détail) et signalé s'il est nouveau ou pas signalé depuis longtemps.
function selfIssue(key, title, detail) {
  const s = selfState();
  const it = (s.issues ||= {})[key] || { first: Date.now(), count: 0 };
  Object.assign(it, { title, detail: String(detail || '').slice(0, 600), last: Date.now(), count: it.count + 1, ext: chrome.runtime.getManifest().version });
  s.issues[key] = it;
  const fresh = !it.alerted || Date.now() - it.alerted > SELF_REALERT_MS;
  if (fresh) it.alerted = Date.now();
  selfSave(s);
  if (!fresh) return;
  DM.log(`auto-diagnostic : ${title} — ${it.detail}`);
  notify('errors', `🩺 Autopilot-DM : ${title}\n${it.detail}\n(récap : clic sur le message dans le jeu, ou menu 🤖 → 🩺 Diagnostic)`);
  tradeToast(`🩺 ${title} — clique pour copier le récap à transmettre`, 'err', () => selfCopy());
}
// Problème résolu (ex. calcul de nouveau juste) : retiré de la liste.
function selfClear(key) {
  const s = selfState();
  if (s.issues?.[key]) { delete s.issues[key]; selfSave(s); }
}
function selfRecap() {
  const s = selfState();
  const d = s.dmg || { hits: [] };
  const by = {};
  for (const h of d.hits) { const b = (by[h.c] ||= { ok: 0, n: 0, r: [] }); b.n++; if (h.ok) b.ok++; else b.r.push(h.r); }
  const lines = [
    `Autopilot-DM ${chrome.runtime.getManifest().version} — auto-diagnostic du ${new Date().toLocaleString('fr-FR')}`,
    ...Object.entries(s.issues || {}).map(([k, it]) => `• [${k}] ${it.title} (×${it.count}, dernier ${new Date(it.last).toLocaleString('fr-FR')}, v${it.ext}) : ${it.detail}`),
    `Calcul des dégâts (derniers coups comparables) : ${d.hits.filter((h) => h.ok).length}/${d.hits.length} dans la fourchette`,
    ...Object.entries(by).filter(([, b]) => b.ok < b.n).map(([c, b]) => `   ${c} : ${b.ok}/${b.n} — ratios hors fourchette ${b.r.slice(-8).map((x) => x.toFixed(2)).join(' ')}`),
  ];
  return lines.join('\n');
}
async function selfCopy() {
  try { await navigator.clipboard.writeText(selfRecap()); tradeToast('🩺 Récap copié : colle-le à la personne qui maintient l’extension', 'ok'); } catch { /* presse-papiers refusé */ }
}

// Fin de combat (journal complet) : dérive du calcul, mécaniques inconnues, effets de cartes inconnus.
function selfCheckFight(st) {
  try {
    if (!st?.fighters?.p) return;
    // 1. calcul des dégâts : coups comparables (hors coups fatals), journal complet seulement
    if (!(+st.logFrom > 0) && !((+st.logCount || 0) > (st.log?.length || 0))) {
      const { rows } = damageTest({ fighters: st.fighters, log: st.log, logCount: st.logCount, at: Date.now() }, []);
      const s = selfState();
      const d = (s.dmg ||= { hits: [] });
      for (const r of rows) {
        if (r.lo == null || r.fatal) continue;
        const ok = r.v >= Math.floor(r.loR) - 1 && r.v <= Math.ceil(r.hiR) + 1;
        d.hits.push({ c: r.card, ok, r: +(r.v / ((r.loR + r.hiR) / 2 || 1)).toFixed(3) });
      }
      d.hits = d.hits.slice(-SELF_WINDOW);
      selfSave(s);
      const n = d.hits.length, ok = d.hits.filter((h) => h.ok).length;
      if (n >= SELF_MIN_HITS && ok / n < SELF_DRIFT_OK) {
        const worst = Object.entries(d.hits.reduce((m, h) => { (m[h.c] ||= [0, 0])[1]++; if (!h.ok) m[h.c][0]++; return m; }, {}))
          .sort((a, b) => b[1][0] - a[1][0]).slice(0, 3).map(([c, [bad, all]]) => `${c} ${bad}/${all} hors`).join(', ');
        selfIssue('dmg', `le calcul des dégâts dérive (${Math.round(ok / n * 100)} % de coups justes)`, `formule du jeu peut-être changée ; pires sorts : ${worst}`);
      } else if (n >= SELF_MIN_HITS) selfClear('dmg');
    }
    // 2. messages de mécanique non reconnus (boss)
    for (const o of observedMechanics(st)) {
      if (!o.name) selfIssue(`mech:${o.text.replace(/\d+/g, '#').slice(0, 60)}`, 'mécanique de boss inconnue en combat', `${o.bossName} (tour ${o.round}) : « ${o.text} »`);
    }
    // 3. effets de cartes inconnus (deck du combat)
    for (const c of [...Object.values(st.fighters.p.cards || {}), st.fighters.p.weaponCard]) {
      for (const e of c?.eff || []) {
        if (e?.k && !KNOWN_EFFECTS.has(e.k)) selfIssue(`eff:${e.k}`, `effet de carte inconnu « ${e.k} »`, `${c.name} : ${JSON.stringify(e)}`);
      }
    }
  } catch (e) { DM.log(`auto-diagnostic : ${e.message}`); }
}
// Mécaniques du bestiaire que le moteur ne sait pas contrer (nouveaux types : Carapace, Reflet…).
function selfCheckMechanics(list) {
  const known = new Set(['Fureur', 'Peau dure', 'Onde de choc', 'Malédiction des soins', 'Sceau', 'Deuxième souffle', 'Miroir', 'PA comptés',
    'Rage', 'Vol de PA', 'Échange de vie', 'Aucune mécanique cachée']);
  const unknown = new Map();
  for (const b of list || []) for (const m of b.m || []) if (!known.has(m.n) && !unknown.has(m.n)) unknown.set(m.n, `${b.n} : ${m.x}`);
  for (const [n, ex] of unknown) selfIssue(`mechlist:${n}`, `nouvelle mécanique de boss « ${n} » (non gérée par le moteur)`, ex);
}
