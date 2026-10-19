import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership, requireClubRole } from "../../auth/middleware.js";
import { badRequest, notFound } from "../../api-error.js";
import { z } from "../../contracts/zod.js";
import type { IssueDto } from "../../contracts/issues.js";
import type { QualityWarningDto } from "../../contracts/emarque.js";
import { currentSeasonStart } from "../../season.js";
import { detectTeamConflicts, detectVenueConflicts, MATCH_SLOT_MINUTES } from "./venue-conflicts.js";

export const issuesRouter = new Hono<AppEnv>();

issuesRouter.use("*", requireAuth);
issuesRouter.use("*", requireClubMembership);

const MESSAGE_BY_STATUS: Record<"error" | "needs_review", { message: string; technicalCode: string; severity: "warning" | "error" }> = {
  error: {
    message: "Une erreur est survenue lors du traitement du document e-Marque de ce match.",
    technicalCode: "EMARQUE_IMPORT_ERROR",
    severity: "error",
  },
  needs_review: {
    message: "Le document e-Marque de ce match nécessite une vérification manuelle.",
    technicalCode: "EMARQUE_NEEDS_REVIEW",
    severity: "warning",
  },
};

/**
 * Construit le message/technicalCode/severity d'une anomalie de
 * rapprochement calendrier FFBB/FBI (voir docs/FBI.md) — `missing_in_ffbb`
 * est classée `error` (une rencontre entièrement invisible du calendrier du
 * club est plus grave qu'un simple écart de date/heure déjà connu et
 * planifié des deux côtés).
 */
function describeFbiScheduleDiscrepancy(row: {
  kind: "mismatch" | "missing_in_ffbb" | "missing_in_fbi";
  division_code: string | null;
  numero: string | null;
  ffbb_value: string | null;
  fbi_value: string | null;
  fbi_opponent_name: string | null;
  auto_corrected_at: string | null;
}): { type: IssueDto["type"]; message: string; technicalCode: string; severity: "warning" | "error" } {
  const label = `${row.division_code ?? "?"} n°${row.numero ?? "?"}`;

  switch (row.kind) {
    case "mismatch":
      // FBI l'emporte désormais sur FFBB pour un mismatch (demande du club,
      // 2026-09-27) : `auto_corrected_at` renseigné = déjà corrigé dans
      // matches, message au passé pour ne pas laisser croire qu'une action
      // reste à faire.
      return row.auto_corrected_at
        ? {
            type: "fbi_schedule_mismatch",
            technicalCode: "FBI_SCHEDULE_MISMATCH",
            severity: "warning",
            message: `Écart corrigé automatiquement pour la rencontre ${label} : FFBB indiquait "${row.ffbb_value ?? "?"}", remplacé par la valeur FBI "${row.fbi_value ?? "?"}".`,
          }
        : {
            type: "fbi_schedule_mismatch",
            technicalCode: "FBI_SCHEDULE_MISMATCH",
            severity: "warning",
            message: `Écart détecté entre FFBB et FBI pour la rencontre ${label} : FFBB indique "${row.ffbb_value ?? "?"}", FBI indique "${row.fbi_value ?? "?"}".`,
          };
    case "missing_in_ffbb":
      return {
        type: "fbi_schedule_missing_in_ffbb",
        technicalCode: "FBI_SCHEDULE_MISSING_IN_FFBB",
        severity: "error",
        message: `Rencontre visible sur FBI mais absente du calendrier synchronisé FFBB : ${label}${row.fbi_opponent_name ? ` — ${row.fbi_opponent_name}` : ""}.`,
      };
    case "missing_in_fbi":
      return {
        type: "fbi_schedule_missing_in_fbi",
        technicalCode: "FBI_SCHEDULE_MISSING_IN_FBI",
        severity: "warning",
        message: `Rencontre de notre calendrier FFBB introuvable dans le listing FBI du club : ${label}.`,
      };
  }
}

/**
 * GET /v1/clubs/:clubId/issues — dérivé de `matches.emarque_status`
 * (error/needs_review), enrichi (gap 6 de la demande) avec les
 * avertissements qualité de l'import e-Marque le plus récent de chaque
 * match. `message`/`technicalCode` sont TOUJOURS des textes prêts à
 * afficher (jamais `emarque_imports.last_error` brut, §9 de la demande).
 */
issuesRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");

  /**
   * Filtre saison en cours (demande du club, 2026-09-25 : "on s'en fout de
   * 2025, ça doit impacter que les matchs à venir pour ensuite agir
   * dessus") — un import e-Marque en erreur pour un match d'une saison déjà
   * terminée n'est plus actionnable, il ne doit plus polluer cette liste.
   * Même formule que ball-manager-web (`src/lib/season.ts#currentSeasonStart`, 1er août).
   */
  const seasonStartIso = currentSeasonStart().toISOString();

  const { data: matches, error } = await supabase
    .from("matches")
    .select("id, numero, opponent_name, match_datetime, emarque_status")
    .eq("club_id", club.id)
    .in("emarque_status", ["error", "needs_review"])
    .gte("match_datetime", seasonStartIso)
    .order("match_datetime", { ascending: false });

  if (error) throw new Error(`Lecture des anomalies échouée : ${error.message}`);

  const matchIds = (matches ?? []).map((m) => m.id);

  const { data: imports } = matchIds.length
    ? await supabase
        .from("emarque_imports")
        .select("match_id, quality_warnings, created_at")
        .eq("club_id", club.id)
        .in("match_id", matchIds)
        .order("created_at", { ascending: false })
    : { data: [] };

  const latestImportByMatchId = new Map<string, { quality_warnings: unknown; created_at: string }>();
  for (const imp of imports ?? []) {
    if (!latestImportByMatchId.has(imp.match_id)) latestImportByMatchId.set(imp.match_id, imp);
  }

  const emarqueIssues: IssueDto[] = (matches ?? []).map((m) => {
    const emarqueStatus = m.emarque_status as "error" | "needs_review";
    const meta = MESSAGE_BY_STATUS[emarqueStatus];
    const latestImport = latestImportByMatchId.get(m.id);
    const qualityWarnings = Array.isArray(latestImport?.quality_warnings) ? (latestImport.quality_warnings as QualityWarningDto[]) : [];

    return {
      key: `emarque:${m.id}:${emarqueStatus}`,
      matchId: m.id,
      numero: m.numero,
      opponentName: m.opponent_name,
      matchDatetime: m.match_datetime,
      integration: "emarque",
      type: emarqueStatus === "error" ? "emarque_import_error" : "emarque_needs_review",
      severity: meta.severity,
      status: "open",
      message: meta.message,
      technicalCode: meta.technicalCode,
      qualityWarnings,
      createdAt: latestImport?.created_at ?? null,
      resolvedAt: null,
    };
  });

  /**
   * Anomalies de rapprochement calendrier FFBB/FBI (voir docs/FBI.md) — les
   * lignes OUVERTES (`resolved_at is null`, résolues automatiquement par le
   * job `reconcile_schedule` dès qu'un rapprochement ultérieur ne les revoit
   * plus), PLUS celles corrigées automatiquement récemment (`auto_corrected_at`,
   * demande du club, 2026-09-27 : "FBI doit emporter sur FFBB" — encore
   * affichées quelques jours pour la transparence, "qu'est-ce qui a changé",
   * jamais indéfiniment). Filtré en mémoire (jamais un `.or()` Supabase ici)
   * pour rester exploitable par le même fake de test que le reste de cette
   * route. Silencieusement vide pour un club sans FBI configuré (aucune
   * ligne n'a jamais été écrite) — jamais une erreur.
   */
  const AUTO_CORRECTED_VISIBILITY_DAYS = 7;
  const autoCorrectedCutoffIso = new Date(Date.now() - AUTO_CORRECTED_VISIBILITY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: allScheduleDiscrepancies, error: scheduleError } = await supabase
    .from("fbi_schedule_discrepancies")
    .select("id, match_id, division_code, numero, kind, ffbb_value, fbi_value, fbi_opponent_name, detected_at, resolved_at, auto_corrected_at")
    .eq("club_id", club.id)
    .order("detected_at", { ascending: false });

  if (scheduleError) throw new Error(`Lecture des anomalies de calendrier FBI échouée : ${scheduleError.message}`);

  // Seuls les écarts d'horaire/salle entre FFBB et FBI sont montrés : une
  // rencontre vue d'un seul côté (missing_in_fbi / missing_in_ffbb) vient
  // surtout d'une lecture FBI incomplète, rien d'actionnable pour le club
  // (retour du club, 2026-10-19 : « elles servent à rien »). Conservées en
  // base pour le diagnostic.
  const scheduleDiscrepancies = (allScheduleDiscrepancies ?? []).filter(
    (d) => d.kind === "mismatch" && (d.resolved_at === null || (d.auto_corrected_at !== null && d.auto_corrected_at >= autoCorrectedCutoffIso)),
  );

  const scheduleMatchIds = scheduleDiscrepancies.map((d) => d.match_id).filter((id): id is string => Boolean(id));
  const { data: scheduleMatches } = scheduleMatchIds.length
    ? await supabase.from("matches").select("id, opponent_name, match_datetime").in("id", scheduleMatchIds)
    : { data: [] };
  const matchInfoById = new Map((scheduleMatches ?? []).map((m) => [m.id, m]));

  const fbiScheduleIssues: IssueDto[] = scheduleDiscrepancies
    // Filtre saison en cours (même raison que ci-dessus) : `missing_in_ffbb`
    // n'a pas de date connue côté FFBB (matchId null) — toujours conservée,
    // elle reflète l'état ACTUEL du scrape FBI, jamais une donnée historique.
    .filter((d) => {
      if (!d.match_id) return true;
      const matchDatetime = matchInfoById.get(d.match_id)?.match_datetime;
      return !matchDatetime || matchDatetime >= seasonStartIso;
    })
    .map((d) => {
      const meta = describeFbiScheduleDiscrepancy(d);
      const matchInfo = d.match_id ? matchInfoById.get(d.match_id) : undefined;

      return {
        key: `fbi:${d.id}`,
        matchId: d.match_id,
        numero: d.numero,
        opponentName: matchInfo?.opponent_name ?? d.fbi_opponent_name,
        matchDatetime: matchInfo?.match_datetime ?? null,
        integration: "fbi_schedule",
        type: meta.type,
        severity: meta.severity,
        status: d.auto_corrected_at ? "auto_corrected" : "open",
        message: meta.message,
        technicalCode: meta.technicalCode,
        qualityWarnings: [],
        createdAt: d.detected_at,
        resolvedAt: d.auto_corrected_at,
      };
    });

  /**
   * Conflits de planning (voir venue-conflicts.ts) — rencontres À VENIR
   * uniquement : un conflit passé n'est plus actionnable. Salle : à
   * domicile seulement. Équipe : domicile ou extérieur.
   */
  const { data: upcomingMatches, error: upcomingError } = await supabase
    .from("matches")
    .select("id, numero, opponent_name, match_datetime, venue_id, venue_raw_label, is_home, status, team_id")
    .eq("club_id", club.id)
    .gte("match_datetime", new Date().toISOString());

  if (upcomingError) throw new Error(`Lecture des rencontres à venir échouée : ${upcomingError.message}`);

  const datedMatches = (upcomingMatches ?? []).filter(
    (m): m is typeof m & { match_datetime: string } => Boolean(m.match_datetime) && m.status !== "cancelled" && m.status !== "postponed",
  );
  const matchById = new Map(datedMatches.map((m) => [m.id, m]));

  const toConflictIssue = (
    conflict: { matchId: string; conflictingMatchIds: string[]; conflictingLabel: string },
    kind: "venue" | "team",
  ): IssueDto => {
    const match = matchById.get(conflict.matchId);
    return {
      key: `${kind}:${conflict.matchId}:${match?.match_datetime ?? ""}:${[...conflict.conflictingMatchIds].sort().join(",")}`,
      matchId: conflict.matchId,
      numero: match?.numero ?? null,
      opponentName: match?.opponent_name ?? null,
      matchDatetime: match?.match_datetime ?? null,
      integration: "scheduling",
      type: kind === "venue" ? "venue_time_conflict" : "team_double_booking",
      severity: "error",
      status: "open",
      message:
        kind === "venue"
          ? `Même salle, créneaux qui se chevauchent (moins de ${MATCH_SLOT_MINUTES} min d'écart) avec : ${conflict.conflictingLabel}.`
          : `Cette équipe a un autre match le même jour : ${conflict.conflictingLabel}.`,
      technicalCode: kind === "venue" ? "VENUE_TIME_CONFLICT" : "TEAM_DOUBLE_BOOKING",
      qualityWarnings: [],
      createdAt: null,
      resolvedAt: null,
    };
  };

  const venueConflictIssues = detectVenueConflicts(
    datedMatches
      .filter((m) => m.is_home)
      .map((m) => ({ id: m.id, numero: m.numero, opponentName: m.opponent_name, matchDatetime: m.match_datetime, venueId: m.venue_id, venueRawLabel: m.venue_raw_label })),
  ).map((c) => toConflictIssue(c, "venue"));

  const teamConflictIssues = detectTeamConflicts(
    datedMatches.map((m) => ({ id: m.id, numero: m.numero, opponentName: m.opponent_name, matchDatetime: m.match_datetime, teamId: m.team_id })),
  ).map((c) => toConflictIssue(c, "team"));

  const { data: dismissals, error: dismissalsError } = await supabase.from("issue_dismissals").select("issue_key").eq("club_id", club.id);
  if (dismissalsError) throw new Error(`Lecture des anomalies retirées échouée : ${dismissalsError.message}`);
  const dismissed = new Set((dismissals ?? []).map((d) => d.issue_key));

  // Conflits de planning en tête : ce sont eux que le club veut voir d'abord.
  const issues = [...venueConflictIssues, ...teamConflictIssues, ...emarqueIssues, ...fbiScheduleIssues].filter((issue) => !dismissed.has(issue.key));
  return c.json({ issues });
});

const DismissIssueBodySchema = z.object({ key: z.string().min(1).max(500) });

/**
 * POST /v1/clubs/:clubId/issues/dismiss — un club_admin retire une anomalie
 * de la liste. La clé porte l'état de l'anomalie : si la situation change
 * (match déplacé, autre conflit), une nouvelle clé la fait réapparaître.
 */
issuesRouter.post("/dismiss", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const parsed = DismissIssueBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest("Clé d'anomalie manquante.");
  const user = c.get("user") as { id: string };

  const { error } = await c
    .get("supabase")
    .from("issue_dismissals")
    .upsert({ club_id: club.id, issue_key: parsed.data.key, dismissed_by: user.id }, { onConflict: "club_id,issue_key" });
  if (error) throw new Error(`Retrait de l'anomalie échoué : ${error.message}`);

  return c.json({ dismissed: true });
});

/**
 * POST /v1/clubs/:clubId/issues/:matchId/resolve — un club_admin confirme
 * avoir vérifié manuellement les données malgré l'avertissement qualité.
 * Ne modifie AUCUNE donnée extraite, uniquement le statut de revue.
 */
issuesRouter.post("/:matchId/resolve", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const { data, error } = await c
    .get("supabase")
    .from("matches")
    .update({ emarque_status: "imported" })
    .eq("id", matchId)
    .eq("club_id", club.id)
    .select("id");

  if (error) throw new Error(`Résolution de l'anomalie échouée : ${error.message}`);
  if (!data || data.length === 0) throw notFound("Match introuvable.");

  return c.json({ resolved: true });
});
