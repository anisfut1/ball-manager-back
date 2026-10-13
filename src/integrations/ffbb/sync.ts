import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../db/types.js";
import type { FfbbPublicProvider } from "./public-provider.js";
import type { NormalizedCompetition, NormalizedPool, NormalizedTeamEngagement } from "./types.js";
import { diffTrackedFields, mapNormalizedMatchToRow, shouldRequestEmarque } from "./mapping.js";
import { logError, logInfo } from "../../logger.js";
import { notifyMatchChange } from "../../modules/push/hooks.js";

type Client = SupabaseClient<Database>;

export interface SyncFfbbResult {
  syncRunId: string;
  status: "success" | "partial" | "error";
  stats: {
    engagementsUpserted: number;
    competitionsUpserted: number;
    poolsUpserted: number;
    matchesCreated: number;
    matchesUpdated: number;
    matchesUnchanged: number;
    changesDetected: number;
    errors: number;
  };
}

/**
 * Clôture les `sync_runs` restés "running" indéfiniment — un processus tué
 * avant sa mise à jour finale (ex. timeout serveur) laisse une ligne
 * "running" pour toujours, jamais "error" (le `finally`/`catch` applicatif
 * ne s'exécute pas sur un kill dur), ce qui donne l'impression trompeuse
 * d'une synchronisation bloquée sur /admin/sync (constaté en production,
 * voir docs/FFBB.md). Appelée seulement APRÈS acquisition du verrou
 * `try_acquire_sync_lock` (routes.ts / scheduler.ts) : à ce stade aucune
 * autre synchronisation FFBB n'est en cours pour ce club, donc toute ligne
 * encore "running" est nécessairement orpheline — jamais un run concurrent
 * légitime.
 */
export async function reapOrphanedRunningSyncRuns(supabase: Client, clubId: string): Promise<void> {
  const { error } = await supabase
    .from("sync_runs")
    .update({
      status: "error",
      finished_at: new Date().toISOString(),
      error_log: "Exécution interrompue avant la fin (processus arrêté, ex. timeout serveur) — clôturée automatiquement au démarrage de la synchronisation suivante.",
    })
    .eq("club_id", clubId)
    .eq("provider", "ffbb")
    .eq("status", "running");

  if (error) {
    logError("Nettoyage des sync_runs orphelins échoué", error, { clubId });
  }
}

/**
 * Renseigne `clubs.logo_url` depuis FFBB UNIQUEMENT s'il est encore vide —
 * demande explicite du club ("Sète vs X" sur la page Matchs). `logo_url`
 * est un champ que le club peut aussi éditer manuellement
 * (`PATCH /v1/clubs/:clubId`, voir contracts/clubs.ts) : jamais écrasé une
 * fois personnalisé, sync ou pas.
 */
async function syncClubLogoIfMissing(supabase: Client, clubId: string, logoUrl: string | null): Promise<void> {
  if (!logoUrl) return;

  const { error } = await supabase.from("clubs").update({ logo_url: logoUrl }).eq("id", clubId).is("logo_url", null);

  if (error) {
    throw new Error(`Mise à jour du logo du club échouée : ${error.message}`);
  }
}

async function upsertCompetitions(supabase: Client, competitions: NormalizedCompetition[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  for (const competition of competitions) {
    const { data, error } = await supabase
      .from("competitions")
      .upsert(
        {
          ffbb_competition_id: competition.ffbbId,
          name: competition.name,
          code: competition.code,
          sexe: competition.sexe,
          type_competition: competition.typeCompetition,
          category_code: competition.categoryCode,
          category_label: competition.categoryLabel,
          phase_code: competition.phaseCode,
          live_stat: competition.liveStat,
          emarque_v2: competition.emarqueV2,
          publication_internet: competition.publicationInternet,
          season: competition.season,
          parent_ffbb_competition_id: competition.parentCompetitionFfbbId,
          raw_ffbb_payload: competition.raw,
          ffbb_last_seen_at: new Date().toISOString(),
        },
        { onConflict: "ffbb_competition_id" },
      )
      .select("id, ffbb_competition_id")
      .single();

    if (error || !data) {
      throw new Error(`Upsert compétition ${competition.ffbbId} échoué : ${error?.message}`);
    }

    map.set(competition.ffbbId, data.id);
  }

  return map;
}

async function upsertPools(supabase: Client, pools: NormalizedPool[], competitionIdByFfbbId: Map<string, string>): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  for (const pool of pools) {
    const competitionId = competitionIdByFfbbId.get(pool.competitionFfbbId);
    if (!competitionId) continue;

    const { data, error } = await supabase
      .from("pools")
      .upsert(
        {
          ffbb_pool_id: pool.ffbbId,
          competition_id: competitionId,
          name: pool.name,
          raw_ffbb_payload: pool.raw,
          ffbb_last_seen_at: new Date().toISOString(),
        },
        { onConflict: "ffbb_pool_id" },
      )
      .select("id, ffbb_pool_id")
      .single();

    if (error || !data) {
      throw new Error(`Upsert poule ${pool.ffbbId} échoué : ${error?.message}`);
    }

    map.set(pool.ffbbId, data.id);
  }

  return map;
}

/**
 * Résout l'équipe interne correspondant à un engagement FFBB, en créant
 * l'équipe si nécessaire.
 *
 * Recherche/crée par (club_id, category, sexe, numero_equipe) — JAMAIS par
 * le nom de l'équipe (`teams.name` reste un simple libellé affichable,
 * librement renommable par un·e club_admin sans jamais casser cette
 * résolution). Corrigé le 2026-09-25 (§ migration
 * `20260925100000_teams_gender_split_and_licencie_team.sql`) : la version
 * précédente résolvait/créait par NOM dérivé de la catégorie + numéro
 * SEUL, sans le sexe — deux engagements de sexes différents partageant le
 * même numéro (ex : Seniors 1 féminine ET masculine) généraient le MÊME
 * nom ("Seniors 1") et fusionnaient donc silencieusement dans LA MÊME
 * ligne `teams`, mélangeant les matchs des deux équipes sous un seul
 * `team_id`. Constaté en production sur 5 équipes du club pilote (57
 * matchs mal regroupés, jamais perdus — corrigés par cette même
 * migration, `matches.competition_id` ayant toujours porté le bon sexe
 * indépendamment de ce bug de regroupement).
 *
 * `numero_equipe` peut être `null` (FFBB ne fournit pas toujours ce champ,
 * ex. une catégorie sans équipe concurrente numérotée) : une équipe déjà
 * existante peut aussi avoir été créée manuellement sans numéro (voir
 * `modules/teams/routes.ts`) — `is("numero_equipe", null)` la retrouve
 * correctement dans ce cas plutôt que de la dupliquer.
 */
/** FFBB n'expose aucune garantie formelle sur le contenu de `sexe` (texte libre côté API publique) — jamais assumé "M"/"F" sans vérification, `null` sinon (ARCHITECTURE.md §22). */
function normalizeSexe(value: string | null): "M" | "F" | null {
  return value === "M" || value === "F" ? value : null;
}

/** Exporté uniquement pour son test dédié (régression du bug de fusion M/F, voir son commentaire) — jamais appelé hors de ce module en production. */
export async function resolveTeamForEngagement(
  supabase: Client,
  clubId: string,
  engagement: NormalizedTeamEngagement,
  competition: NormalizedCompetition | undefined,
): Promise<string> {
  const category = competition?.categoryCode ?? null;
  const sexe = normalizeSexe(competition?.sexe ?? null);
  const numeroEquipe = engagement.numeroEquipe;

  let query = supabase.from("teams").select("id").eq("club_id", clubId);
  query = category === null ? query.is("category", null) : query.eq("category", category);
  query = sexe === null ? query.is("sexe", null) : query.eq("sexe", sexe);
  query = numeroEquipe === null ? query.is("numero_equipe", null) : query.eq("numero_equipe", numeroEquipe);

  const { data: existing, error: selectError } = await query.maybeSingle();

  if (selectError) {
    throw new Error(`Recherche équipe (catégorie ${category ?? "?"}, sexe ${sexe ?? "?"}, n°${numeroEquipe ?? "?"}) échouée : ${selectError.message}`);
  }

  if (existing) return existing.id;

  const label = competition?.categoryLabel ?? competition?.name ?? "Équipe";
  const teamName = numeroEquipe ? `${label} ${numeroEquipe}`.trim() : (engagement.name ?? label);

  const { data: created, error: insertError } = await supabase
    .from("teams")
    .insert({ club_id: clubId, name: teamName, category, sexe, numero_equipe: numeroEquipe })
    .select("id")
    .single();

  if (insertError || !created) {
    throw new Error(`Création équipe "${teamName}" échouée : ${insertError?.message}`);
  }

  return created.id;
}

async function upsertEngagements(
  supabase: Client,
  clubId: string,
  engagements: NormalizedTeamEngagement[],
  competitionIdByFfbbId: Map<string, string>,
  poolIdByFfbbId: Map<string, string>,
  competitionsByFfbbId: Map<string, NormalizedCompetition>,
): Promise<Map<string, string>> {
  const teamIdByEngagementFfbbId = new Map<string, string>();

  for (const engagement of engagements) {
    const competitionId = competitionIdByFfbbId.get(engagement.competitionFfbbId) ?? null;
    const poolId = engagement.poolFfbbId ? (poolIdByFfbbId.get(engagement.poolFfbbId) ?? null) : null;
    const competition = competitionsByFfbbId.get(engagement.competitionFfbbId);

    const teamId = await resolveTeamForEngagement(supabase, clubId, engagement, competition);

    const { error } = await supabase.from("ffbb_team_engagements").upsert(
      {
        club_id: clubId,
        team_id: teamId,
        ffbb_engagement_id: engagement.ffbbId,
        competition_id: competitionId ?? "",
        pool_id: poolId,
        season: competition?.season ?? null,
        name: engagement.name,
        numero_equipe: engagement.numeroEquipe,
        raw_ffbb_payload: engagement.raw,
        ffbb_last_seen_at: new Date().toISOString(),
      },
      { onConflict: "club_id,ffbb_engagement_id" },
    );

    if (error) {
      throw new Error(`Upsert engagement ${engagement.ffbbId} échoué : ${error.message}`);
    }

    teamIdByEngagementFfbbId.set(engagement.ffbbId, teamId);
  }

  return teamIdByEngagementFfbbId;
}

async function upsertVenue(supabase: Client, ffbbVenueId: string | null, name: string | null, address: string | null): Promise<string | null> {
  if (!ffbbVenueId) return null;

  const { data, error } = await supabase
    .from("venues")
    .upsert(
      { ffbb_venue_id: ffbbVenueId, name, address, ffbb_last_seen_at: new Date().toISOString() },
      { onConflict: "ffbb_venue_id" },
    )
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Upsert salle ${ffbbVenueId} échoué : ${error?.message}`);
  }

  return data.id;
}

/**
 * Classements des poules du club (retour du club, 2026-10-01 : "et même le
 * classement... qui est dispo sur FFBB et important"). Étape best-effort :
 * un échec (champ refusé par l'API, réseau) est journalisé et n'interrompt
 * JAMAIS la synchronisation des matchs ; les classements déjà stockés
 * restent alors affichés avec leur date de mise à jour.
 */
export async function syncPoolStandings(supabase: Client, provider: FfbbPublicProvider, poolIdByFfbbId: Map<string, string>, clubId: string): Promise<void> {
  if (poolIdByFfbbId.size === 0) return;
  try {
    const standings = await provider.listPoolStandings([...poolIdByFfbbId.keys()]);
    const updatedAt = new Date().toISOString();
    for (const pool of standings) {
      const poolId = poolIdByFfbbId.get(pool.poolFfbbId);
      if (!poolId || pool.rows.length === 0) continue;
      const { error } = await supabase.from("pools").update({ standings: pool.rows, standings_updated_at: updatedAt }).eq("id", poolId);
      if (error) logError("Écriture du classement d'une poule échouée", error, { clubId, poolFfbbId: pool.poolFfbbId });
    }
  } catch (error) {
    logError("Récupération des classements FFBB échouée (matchs synchronisés quand même)", error, { clubId });
  }
}

/**
 * Gymnases du club (`club_venues`, demandes de dérogation) : toute salle FFBB
 * utilisée pour un match À DOMICILE devient un gymnase du club s'il n'existe
 * pas déjà — jamais un nom deviné, jamais l'écrasement d'un gymnase existant
 * (nom/ordre/actif restent éditables). Best-effort : n'interrompt jamais la
 * synchronisation des matchs.
 */
export async function ensureClubVenues(supabase: Client, clubId: string, homeVenues: ReadonlyMap<string, { name: string | null; address: string | null }>): Promise<void> {
  const rows = [...homeVenues.entries()].filter(([, v]) => v.name).map(([venueId, v]) => ({ club_id: clubId, venue_id: venueId, name: v.name as string, address: v.address }));
  if (rows.length === 0) return;
  const { error } = await supabase.from("club_venues").upsert(rows, { onConflict: "club_id,venue_id", ignoreDuplicates: true });
  if (error) logError("Mise à jour des gymnases du club échouée (matchs synchronisés quand même)", error, { clubId });
}

export interface SyncFfbbClub {
  id: string;
  ffbbClubId: string;
}

/**
 * syncFfbb — service de synchronisation FFBB, désormais explicitement
 * paramétré par club (§18/§37 du brief SaaS) : plus aucun singleton "le
 * club". Idempotent (clé d'upsert = identifiants FFBB, scopée au club pour
 * `matches`/`ffbb_team_engagements`), ne supprime jamais un match, historise
 * chaque changement de champ suivi.
 *
 * Statut : PREPARED — la logique de mapping/diff est testée unitairement
 * (voir mapping.test.ts), mais cette orchestration n'a jamais été exécutée
 * contre un vrai projet Supabase ni la vraie API FFBB depuis cet
 * environnement (voir docs/FFBB_ECOSYSTEM_RESEARCH.md).
 */
export async function syncFfbb(supabase: Client, provider: FfbbPublicProvider, club: SyncFfbbClub): Promise<SyncFfbbResult> {
  await reapOrphanedRunningSyncRuns(supabase, club.id);

  const { data: syncRun, error: syncRunError } = await supabase
    .from("sync_runs")
    .insert({ club_id: club.id, provider: "ffbb", status: "running" })
    .select("id")
    .single();

  if (syncRunError || !syncRun) {
    throw new Error(`Impossible de créer le sync_run : ${syncRunError?.message}`);
  }

  const stats: SyncFfbbResult["stats"] = {
    engagementsUpserted: 0,
    competitionsUpserted: 0,
    poolsUpserted: 0,
    matchesCreated: 0,
    matchesUpdated: 0,
    matchesUnchanged: 0,
    changesDetected: 0,
    errors: 0,
  };

  try {
    const snapshot = await provider.fetchClubSnapshot(club.ffbbClubId);

    await syncClubLogoIfMissing(supabase, club.id, snapshot.organisme.logoUrl);

    const competitionIdByFfbbId = await upsertCompetitions(supabase, snapshot.competitions);
    stats.competitionsUpserted = competitionIdByFfbbId.size;

    const poolIdByFfbbId = await upsertPools(supabase, snapshot.pools, competitionIdByFfbbId);
    stats.poolsUpserted = poolIdByFfbbId.size;

    await syncPoolStandings(supabase, provider, poolIdByFfbbId, club.id);

    const competitionsByFfbbId = new Map(snapshot.competitions.map((c) => [c.ffbbId, c]));
    const teamIdByEngagementFfbbId = await upsertEngagements(
      supabase,
      club.id,
      snapshot.engagements,
      competitionIdByFfbbId,
      poolIdByFfbbId,
      competitionsByFfbbId,
    );
    stats.engagementsUpserted = teamIdByEngagementFfbbId.size;

    const homeVenues = new Map<string, { name: string | null; address: string | null }>();
    for (const match of snapshot.matches) {
      try {
        const venueId = await upsertVenue(supabase, match.venue?.ffbbId ?? null, match.venue?.name ?? null, match.venue?.address ?? null);
        if (match.isHome && venueId) homeVenues.set(venueId, { name: match.venue?.name ?? null, address: match.venue?.address ?? null });

        const row = mapNormalizedMatchToRow(match, {
          clubId: club.id,
          teamId: teamIdByEngagementFfbbId.get(match.ourEngagementFfbbId) ?? null,
          competitionId: match.competitionFfbbId ? (competitionIdByFfbbId.get(match.competitionFfbbId) ?? null) : null,
          poolId: match.poolFfbbId ? (poolIdByFfbbId.get(match.poolFfbbId) ?? null) : null,
          venueId,
        });

        const { data: existing } = await supabase
          .from("matches")
          .select("*")
          .eq("club_id", club.id)
          .eq("ffbb_match_id", match.ffbbId)
          .maybeSingle();

        const diffs = diffTrackedFields(existing, row);
        const emarqueTransition = shouldRequestEmarque(existing?.status, row.status);

        const { data: upserted, error: upsertError } = await supabase
          .from("matches")
          .upsert(
            { ...row, emarque_status: emarqueTransition ? "pending" : (existing?.emarque_status ?? "not_applicable") },
            { onConflict: "club_id,ffbb_match_id" },
          )
          .select("id")
          .single();

        if (upsertError || !upserted) {
          throw new Error(upsertError?.message ?? "upsert sans erreur mais sans résultat");
        }

        if (!existing) {
          stats.matchesCreated += 1;
        } else if (diffs.length > 0) {
          stats.matchesUpdated += 1;
          stats.changesDetected += diffs.length;

          const { error: historyError } = await supabase.from("match_change_history").insert(
            diffs.map((diff) => ({
              club_id: club.id,
              match_id: upserted.id,
              sync_run_id: syncRun.id,
              field_name: diff.field,
              old_value: diff.oldValue,
              new_value: diff.newValue,
            })),
          );

          if (historyError) {
            logError("Écriture de l'historique de changement échouée", historyError, { clubId: club.id, matchId: upserted.id });
          }

          await notifyMatchChange(supabase, {
            clubId: club.id,
            matchId: upserted.id,
            teamId: row.team_id ?? null,
            matchDatetime: row.match_datetime ?? null,
            status: row.status ?? "scheduled",
            diffs,
            syncRunId: syncRun.id,
          });
        } else {
          stats.matchesUnchanged += 1;
        }
      } catch (error) {
        stats.errors += 1;
        logError("Synchronisation d'un match échouée", error, { clubId: club.id, ffbbMatchId: match.ffbbId });
      }
    }

    await ensureClubVenues(supabase, club.id, homeVenues);

    const finalStatus = stats.errors === 0 ? "success" : "partial";

    await supabase
      .from("sync_runs")
      .update({ status: finalStatus, finished_at: new Date().toISOString(), stats })
      .eq("id", syncRun.id);

    logInfo("Synchronisation FFBB terminée", { clubId: club.id, syncRunId: syncRun.id, status: finalStatus, stats });

    return { syncRunId: syncRun.id, status: finalStatus, stats };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await supabase
      .from("sync_runs")
      .update({ status: "error", finished_at: new Date().toISOString(), stats, error_log: message })
      .eq("id", syncRun.id);

    logError("Synchronisation FFBB en erreur", error, { clubId: club.id });

    return { syncRunId: syncRun.id, status: "error", stats };
  }
}
