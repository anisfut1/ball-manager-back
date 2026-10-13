import { getEnv } from "../config/env.js";

/**
 * BallManagerLinkService — SEULE source des URL métier (emails, push, app).
 * Voir docs/MOBILE_AUTH.md § Liens.
 *
 * Une ressource logique = un chemin `/public/{slug}/…` unique, partagé par :
 *   - le web (www.ball-manager.fr) ;
 *   - l'app iOS (Universal Links : même chemin, même routeur) ;
 *   - les notifications push (champ `path`, relatif).
 * Aucun gabarit d'email ne reconstruit une URL à la main.
 *
 * `links(base)` produit des URL HTTPS absolues ; `links("")` des chemins
 * relatifs (destination d'une notification push).
 */

const enc = encodeURIComponent;

export type PersonalLinkTarget = "accueil" | "tables" | "derogations" | "matchs";

export function links(base: string) {
  const root = base.replace(/\/+$/, "");
  const club = (slug: string) => `${root}/public/${enc(slug)}`;
  return {
    clubHome: (slug: string) => `${club(slug)}/accueil`,
    /** Page d'onglet de l'espace public (`accueil`, `tables`, `derogations`, `matchs`…). */
    clubPage: (slug: string, target: PersonalLinkTarget | string) => `${club(slug)}/${target}`,
    planning: (slug: string) => `${club(slug)}/planning`,
    team: (slug: string, teamId: string) => `${club(slug)}/equipes/${enc(teamId)}`,
    match: (slug: string, matchId: string) => `${club(slug)}/matchs/${enc(matchId)}`,
    /** Convocation d'un match : la page du match affiche la convocation de la famille (« Je confirme »). */
    convocation: (slug: string, matchId: string) => `${club(slug)}/matchs/${enc(matchId)}#convocation`,
    /** Coach : bloc « Disponibilités, convocation et maillots » du match. */
    matchManage: (slug: string, matchId: string) => `${club(slug)}/matchs/${enc(matchId)}#vie-equipe`,
    /** Séance : coach → gestion de la séance ; famille → accueil (réponse Présent / Absent / Incertain). */
    training: (slug: string, occurrence: { id: string; teamId: string }, audience: "coach" | "family") =>
      audience === "coach" ? `${club(slug)}/entrainements?equipe=${enc(occurrence.teamId)}&seance=${enc(occurrence.id)}` : `${club(slug)}/accueil#seance-${enc(occurrence.id)}`,
    derogations: (slug: string) => `${club(slug)}/derogations`,
    derogation: (slug: string, requestId: string) => `${club(slug)}/derogations/${enc(requestId)}`,
    tables: (slug: string) => `${club(slug)}/tables`,
    /** Lien de connexion à usage unique (AUTH_LINK_CODES=1) : la page GET n'utilise jamais le code. */
    loginCode: (slug: string, code: string) => `${club(slug)}/connexion/code/${enc(code)}`,
    /** Lien personnel historique (`?token=`), conservé pour la compatibilité des liens déjà envoyés. */
    personalLink: (slug: string, target: PersonalLinkTarget | string, token: string) => `${club(slug)}/${target}?token=${enc(token)}`,
    /** Espace club (compte) : reste sur le web, jamais capturé par l'app. */
    clubAdminPlayers: (slug: string) => `${root}/c/${enc(slug)}/joueurs`,
    accountWelcome: (params: URLSearchParams) => `${root}/bienvenue?${params.toString()}`,
    absolute: (path: string) => `${root}${path.startsWith("/") ? path : `/${path}`}`,
  };
}

export type BallManagerLinks = ReturnType<typeof links>;

/**
 * Base publique des liens : `PUBLIC_APP_URL` (domaine officiel, celui des
 * Universal Links), sinon l'origine de la requête si elle est autorisée,
 * sinon la première origine https de FRONTEND_ORIGINS. Jamais une origine
 * arbitraire fournie par un tiers.
 */
export function linkBaseUrl(requestOrigin?: string): string {
  const env = getEnv();
  if (env.PUBLIC_APP_URL) return env.PUBLIC_APP_URL.replace(/\/+$/, "");
  const allowed = env.FRONTEND_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return allowed.find((o) => o.startsWith("https://")) ?? allowed[0] ?? "";
}

/** URL absolues sur le domaine officiel. */
export function appLinks(requestOrigin?: string): BallManagerLinks {
  return links(linkBaseUrl(requestOrigin));
}

/** Chemins relatifs (destination des notifications push, routés par l'app comme un Universal Link). */
export const paths: BallManagerLinks = links("");
