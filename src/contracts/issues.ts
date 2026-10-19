import { z } from "./zod.js";
import { QualityWarningDtoSchema } from "./emarque.js";

/**
 * Une "issue" est dérivée soit de `matches.emarque_status`
 * (error/needs_review, voir docs/EMARQUE.md), soit d'une ligne ouverte de
 * `fbi_schedule_discrepancies` (rapprochement calendrier FFBB/FBI, voir
 * docs/FBI.md — uniquement pour les clubs ayant FBI configuré), soit d'un
 * conflit horaire/lieu détecté entre deux rencontres à DOMICILE du club
 * (`integration: "scheduling"`, voir venue-conflicts.ts — demande du club,
 * 2026-09-25 : "2 équipes qui jouent le dimanche à 11h à Clavel"). `message`
 * est TOUJOURS un texte prêt à afficher (jamais une erreur interne brute,
 * §9/§29 de la demande) ; `technicalCode` est l'identifiant machine stable
 * pour un traitement programmatique côté frontend (ex: styliser
 * différemment un `EMARQUE_IMPORT_ERROR` d'un `EMARQUE_NEEDS_REVIEW`).
 *
 * `matchId` est `null` pour un `fbi_schedule_missing_in_ffbb` (une
 * rencontre vue sur FBI mais SANS ligne `matches` correspondante — rien à
 * lier).
 */
export const IssueDtoSchema = z
  .object({
    /** Identifiant stable de l'anomalie ET de son état (sert au bouton « Retirer »). */
    key: z.string(),
    matchId: z.string().uuid().nullable(),
    numero: z.string().nullable(),
    opponentName: z.string().nullable(),
    matchDatetime: z.string().nullable(),
    integration: z.enum(["emarque", "fbi_schedule", "scheduling"]),
    type: z.enum([
      "emarque_import_error",
      "emarque_needs_review",
      "fbi_schedule_mismatch",
      "fbi_schedule_missing_in_ffbb",
      "fbi_schedule_missing_in_fbi",
      "venue_time_conflict",
      "team_double_booking",
    ]),
    severity: z.enum(["warning", "error"]),
    /**
     * "open" : anomalie non résolue. "auto_corrected" : UNIQUEMENT pour un
     * `fbi_schedule_mismatch` que `processReconcileScheduleJob` vient de
     * corriger automatiquement dans `matches` (FBI l'emporte sur FFBB,
     * demande du club, 2026-09-27) — affichée quelques jours pour la
     * transparence ("qu'est-ce qui a changé"), jamais indéfiniment.
     */
    status: z.enum(["open", "auto_corrected"]),
    message: z.string(),
    technicalCode: z.string(),
    qualityWarnings: z.array(QualityWarningDtoSchema),
    createdAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
  })
  .openapi("IssueDto");

export type IssueDto = z.infer<typeof IssueDtoSchema>;
