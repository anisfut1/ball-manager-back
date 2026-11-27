# Outils `ops/`

Scripts lancés à la main, **hors** des fonctions Vercel. Aucun n'est importé par
l'API (`src/`). Les identifiants restent sur le poste qui les lance : jamais
dans un dépôt, un message ou un journal.

| Dossier | Commande | Statut | À quoi ça sert |
|---|---|---|---|
| `fbi-local-worker/` | `npm run fbi:local-worker` | **Production** | Worker FBI sur le Mac du club : e-Marque, dérogations, calendrier, et synchro FFBB (l'API FFBB refuse l'IP de Vercel depuis le 13/10/2026). Mêmes jobs et mêmes fonctions que Vercel. Service macOS automatique : `service/install.sh`. |
| `fbi-login-test/` | `npm run fbi:login-test` | Diagnostic | Une seule connexion FBI, sans base ni job, avec sonde réseau. Pour vérifier qu'un poste ou une IP accède à FBI. |
| `fbi-session-worker/` | `npm run fbi:worker`, `fbi:worker:ctl`, `fbi:probe` | Diagnostic | Test « session persistante » sur un VPS : une session FBI tient-elle dans le temps sans nouvelle connexion ? Ne touche pas au pipeline de production. |
| `fbi-proxy/` | `install.sh` (sur un VPS) | Optionnel | Proxy Squid à IP fixe vers `*.ffbb.com`, utilisé par l'API si `FBI_PROXY_URL` est défini (voir `docs/FBI.md`). |
| `emarque-debug/` | `npm run emarque:debug-licenses` | Diagnostic | Relit les zones « licence » des feuilles e-Marque mal lues, pour régler l'OCR. |
| `docs/` | `npm run docs:routes` | Outil dev | Régénère `docs/API_ROUTES.md` depuis les routes réellement montées. À relancer après tout ajout ou retrait de route. |

Un nouvel outil ajouté ici doit avoir une ligne dans ce tableau, avec son statut.
