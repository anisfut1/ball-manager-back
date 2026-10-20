# Worker FBI local (Mac du club)

Exécute le traitement FBI de production (récupération des feuilles e-Marque,
dérogations, calendrier : mêmes jobs, mêmes fonctions que Vercel) depuis un
poste dont l'accès à FBI fonctionne. Le parsing des feuilles et les stats
restent faits par l'API.

## Mise en route (une fois)

```bash
cd ~/fbi-test && git pull && npm ci
```

Créer `~/fbi-test/.env.fbi-local` (jamais commité) avec les 4 valeurs copiées
depuis Vercel → projet Vercel `club-manager-api` → Settings → Environment Variables :

```
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
FBI_CREDENTIALS_ENCRYPTION_KEY=...
```

Ces clés donnent accès à la base : elles restent sur ce poste, jamais dans un
message ni un dépôt.

`FBI_CREDENTIALS_ENCRYPTION_KEY` illisible (variable « Sensitive » sur Vercel) :
ne pas la mettre. Le worker demande alors le mot de passe FBI au démarrage
(masqué, gardé en mémoire le temps du processus, jamais écrit). L'identifiant
est lu en base. `SUPABASE_SERVICE_ROLE_KEY` : Supabase → Project Settings → API
Keys → `service_role` → Reveal.

## Synchro FFBB depuis ce poste

Depuis le 13/10/2026, l'API FFBB (api.ffbb.app) refuse l'adresse de Vercel
(HTTP 403) mais répond depuis le poste du club. Le worker fait donc aussi la
synchronisation FFBB (matchs, scores, classements) :

- à chaque passe, il pose le bail `platform_settings.ffbb_local_until`
  (30 min) : tant qu'il court, Vercel ne synchronise plus FFBB ;
- il synchronise les clubs dus, avec la même planification que Vercel
  (toutes les 60 min ; pause de 6 h après un refus 403, même depuis ce poste) ;
- le bouton « Synchroniser » de l'appli rend la synchro due : elle part à la
  passe suivante du worker ;
- à l'arrêt (Ctrl+C), le bail est libéré et Vercel reprend la main ; poste
  éteint : le bail expire seul au bout de 30 min.

`FFBB_LOCAL=0` dans `.env.fbi-local` pour laisser FFBB à Vercel.

Notifications « Match modifié / annulé » nées d'une synchro faite ici : le
worker les met en file (`notification_outbox`) sans les envoyer ; c'est le
cron Vercel `/internal/cron/push` qui les envoie (les clés APNs ne quittent
pas Vercel). Délai : celui du cron (environ 40 min).

## Lancer

```bash
npm run fbi:local-worker
```

- **Une seule session FBI, gardée ouverte** : un navigateur lancé au démarrage,
  une connexion, puis la même session réutilisée à chaque passe ; aucune
  connexion tant qu'elle est authentifiée, aucune déconnexion.
- Chaque passe (5 min, `FBI_LOCAL_INTERVAL_MIN`) : nouveaux matchs joués → recherche de feuille créée ; FBI joignable ? → session encore authentifiée (page
  d'accueil) ? → jusqu'à 10 jobs FBI traités dans cette session, 5 s entre deux (`FBI_LOCAL_MAX_JOBS_PER_PASS`, `FBI_LOCAL_PAUSE_MS`). Sans job, la passe vérifie seulement la session.
- Recherches e-Marque uniquement pour les matchs joués de la saison sans
  feuille, aux créneaux fixes (15 min pendant 6 h, puis 1 h jusqu'à 48 h, puis
  6 h jusqu'à 7 jours) : aucun match → aucune recherche. Dérogations et
  calendrier : planifiés par le worker une fois par jour, matchs ou pas.
- Session renvoyée vers l'identification : expiration journalisée (preuves),
  traitements de la passe arrêtés ; UNE nouvelle connexion au plus tôt à la
  passe suivante (et 12 min après la précédente). `FBI_LOCAL_RELOGIN=never`
  dans `.env.fbi-local` pour l'interdire.
- Tous les jobs FBI du club passent par cette session : feuilles e-Marque,
  calendrier (`reconcile_schedule`), dérogations (`check_all_derogations`,
  `check_derogation`), licences validées (`import_licences` : export Excel de
  « Gestion des licences », filtre Validé, une fois par jour ou sur demande
  depuis la page Joueurs) et test de connexion.
  Envoi d'une dérogation officielle et réponse à une dérogation (2026-10-20) :
  tant que le worker tourne, elles passent par CETTE session — surveillées
  toutes les 4 s entre deux passes (`FBI_LOCAL_WRITE_POLL_MS`), le résultat
  revient dans l'app en quelques secondes. Worker arrêté (Ctrl+C) : Vercel
  les envoie lui-même, comme avant. Une écriture n'est jamais rejouée.
  Reste sur Vercel : « Vérifier sur FBI » d'une seule dérogation.
- Journal : `fbi-local-worker-<date>.jsonl` (sans identifiant, mot de passe
  ni valeur de cookie).
- Tant qu'il tourne, Vercel ne se connecte plus à FBI (bail de 30 min
  renouvelé à chaque passe dans `platform_settings.fbi_paused_until`).
- Ctrl+C : bail libéré (Vercel reprend immédiatement), navigateur fermé sans déconnexion FBI. Mac éteint ou en veille :
  le bail expire en 30 min et Vercel reprend seul.
- Le Mac doit rester allumé et éveillé (`caffeinate -i npm run fbi:local-worker`
  empêche la veille pendant que le worker tourne).
