# Autopilot-DM

Extension Chrome : enchaîne l'Aventure ou la chasse, résout la vérification de présence, surveille l'énergie, échange des objets entre deux comptes via l'HDV et envoie des alertes sur Discord.

## Installation

1. **Code → Download ZIP** sur cette page, puis décompresse le ZIP où tu veux le garder (par exemple dans `Documents`).
2. Ouvre `chrome://extensions` et active le **Mode développeur** (en haut à droite).
3. **Charger l'extension non empaquetée**, puis choisis le dossier **`extension`**.
4. Pour l'échange entre deux comptes : dans **Détails** de l'extension, active **« Autoriser en navigation privée »**.

## Mises à jour

Quand une nouvelle version sort, la popup de l'extension l'indique (un message s'affiche aussi en jeu) :

1. Double-clique **`mettre-a-jour.bat`** dans le dossier `extension`.
2. Clique **« ↻ Recharger l'extension »** dans la popup (ou ↻ sur `chrome://extensions`).

Tes réglages (webhook Discord, objets verrouillés, file d'échange…) sont conservés : ils sont stockés dans Chrome, pas dans le dossier.

## Échange entre deux comptes

Connecte un compte dans une fenêtre normale et l'autre dans une fenêtre de navigation privée. Sur `/inventaire` ou dans l'onglet *Vendre* de l'HDV :

- **🔁 Échanger** sur un objet : il est mis en vente à 1 kamas et l'autre compte l'achète aussitôt.
- **➕ File** ou **📋 Sélection** (panneau en haut à droite) : prépare plusieurs objets, puis **Tout échanger**.

L'échange ne fonctionne qu'entre les onglets de ton propre navigateur. Si l'achat échoue, l'annonce est retirée automatiquement.
