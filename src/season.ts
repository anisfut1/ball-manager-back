/**
 * 1er août de la saison de basket en cours (convention française : la
 * saison court d'août à juin) — même formule que ball-manager-web
 * (`src/lib/season.ts#currentSeasonStart`), dupliquée ici pour filtrer les
 * anomalies (`GET /v1/clubs/:clubId/issues`) à la saison en cours : un
 * import e-Marque en erreur pour un match de mai 2025 (saison déjà
 * terminée) n'est plus actionnable, il ne doit plus polluer la liste
 * (demande du club, 2026-09-25 — "on s'en fout de 2025, ça doit impacter
 * que les matchs à venir pour ensuite agir dessus"). `now` injectable pour
 * les tests, jamais `new Date()` codé en dur dans la logique elle-même.
 */
export function currentSeasonStart(now: Date = new Date()): Date {
  const seasonStartYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1; // getMonth() 7 = août
  return new Date(seasonStartYear, 7, 1);
}
