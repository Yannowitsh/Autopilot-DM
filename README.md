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

## Farm de drop

Dans l'optimiseur, avec **Chercher dans le bestiaire** (et **Drops de monstres uniquement**, coché par défaut : pas d'objets « bonus de victoire » ni de boss), le bouton **🐉 Aller dropper** (aussi dans la bulle ❤️ Favoris) liste tous les objets du build (à looter ou déjà possédés, pour monter leur tier) et tes objets favoris — les exemplaires que tu as déjà (inventaire + porté) sont affichés et déduits du tier voulu : coche ceux à farmer (rien n'est coché par défaut ; les « objets bonus de victoire » d'une zone sont farmables aussi, chance non publiée), ils passent dans la **liste de courses** où tu choisis le tier voulu pour chacun (T1 = 1 exemplaire, T2 = 3, T3 = 9, T4 = 27, T5 Rayonnant = 81) : la fenêtre affiche ta meilleure chance et le nombre de combats estimé. La liste de courses est gardée et se trouve dans la bulle **❤️ Favoris** (avec tes builds et objets favoris ; 🛒 + sur un favori pour l'y ajouter), même après l'arrêt du farm. **Lancer le farm** passe le pilote en mode Chasse : il scanne toutes les zones utiles et attaque le groupe qui contient le plus de monstres lâchant un objet voulu (scan refait à chaque changement de zone), compte les objets reçus en fin de combat et change de zone quand celle-ci n'a plus rien à donner ou plus de groupe utile. 5 défaites d'affilée dans une zone : elle est abandonnée (notification) et on passe à la suivante. Arrêt + notification Discord quand tout est droppé, ou quand plus aucune zone n'a de groupe utile (avec la raison). Le suivi s'affiche dans le menu 🤖 (■ Arrêter le farm) ; le mode de combat est celui choisi (Auto du jeu / par poids).

## Bouton ▶ / ⏸

Au-dessus de la bulle 🤖 : **▶** (vert) démarre le pilote sur cet onglet et relance en boucle le combat de la page — zone de chasse, aventure, ascension ; sur un combat, son type est lu dans la page (le combat en cours est pris en main). Un combat qui ne se relance pas (boss de chasse, Kralamoure…) ne démarre rien. Sur une autre page, c'est l'activité choisie dans le menu. **⏸** (rouge) arrête le pilote.

## Modules

Dans la popup de l'extension (icône en haut à droite de Chrome), bloc **Modules** : coche ou décoche chaque module (Auto par poids, Autosell, Fusion, Auto-équipement, Tierlist, Optimiseur, Avis de recherche, Échange entre comptes). Un module décoché disparaît du menu 🤖 en jeu et ses boutons sont retirés des pages du jeu. Le pilote (aventure, chasse, ascension) est toujours là.

## Auto par poids

Menu 🤖 → Activité → **Combat** : **Auto du jeu** (le bouton Auto du site) ou **Auto par poids** : le pilote joue lui-même les cartes, sans animation, avec une courte pause aléatoire entre deux actions (réglable).

**🎯 Poids des cartes** (menu 🤖, ou bouton en bas à droite de la page `/deck`) règle chaque carte, deck par deck ou dans toute la collection (avec recherche), et l'arme : à chaque action, le pilote garde la combinaison de cartes jouables qui tient dans tes PA avec le plus gros total de poids, et joue la plus lourde en premier. Poids **0** = jamais jouée ; **tous les N tours** = au plus une fois tous les N tours (pour les buffs qui durent). Les soins ne sont joués que sous un seuil de PV. Cible : l'ennemi qui a le moins de PV. Par défaut : gain de PA 100, buffs 90 (relancés à la fin de leur durée), soins 80, dégâts selon leurs dégâts de base par PA, arme 30. En cas de souci (état illisible, réponse inattendue), le combat repasse sur l'Auto du jeu.

**Combat lancé à la main** (Kralamoure, boss…) : le bouton **🎯 Jouer ce combat par poids** (en bas à droite de `/combat`) joue ce combat-là avec les mêmes poids, sans le pilote et sans relance à la fin ; recliquer l'arrête.

**⏱ Chronomètre des combats** (menu 🤖, sous le bouton Démarrer) : durée moyenne d'un combat (lancement → écran de fin) et de la boucle complète (d'un lancement au suivant, avec le combat par heure), par activité et par mode de combat, pour comparer l'Auto du jeu et l'Auto par poids sur la durée. Les pauses de plus de 5 min ne comptent pas ; ↺ remet à zéro.

## Auto-équipement

Dans le menu 🤖 en jeu, section **🛡️ Auto-équipement** : choisis jusqu'à 5 caractéristiques par ordre de priorité (la 1re compte pleinement, la 2e pour 35 %, la 3e pour 15 %, les 4e et 5e, facultatives, pour 8 % et 4 %) ; un emplacement vide est toujours rempli, même par un objet qui n'a aucune de ces stats et les emplacements à optimiser (clic sur un emplacement pour l'activer ou le désactiver). **🔍 Aperçu** montre les objets qui seraient équipés et l'écart de stats, **✅ Équiper** les équipe. Les bonus de panoplie ne sont pas pris en compte.

Le sélecteur **Off / Semi / Auto** vérifie l'inventaire toutes les 3 minutes par défaut (réglable dans la popup → Réglages, « Auto-équipement : vérif. » ; jamais pendant un combat) :
- **Auto** équipe directement les meilleurs objets ;
- **Semi** ouvre une fenêtre qui propose chaque changement avec l'écart de stats (gagnées en vert, perdues en rouge) : **✔ Équiper** ou **✖ Non** (l'objet n'est plus jamais proposé ; **↺ Oublier** efface ces refus). Fermer la fenêtre avec ✕ la repropose 30 minutes plus tard.

## Tout retirer

Sur `/inventaire`, le bouton **🧺 Tout retirer** (à gauche de « Vendre ou briser plusieurs objets ») retire tous les objets portés (2e clic pour confirmer), puis recharge la page.

## Échange entre deux comptes

Connecte un compte dans une fenêtre normale et l'autre dans une fenêtre de navigation privée. Sur `/inventaire` ou dans l'onglet *Vendre* de l'HDV :

- **🔁 Échanger** sur un objet : il est mis en vente à un petit prix aléatoire (11 à 49 kamas, pour ne pas se faire racheter par des tiers) et l'autre compte l'achète aussitôt.
- **➕ File** ou **📋 Sélection** (panneau en haut à droite) : prépare plusieurs objets, puis **Tout échanger**. Un récap s'affiche à la fin (envoyés, perdus, non envoyés, sautés) et **🕘** ouvre l'historique de tous les échanges.

**Tout échanger** envoie deux objets à la fois : le suivant est mis en vente pendant que l'autre compte achète le précédent (jamais deux exemplaires du même objet en même temps). L'échange ne fonctionne qu'entre les onglets de ton propre navigateur. Si l'achat échoue, l'annonce est retirée automatiquement.

## Tierlist des sorts

Menu 🤖 → **📚 Tierlist des sorts** : relit ta collection (/deck) à chaque ouverture et classe tous tes sorts à dégâts. Toutes les lignes de dégâts d'un sort sont additionnées, même sur des éléments différents ; les lignes à x % de chance comptent en moyenne (🎲). Filtres cible unique / zone, élément (ou multi-éléments), favoris ; tris par dégâts totaux, dégâts par PA, coût en PA ou nom (re-clic = sens inverse). Le cadenas 🔓/🔒 met le sort en favori sur le site. Par défaut : dégâts de base des cartes. L'interrupteur **Avec mes stats** recalcule avec tes caractéristiques (lues sur ton dernier combat), sur une cible sans résistances. **🧪 Tester le calcul** compare l'estimation aux vrais coups de ton dernier combat (« Copier le récap » pour l'envoyer). Les sorts dont les dégâts dépendent de la vie ne sont pas classés.

## Optimiseur de build

Menu 🤖 → **🧬 Optimiser mon build** : cherche l'équipement qui maximise tes dégâts sur un tour, c'est-à-dire la meilleure combinaison de N sorts de dégâts (réglable) qui tient dans tes PA, sur une cible sans résistances. Prend en compte la fusion, le prestige (+25 % de stats d'équipement par niveau) et le Bouclier de forge (son bonus s'ajoute à celui du prestige, lu sur /forgemagie), les PA gagnés par l'équipement les PA et PO du Prestige (P1/P4/P7 +1 PA, P2 +2 PO, P5 +3 PO), les parchemins d'arène, et les **bonus de panoplie** : ceux des panoplies que tu as déjà portées sont lus sur ta fiche (le jeu ne suit pas toujours dofusdb) et retenus ; les autres viennent de dofusdb (palier N − 1 pour N objets). Options : **Redistribuer mes points** (coché par défaut : tous tes points de caractéristiques sont considérés comme redistribuables, l'optimiseur choisit équipement et répartition ensemble, en tenant compte des paliers de coût ; bouton **📊 Appliquer cette répartition** : réinitialise si une stat doit baisser, puis répartit les points, 2e clic pour confirmer), **PV minimum** (vide = sans contrainte, atteint d'abord via la Vitalité), **PA minimum** (vide = sans contrainte), **Inclure la banque** (objets de ton autre compte, onglet ouvert dans l'autre fenêtre, sauf ceux encore liés < 24 h ; bouton 📦 pour les mettre dans sa file d'échange), **Tolérance mes objets** (en %, vide = 0 : le meilleur build d'où que viennent les objets ; sinon un objet à acheter ou looter est remplacé par un objet que tu as tant que le build reste à moins de ce pourcentage du meilleur), **sorts du deck actif uniquement**, **fouiller l'HDV** (objets en vente proposés avec leur prix). Avec l'HDV : champ **Budget** (vide = sans limite) pour que tous les achats du build tiennent dedans, bouton **🛒 Acheter** (2e clic pour confirmer) sur chaque objet à acheter, et **🚫** pour mettre un objet en liste noire (liste consultable dans la fenêtre, ✕ pour en retirer). **✅ Équiper ce build** équipe les objets que tu possèdes (y compris ceux que tu viens d'acheter). Équiper un build optimisé passe l'auto-équipement (Semi/Auto, fait pour l'XP) sur Off. **🃏 Sorts offensifs conseillés** : autant que de sorts par tour choisis, à copier ou à écrire dans le deck 3 (2e clic pour confirmer) — ses sorts de dégâts sont remplacés, ses autres cartes (buffs, soins…) conservées. À la réouverture, la fenêtre réaffiche ta dernière recherche (photo de ce moment-là ; « Lancer » la refait). « Contrôle du modèle » compare les stats calculées pour ton équipement actuel à ta fiche personnage.
