# dm-sync — synchro des mesures « 📈 Rentabilité des zones »

Worker Cloudflare (gratuit) avec une base D1. Les extensions des joueurs qui partagent la même clé envoient leurs combats de chasse
et reçoivent ceux des autres, toutes les 5 min.

## Installation (une fois, par celui qui héberge)

Dans ce dossier (`sync-worker/`) :

```sh
npx wrangler login                      # ouvre le navigateur : connexion au compte Cloudflare
npx wrangler d1 create dm-sync          # affiche un "database_id" → le coller dans wrangler.jsonc
npx wrangler secret put SYNC_KEY        # tape une clé longue (ex. 32 caractères au hasard) ; à donner à tes amis
npx wrangler deploy                     # affiche l'adresse : https://dm-sync.<compte>.workers.dev
```

Vérification : `https://dm-sync.<compte>.workers.dev/health` doit afficher `ok`. La table est créée toute seule à la première synchro.

## Dans l'extension (chaque joueur)

Popup de l'extension → **Synchro des mesures** : adresse du Worker + clé → **🔄 Enregistrer + synchroniser**.
Dans 📈 Rentabilité des zones, la colonne « Combats » montre les tiens + ceux reçus (en bleu) ; la case « mesures partagées » les retire du calcul.

## Divers

- Domaine perso : Cloudflare → Workers → dm-sync → Settings → Domains & Routes → Custom domain (le domaine doit être sur Cloudflare).
  L'extension demande alors l'autorisation pour ce domaine.
- Sauvegarde : `npx wrangler d1 export dm-sync --remote --output sauvegarde.sql`
- Tout effacer : `npx wrangler d1 execute dm-sync --remote --command "DELETE FROM fights"` (les combats déjà reçus restent dans les extensions).
- Changer la clé : `npx wrangler secret put SYNC_KEY`, puis la mettre à jour dans chaque extension.
