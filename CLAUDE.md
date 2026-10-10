# Autopilot-DM — notes pour Claude

Extension navigateur (Manifest V3, sans build ni dépendances) qui automatise le jeu DofusMasters
(`https://rpgmasters.houk.fr`, ancien domaine `dofusmasters.houk.fr` redirigé ; site Next.js). Utilisée par le propriétaire du dépôt et un ami. Tout est en français :
interface, commentaires, README, messages de commit.

## Conventions

- Chaque changement monte la version dans `extension/manifest.json` (correctif : 2.4.0 → 2.4.1 ; fonctionnalité : → 2.5.0).
- Message de commit : `Autopilot-DM X.Y.Z : <ce qui change>` (même version que le manifest).
- Le README décrit chaque fonctionnalité pour l'utilisateur : le mettre à jour avec le code.
- **`main` = livraison** : l'extension compare sa version à celle du manifest sur `main` et propose la mise à jour.
  Travailler sur une branche + PR ; fusionner livre la mise à jour aux utilisateurs.
- Même code pour Chrome et Firefox (ordinateur et Android) : ne pas casser l'un pour l'autre.
- Charge serveur : rester raisonnable (pas de rafales de requêtes vers le jeu).

## Carte des fichiers (`extension/`)

- `manifest.json` : Chrome lit `background.service_worker`, Firefox `background.scripts` + `browser_specific_settings`.
- `shared.js` (`DM`) : réglages par défaut (`DM.DEFAULTS`), stockage, utilitaires, notifications, boss de chasse.
  Chargé partout : service worker, content script, popup.
- `background.js` : alertes Discord, boss de chasse automatique, achat d'énergie, chiens de garde, relais entre onglets
  (échange entre comptes), vérification des mises à jour.
- `netwatch.js` : monde MAIN de la page, intercepte `window.fetch` (server actions Next.js) → attributs `data-dm-*`
  sur `<html>` et `postMessage` des états de combat.
- `content/*.js` + `content.js` : content script découpé par thème, tous dans la même portée globale (monde isolé),
  chargés dans l'ordre du manifest ; `content.js` (init) en dernier. Chaque fichier commence par une ligne qui dit
  ce qu'il contient. Principaux : `core.js` (état partagé, `shutdown`, vérification de présence), `fight.js` (`tick`,
  anti-blocage, chronomètre, écran allumé sur Android), `loop.js` (boucle du pilote), `weights.js` (auto par poids),
  `ui.js` (bouton ▶/⏸, bulle et menu 🤖), `hunt.js`, `leveling.js`, `dropfarm.js`, `build-*.js` (optimiseur),
  `trade*.js` (échange HDV), `asc*.js` (Ascension).
- `wanted.js` / `archi.js` : listes des avis de recherche et des archimonstres. `popup.*` : popup de l'extension. `update.*` + `mettre-a-jour.bat` :
  mise à jour Chrome (File System Access) ; Firefox passe par les releases GitHub (`.github/workflows/firefox.yml`).

`sync-worker/` : Worker Cloudflare (synchro des mesures et combats enregistrés), hors de l'extension.

## Vérifier

- `node --check extension/*.js extension/content/*.js` ; `npx web-ext lint -s extension --self-hosted` (0 erreur attendue).
- Chrome : Playwright avec `--load-extension` (Chromium dans `/opt/pw-browsers/chromium`).
