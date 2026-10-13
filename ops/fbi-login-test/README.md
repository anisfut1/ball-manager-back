# Test « une connexion FBI, rien d'autre »

Script isolé : aucune base de données, aucun job, aucune variable de
production. Il ne parle qu'à FBI (et à `checkip.amazonaws.com` pour relever
l'IP de sortie).

## Ce qu'il fait

1. Sonde réseau couche par couche **avant** : `extranet.ffbb.com` (DNS, TCP, TLS,
   HTTP, durées) + témoin `resultats.ffbb.com` (même bloc d'adresses). FBI
   injoignable → arrêt, aucune connexion.
2. Chromium local via Playwright (sans fenêtre, comme en production ; `--headed` pour la voir).
3. **Une** connexion avec le moteur de production : `BrowserFbiClient.login`,
   mêmes options que la découverte e-Marque (`lightSession: true`). Les
   identifiants sont soumis une seule fois ; seul le chargement de la page de
   connexion est retenté (jusqu'à 3 fois) s'il échoue, comme en production.
4. Aucune recherche, aucun téléchargement.
5. Fin de session comme en production : `closeSession` (déconnexion FBI puis
   fermeture). `--keep-session` : session gardée ouverte et inactive, fermée
   sans déconnexion à la fin.
6. Sondes immédiatement, puis toutes les 5 min pendant 30 min
   (`--interval-min`, `--duration-min`).
7. Aucune reconnexion, quoi qu'il arrive.
8. Journal `fbi-login-test-<date>.jsonl` : heure de chaque sonde, heure exacte
   de chaque requête de la connexion (chemins et statuts seulement — jamais
   d'identifiant, de mot de passe ni de valeur de cookie), IP de sortie.

Différences avec la production : le binaire Chromium (Playwright au lieu de
`@sparticuz/chromium` sur Vercel) et l'adresse IP.

## Étapes suivantes, une à la fois

```bash
npm run fbi:login-test -- --search 6              # connexion + UNE recherche e-Marque
npm run fbi:login-test -- --search 6 --download   # connexion + recherche + UN téléchargement
```

Fonctions de production (`findEmarqueDocuments`, avec l'identifiant de saison
en cache comme la production ; `downloadDocument`), une seule fois chacune ;
rien n'est enregistré (taille et signature ZIP seulement). La trace complète
de la session (horodatage de chaque requête) est journalisée après fermeture.

Note `tsx` : il insère un utilitaire `__name` dans le code passé à
`page.evaluate`, inconnu du navigateur ; sans correctif, la recherche « dans la
page » échouait et le moteur basculait sur son repli Node, qui n'est pas le
chemin de la production. Le script le définit dans la page (no-op).

## Sur le Mac

```bash
node -v                      # 20 ou plus ; sinon installeur macOS sur https://nodejs.org
git clone --depth 1 https://github.com/anisfut1/ball-manager-back.git ~/fbi-test
cd ~/fbi-test
npm ci
npx playwright-core install chromium
npm run fbi:login-test
```

Identifiant et mot de passe FBI demandés au clavier (mot de passe masqué).
Durée : ~31 min. Le journal est écrit dans `~/fbi-test`.

## Auto-test (sans le vrai FBI)

```bash
node ops/fbi-session-worker/fake-fbi-server.mjs &
printf 'robot\nbon\n' | FBI_TEST_BASE_URL=http://127.0.0.1:18777/fbi \
  npx tsx ops/fbi-login-test/login-once.ts --interval-min 0.05 --duration-min 0.15
```

Vérifié le 2026-10-07 : sonde avant `ok` → `connexion.fbi` 200, POST
`identification.fbi` 302, `accueil.fbi` 200 → déconnexion → 4 sondes ; le faux
FBI compte exactement 1 connexion.
