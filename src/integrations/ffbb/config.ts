/**
 * Configuration de l'API publique FFBB (Directus), telle que documentée
 * dans docs/FFBB_ECOSYSTEM_RESEARCH.md §3 — confirmée par recoupement du
 * code source de 3 bibliothèques clientes open source indépendantes,
 * jamais testée en direct depuis cet environnement (réseau bloqué, voir
 * le même document, section méthodologie).
 */

export const FFBB_API_BASE_URL = "https://api.ffbb.app/";

export const FFBB_ENDPOINTS = {
  configuration: "items/configuration",
  organismes: "items/ffbbserver_organismes",
  engagements: "items/ffbbserver_engagements",
  competitions: "items/ffbbserver_competitions",
  poules: "items/ffbbserver_poules",
  rencontres: "items/ffbbserver_rencontres",
  /**
   * Endpoint standard Directus de service de fichiers. Un organisme a un
   * champ `logo.id` (voir public-provider.ts, `logoAssetUrl`) qui référence
   * un fichier ici : `{FFBB_API_BASE_URL}assets/{id}`. Non vérifié en
   * direct si cet endpoint accepte les requêtes anonymes (probable, sert
   * des images publiques dans l'appli mobile) ou exige le même jeton que
   * le reste de l'API (auquel cas une simple balise <img> ne suffirait pas
   * côté frontend — voir docs/FFBB.md).
   */
  assets: "assets",
} as const;

/**
 * Le backend est protégé par un WAF/CDN qui bloque les clients qui ne
 * ressemblent pas à l'application mobile officielle (voir docs/
 * FFBB_ECOSYSTEM_RESEARCH.md §3.2). Reproduit ce qu'utilisent les
 * bibliothèques open source étudiées.
 */
export const FFBB_USER_AGENT = "okhttp/4.12.0";

/**
 * Fréquence de synchronisation FFBB par club (§25 du brief SaaS). Pilote
 * `clubs.ffbb_next_sync_at` : chaque club est resynchronisé à son propre
 * rythme plutôt que tous en même temps à chaque tick de cron, ce qui reste
 * simple à 2 clubs et permet de monter en charge sans changer le mécanisme
 * (voir docs/MULTI_TENANCY.md).
 */
export const FFBB_SYNC_INTERVAL_MINUTES = 15;

/**
 * Pause après un refus de l'API FFBB (HTTP 403, page « Forbidden » d'un
 * pare-feu devant api.ffbb.app, constaté à partir du 2026-10-17) : réessayer
 * toutes les 15 min compte comme un comportement abusif et prolonge le
 * blocage. On attend donc plusieurs heures avant la tentative suivante.
 */
export const FFBB_BLOCKED_RETRY_MINUTES = 360;

/**
 * Nombre maximal de clubs traités par exécution du cron (§25/§49 du brief
 * SaaS) : évite qu'un tick de cron devienne interminable à grande échelle.
 * Les clubs non traités restent dus et seront pris au tick suivant.
 */
export const FFBB_SYNC_BATCH_SIZE = 20;

/**
 * Profondeur d'historique synchronisée pour `items/ffbbserver_rencontres`
 * (mois avant aujourd'hui). Constaté en production le 2026-09-22 : sans
 * filtre de date, `listAllItems` doit paginer sur l'historique COMPLET
 * d'un club (des milliers de rencontres remontant à plusieurs années),
 * chacune traitée séquentiellement (upsert compétition/poule/venue/match +
 * détection de changement) — dépasse le budget de 300s d'une invocation
 * Vercel (`FUNCTION_INVOCATION_TIMEOUT` constaté). Or seule la saison en
 * cours compte réellement pour l'usage du club (confirmé explicitement :
 * les saisons passées peuvent être ignorées). 6 mois de marge avant
 * aujourd'hui pour ne jamais manquer une rencontre reportée/rattrapée de
 * fin de saison précédente ; aucune borne supérieure (les rencontres
 * futures, calendrier de la saison en cours, doivent toutes remonter).
 */
export const FFBB_MATCH_HISTORY_MONTHS = 6;
