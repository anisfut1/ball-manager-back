/**
 * "je veux le faire via loutil... sur la derog si action besoin de ma part,
 * faut un badge action requise" (demande du club, 2026-09-27) — une
 * dérogation "En Cours" n'attend PAS toujours une décision du club : elle
 * peut être la sienne propre (il attend alors la réponse de l'ADVERSAIRE,
 * rien à faire ici) ou celle du club adverse (c'est alors à NOUS de
 * répondre). `demandeur` ("Domicile"/"Visiteur") est un jargon FBI relatif
 * à CETTE rencontre précise (voir DerogationsList.tsx côté ball-manager-web : "c ecrit
 * demandeur domicile mais je sais pas cest qui qui joue à domicile") —
 * jamais fiable en le comparant au NOM d'équipe FBI (chaîne brute, fuzzy),
 * toujours à `isHome` (fiable, déjà connu via `matches.is_home` côté FFBB).
 *
 * `isHome === null` (rencontre non synchronisée / côté indéterminé) :
 * toujours `false`, jamais deviné — une action réelle et irréversible vers
 * FBI ne doit JAMAIS être proposée sans certitude sur le côté du club.
 */
export function isDerogationActionRequired(params: { etat: string | null; demandeur: string | null; isHome: boolean | null }): boolean {
  if (params.etat !== "En Cours") return false;
  if (params.isHome === null || params.demandeur === null) return false;

  const ourSide = params.isHome ? "Domicile" : "Visiteur";
  return params.demandeur !== ourSide;
}
