# Autopilot-DM

Extension Chrome : enchaîne l'Aventure ou la chasse, résout la vérification de présence, surveille l'énergie, échange des objets entre deux comptes via l'HDV et envoie des alertes sur Discord.

## Installation

1. **Code → Download ZIP** sur cette page, puis décompresse le ZIP où tu veux le garder (par exemple dans `Documents`).
2. Ouvre `chrome://extensions` et active le **Mode développeur** (en haut à droite).
3. **Charger l'extension non empaquetée**, puis choisis le dossier **`extension`**.
4. Pour l'échange entre deux comptes : dans **Détails** de l'extension, active **« Autoriser en navigation privée »**.

## Mises à jour

Quand une nouvelle version sort, la popup de l'extension l'indique et un message s'affiche en jeu :

1. Clique **« ⬇️ Installer »** dans la popup, ou sur le message en jeu.
2. Sur la page qui s'ouvre, clique **« Installer la mise à jour »**. L'extension télécharge la nouvelle version, remplace ses fichiers et se recharge toute seule. Les onglets du jeu se rechargent aussi.

**La première fois**, Chrome te demande de choisir le dossier `extension`, celui indiqué dans `chrome://extensions` → Détails → « Chargée depuis », puis d'autoriser sa modification. Coche **« Autoriser à chaque visite »** si Chrome le propose : ensuite, c'est un seul clic.

En secours, tu peux aussi double-cliquer **`mettre-a-jour.bat`** dans le dossier `extension`, puis recharger l'extension dans `chrome://extensions`.

Tes réglages (webhook Discord, objets verrouillés, file d'échange…) sont conservés : ils sont stockés dans Chrome, pas dans le dossier.

## Auto-équipement

Dans le menu 🤖 en jeu, section **🛡️ Auto-équipement** : choisis jusqu'à 5 caractéristiques par ordre de priorité (la 1re compte pleinement, la 2e pour 35 %, la 3e pour 15 %, les 4e et 5e, facultatives, pour 8 % et 4 %) ; un emplacement vide est toujours rempli, même par un objet qui n'a aucune de ces stats et les emplacements à optimiser (clic sur un emplacement pour l'activer ou le désactiver). **🔍 Aperçu** montre les objets qui seraient équipés et l'écart de stats, **✅ Équiper** les équipe. Les bonus de panoplie ne sont pas pris en compte.

Le sélecteur **Off / Semi / Auto** vérifie l'inventaire toutes les 3 minutes (jamais pendant un combat) :
- **Auto** équipe directement les meilleurs objets ;
- **Semi** ouvre une fenêtre qui propose chaque changement avec l'écart de stats (gagnées en vert, perdues en rouge) : **✔ Équiper** ou **✖ Non** (l'objet n'est plus jamais proposé ; **↺ Oublier** efface ces refus). Fermer la fenêtre avec ✕ la repropose 30 minutes plus tard.

## Échange entre deux comptes

Connecte un compte dans une fenêtre normale et l'autre dans une fenêtre de navigation privée. Sur `/inventaire` ou dans l'onglet *Vendre* de l'HDV :

- **🔁 Échanger** sur un objet : il est mis en vente à 1 kamas et l'autre compte l'achète aussitôt.
- **➕ File** ou **📋 Sélection** (panneau en haut à droite) : prépare plusieurs objets, puis **Tout échanger**. Un récap s'affiche à la fin (envoyés, perdus, non envoyés, sautés) et **🕘** ouvre l'historique de tous les échanges.

L'échange ne fonctionne qu'entre les onglets de ton propre navigateur. Si l'achat échoue, l'annonce est retirée automatiquement.

## Tierlist des sorts

Menu 🤖 → **📚 Tierlist des sorts** : relit ta collection (/deck) à chaque ouverture et classe tous tes sorts à dégâts. Toutes les lignes de dégâts d'un sort sont additionnées, même sur des éléments différents ; les lignes à x % de chance comptent en moyenne (🎲). Filtres cible unique / zone, élément (ou multi-éléments), favoris ; tris par dégâts totaux, dégâts par PA, coût en PA ou nom (re-clic = sens inverse). Le cadenas 🔓/🔒 met le sort en favori sur le site. Par défaut : dégâts de base des cartes. L'interrupteur **Avec mes stats** recalcule avec tes caractéristiques (lues sur ton dernier combat), sur une cible sans résistances. **🧪 Tester le calcul** compare l'estimation aux vrais coups de ton dernier combat (« Copier le récap » pour l'envoyer). Les sorts dont les dégâts dépendent de la vie ne sont pas classés.

## Optimiseur de build

Menu 🤖 → **🧬 Optimiser mon build** : cherche l'équipement qui maximise tes dégâts sur un tour, c'est-à-dire la meilleure combinaison de N sorts de dégâts (réglable) qui tient dans tes PA, sur une cible sans résistances. Prend en compte la fusion, le prestige (+25 % de stats d'équipement par niveau), les PA gagnés par l'équipement et les **bonus de panoplie** (lus sur dofusdb ; le jeu applique le palier d'indice = nombre d'objets portés). Options : **Redistribuer mes points** (coché par défaut : tous tes points de caractéristiques sont considérés comme redistribuables, l'optimiseur choisit équipement et répartition ensemble, en tenant compte des paliers de coût ; à appliquer après réinitialisation sur ta fiche), **PV minimum** (vide = sans contrainte, atteint d'abord via la Vitalité), **PA minimum** (vide = sans contrainte), **Inclure la banque** (objets de ton autre compte, onglet ouvert dans l'autre fenêtre, sauf ceux encore liés < 24 h ; bouton 📦 pour les mettre dans sa file d'échange), **sorts du deck actif uniquement**, **fouiller l'HDV** (objets en vente proposés avec leur prix). Avec l'HDV : champ **Budget** (vide = sans limite) pour que tous les achats du build tiennent dedans, bouton **🛒 Acheter** (2e clic pour confirmer) sur chaque objet à acheter, et **🚫** pour mettre un objet en liste noire (liste consultable dans la fenêtre, ✕ pour en retirer). **✅ Équiper ce build** équipe les objets que tu possèdes (y compris ceux que tu viens d'acheter). Équiper un build optimisé passe l'auto-équipement (Semi/Auto, fait pour l'XP) sur Off. **🃏 Sorts offensifs conseillés** : autant que de sorts par tour choisis, à copier ou à écrire dans le deck 3 (2e clic pour confirmer) — ses sorts de dégâts sont remplacés, ses autres cartes (buffs, soins…) conservées. « Contrôle du modèle » compare les stats calculées pour ton équipement actuel à ta fiche personnage.
