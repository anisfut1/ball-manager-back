# Worker de test FBI « session persistante »

Outil de **diagnostic**, séparé du pipeline de production (Vercel + workflow
GitHub), qu'il ne modifie pas. But : isoler le problème FBI à partir de
preuves dans les traces, sans supposition.

## Question testée

Une session FBI créée sur le VPS OVH reste-t-elle utilisable dans le temps
quand elle n'est réutilisée **que** depuis :

- ce worker (même processus) ;
- la même IP (VPS, accès **direct** à FBI, sans proxy : Squid est arrêté par l'installation) ;
- le même navigateur Chromium, lancé une fois et gardé ouvert ;
- le même profil Chromium (persistant sur disque) ;

et **sans aucune nouvelle authentification** ?

## Règles appliquées par le worker

| Règle | Mise en œuvre |
|---|---|
| Navigateur persistant | `launchPersistentContext` au démarrage, un seul onglet réutilisé à chaque passage ; jamais recréé. |
| Aucun login tant que la session est authentifiée | `login` vérifie d'abord la session ; si elle est valide → refus journalisé (`credential_login / refusee_session_valide`). |
| Pas de reconnexion automatique | Les identifiants ne sont jamais stockés : seule la commande `fbi-worker-ctl login` (saisie au clavier) en déclenche une, une seule tentative. |
| Renvoi vers l'identification | `session_check / redirected_to_login` + `session_expired / traitements_arretes` : plus aucun traitement authentifié jusqu'à une nouvelle connexion manuelle. |
| Panne réseau ≠ session expirée | Erreur réseau pendant la vérification → classée (`tcp_timeout`, `tcp_reset`…) + sonde couche par couche immédiate ; la session n'est **pas** déclarée expirée. |

## Ce qui est mesuré à chaque passage (toutes les 15 min)

1. `network_probe` — sonde anonyme couche par couche (`src/integrations/fbi/layered-probe.ts`) :
   DNS (adresses, durée) → ouverture TCP → TLS (protocole, émetteur et empreinte
   du certificat) → réponse HTTP (statut, `Location`, noms des cookies, serveur).
   Classement : `ok`, `redirect_to_login`, `dns_failure`, `tcp_timeout` (ETIMEDOUT),
   `tcp_reset` (ECONNRESET), `tcp_refused`, `tcp_unreachable`, `tls_*`,
   `http_timeout`, `http_reset`, `http_closed_without_response`, `http_403`,
   `http_429`, `http_5xx`, `http_4xx`. IP de sortie relevée.
2. `session_check` (si une session existe) — `accueil.fbi` dans le navigateur persistant :
   statut, chaîne de redirections, page finale, présence d'un champ mot de
   passe / d'un lien de déconnexion, cookie `JSESSIONID` avant/après (présence,
   empreinte tronquée, expiration, **changement**). Verdict : `authenticated`
   (preuve positive : lien de déconnexion, pas de mot de passe),
   `redirected_to_login`, `indeterminate`, ou la classe réseau.
3. `search` (optionnel) — recherche e-Marque en lecture seule, dans la page.

Jamais journalisé : identifiant, mot de passe, valeur d'un cookie, contenu de page.

## Installation (VPS, en root)

```bash
curl -fsSL https://raw.githubusercontent.com/anisfut1/ball-manager-back/main/ops/fbi-session-worker/install.sh \
  | sudo bash -s -- https://asihtbpfepdbafzcuosd.supabase.co <CLÉ_ANON_PUBLIQUE>
```

En fin d'installation : `worker_id` + empreinte SHA-256 du jeton du worker (pas
un secret) à enregistrer dans `fbi_probe_tokens` — sans elle, le journal reste
local (`/var/lib/fbi-session-worker/events.jsonl`).

Puis **une** connexion :

```bash
sudo fbi-worker-ctl login     # identifiants saisis au clavier, mot de passe masqué
sudo fbi-worker-ctl status
journalctl -u fbi-session-worker -f
```

## Lecture des résultats

```sql
select at, kind, outcome, elapsed_ms, state, detail
from fbi_probe_events where worker_id = 'ovh-…' order by at;
```

Facteur à garder en tête : la production (Vercel) se connecte au **même
compte FBI** pendant le test. Une fin de session du worker est à comparer aux
connexions de production (`fbi_session_traces.started_at`,
`fbi_integration_status.last_credential_login_at`) avant toute conclusion.

## Auto-test (sans le vrai FBI)

```bash
node ops/fbi-session-worker/fake-fbi-server.mjs &   # faux FBI sur 127.0.0.1:18777
FBI_BASE_URL=http://127.0.0.1:18777/fbi FBI_WORKER_PROFILE_DIR=/tmp/w/profile \
FBI_WORKER_LOG=/tmp/w/events.jsonl FBI_WORKER_SOCKET=/tmp/w/ctl.sock FBI_WORKER_TICK_MINUTES=0.1 \
  npx tsx ops/fbi-session-worker/worker.ts
# identifiants du faux FBI : robot / bon ; curl 127.0.0.1:18777/__invalidate simule une expiration
```

Vérifié le 2026-10-07 : mauvais mot de passe → `refusee_par_fbi` ; connexion →
`ok` ; seconde connexion → `refusee_session_valide` ; passages → `authenticated`
+ `search ok` ; faux FBI arrêté → `tcp_refused` sans déclarer la session
expirée ; sessions vidées côté serveur → `redirected_to_login` puis
`session_expired / traitements_arretes`, aucune reconnexion.
