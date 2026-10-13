import { Hono, type Context } from "hono";
import type { DbClient } from "../../db/client.js";
import { badRequest, forbidden } from "../../api-error.js";
import type { ActionCenterDto, PlanningEventDto, TrainingOccurrenceDto } from "../../contracts/trainings.js";
import {
  ActionCenterRequestDtoSchema,
  CancelTrainingOccurrenceDtoSchema,
  PutTrainingAttendanceDtoSchema,
  CreateTrainingSeriesDtoSchema,
  PutTrainingResponseDtoSchema,
  UpdateTrainingOccurrenceDtoSchema,
  UpdateTrainingSeriesDtoSchema,
} from "../../contracts/trainings.js";
import { formatTeamNameWithGender } from "../../util/team-name.js";
import { resolvePublicClub, type PublicClub } from "../public/club-resolver.js";
import { words } from "../public-tables/name-search.js";
import { licencieFromToken } from "../public-tables/routes.js";
import { deviceSessionFromRequest, licencieFromRequest } from "../public/credential.js";
import type { ResolvedDeviceSession } from "../device-auth/service.js";
import { actorFromLicencie } from "./actor.js";
import { teamOverview } from "./team-overview.js";
import { assignLaundry, laundrySuggestions, markLaundrySeen, removeLaundry } from "../convocations/laundry.js";
import { PutLaundryDtoSchema, PutAvailabilityResponseDtoSchema, PutConvocationDraftDtoSchema, PutConvocationResponseDtoSchema } from "../../contracts/convocations.js";
import { laundryHomeActions, matchHomeActions, matchTeamLife, openAvailability, remindNoResponse, previewConvocation, respondAvailability, respondConvocation, saveDraft, sendConvocation } from "../convocations/service.js";
import { parse, rangeOf } from "./routes.js";
import {
  canManageTeam,
  markAttendance,
  createSeries,
  listOccurrences,
  listSeries,
  occurrenceDetail,
  planning,
  respond,
  responsesOf,
  setOccurrenceStatus,
  stopSeries,
  updateOccurrence,
  updateSeries,
  type TrainingActor,
  type TrainingCtx,
} from "./service.js";

/**
 * Entraînements — espace public (lien personnel, retour du club 2026-10-09 :
 * on garde le lien personnel). Un parent peut avoir plusieurs liens sur son
 * téléphone (un par enfant) : la Home « À faire » les fusionne. Voir
 * docs/TEAM_LIFE.md.
 */
interface PublicEnv {
  Variables: { supabase: DbClient; publicClub: PublicClub };
}

export const publicTrainingsRouter = new Hono<PublicEnv>();
publicTrainingsRouter.use("*", resolvePublicClub<PublicEnv>());

/** Jours affichés sur la Home : réponses attendues et « À venir ». */
const HOME_DAYS = 14;
/** Entraînements à répondre par personne (les plus proches). */
const MAX_TRAININGS_PER_PERSON = 3;

async function tokenCtx(c: Context<PublicEnv>): Promise<TrainingCtx & { licencie: { id: string; first_name: string } }> {
  const db = c.get("supabase");
  const club = c.get("publicClub");
  const licencie = await licencieFromRequest(c.req, db, club.id);
  const actor = await actorFromLicencie(db, club.id, licencie.id);
  return { db, clubId: club.id, timezone: club.timezone, actor, licencie };
}

const param = (c: Context, name: string): string => {
  const value = c.req.param(name);
  if (!value) throw badRequest(`Paramètre :${name} manquant.`);
  return value;
};

// Gestion (coach de l'équipe / admin du club), mêmes règles que l'espace club.
publicTrainingsRouter.get("/teams/:teamId/training-series", async (c) => c.json({ series: await listSeries(await tokenCtx(c), param(c, "teamId")) }));
publicTrainingsRouter.post("/teams/:teamId/training-series", async (c) => c.json({ series: await createSeries(await tokenCtx(c), param(c, "teamId"), await parse(CreateTrainingSeriesDtoSchema, c)) }, 201));
publicTrainingsRouter.patch("/training-series/:seriesId", async (c) => c.json({ series: await updateSeries(await tokenCtx(c), param(c, "seriesId"), await parse(UpdateTrainingSeriesDtoSchema, c)) }));
publicTrainingsRouter.delete("/training-series/:seriesId", async (c) => c.json({ series: await stopSeries(await tokenCtx(c), param(c, "seriesId"), c.req.query("from")) }));
/** Séances d'une équipe gérée (page « Entraînements » du coach), avec les compteurs de réponses. */
publicTrainingsRouter.get("/teams/:teamId/trainings", async (c) => {
  const ctx = await tokenCtx(c);
  const teamId = param(c, "teamId");
  if (!canManageTeam(ctx.actor, teamId)) throw forbidden("Réservé aux coachs de cette équipe et aux administrateurs du club.", "TEAM_MANAGER_REQUIRED");
  return c.json({ trainings: await listOccurrences(ctx, { teamIds: [teamId], ...rangeOf(c.req.query()) }) });
});
publicTrainingsRouter.get("/trainings/:occurrenceId", async (c) => c.json(await occurrenceDetail(await tokenCtx(c), param(c, "occurrenceId"))));
publicTrainingsRouter.patch("/trainings/:occurrenceId", async (c) => c.json(await updateOccurrence(await tokenCtx(c), param(c, "occurrenceId"), await parse(UpdateTrainingOccurrenceDtoSchema, c))));
publicTrainingsRouter.post("/trainings/:occurrenceId/cancel", async (c) => {
  const body = await parse(CancelTrainingOccurrenceDtoSchema, c);
  return c.json(await setOccurrenceStatus(await tokenCtx(c), param(c, "occurrenceId"), "cancelled", body.reason ?? null));
});
publicTrainingsRouter.post("/trainings/:occurrenceId/restore", async (c) => c.json(await setOccurrenceStatus(await tokenCtx(c), param(c, "occurrenceId"), "scheduled", null)));

/** Réponse du licencié DU LIEN (jamais un autre, même UUID connu). */
publicTrainingsRouter.put("/trainings/:occurrenceId/response", async (c) => {
  const ctx = await tokenCtx(c);
  const body = await parse(PutTrainingResponseDtoSchema, c);
  return c.json(await respond(ctx, param(c, "occurrenceId"), ctx.licencie.id, body.response));
});

// ─── Lot 2 : matchs ──────────────────────────────────────────────────────────

// Coach / admin du club (mêmes règles que l'espace club).
publicTrainingsRouter.get("/matches/:matchId", async (c) => c.json(await matchTeamLife(await tokenCtx(c), param(c, "matchId"))));
publicTrainingsRouter.post("/matches/:matchId/availability/open", async (c) => c.json(await openAvailability(await tokenCtx(c), param(c, "matchId"))));
publicTrainingsRouter.post("/matches/:matchId/remind", async (c) => c.json(await remindNoResponse(await tokenCtx(c), param(c, "matchId"))));
publicTrainingsRouter.put("/matches/:matchId/convocation/draft", async (c) => {
  const ctx = await tokenCtx(c);
  return c.json(await saveDraft(ctx, param(c, "matchId"), await parse(PutConvocationDraftDtoSchema, c)));
});
publicTrainingsRouter.post("/matches/:matchId/convocation/preview", async (c) => c.json(await previewConvocation(await tokenCtx(c), param(c, "matchId"))));
publicTrainingsRouter.post("/matches/:matchId/convocation/send", async (c) => c.json(await sendConvocation(await tokenCtx(c), param(c, "matchId"))));

/** Disponibilité / confirmation du licencié DU LIEN (jamais un autre, même UUID connu). */
publicTrainingsRouter.put("/matches/:matchId/availability/response", async (c) => {
  const ctx = await tokenCtx(c);
  const body = await parse(PutAvailabilityResponseDtoSchema, c);
  return c.json(await respondAvailability(ctx, param(c, "matchId"), ctx.licencie.id, body.response));
});
publicTrainingsRouter.put("/matches/:matchId/convocation/response", async (c) => {
  const ctx = await tokenCtx(c);
  const body = await parse(PutConvocationResponseDtoSchema, c);
  return c.json(await respondConvocation(ctx, param(c, "matchId"), ctx.licencie.id, body.response));
});

// ─── Lot 3 : lavage des maillots ─────────────────────────────────────────────
publicTrainingsRouter.get("/matches/:matchId/laundry/suggestions", async (c) => c.json(await laundrySuggestions(await tokenCtx(c), param(c, "matchId"))));
publicTrainingsRouter.put("/matches/:matchId/laundry", async (c) => {
  const ctx = await tokenCtx(c);
  return c.json(await assignLaundry(ctx, param(c, "matchId"), (await parse(PutLaundryDtoSchema, c)).licencieId));
});
publicTrainingsRouter.delete("/matches/:matchId/laundry", async (c) => c.json(await removeLaundry(await tokenCtx(c), param(c, "matchId"))));
/** « J'ai vu » : seulement le licencié désigné (celui du lien). */
publicTrainingsRouter.post("/matches/:matchId/laundry/seen", async (c) => {
  const ctx = await tokenCtx(c);
  return c.json(await markLaundrySeen(ctx, param(c, "matchId"), ctx.licencie.id));
});

// ─── Lot 4 : page Équipe (joueurs de l'équipe et ceux qui la gèrent) ─────────
publicTrainingsRouter.get("/teams/:teamId/overview", async (c) => {
  const ctx = await tokenCtx(c);
  const actor = ctx.actor as typeof ctx.actor & { teamId?: string | null };
  return c.json(await teamOverview(ctx, param(c, "teamId"), { memberTeamIds: actor.teamId ? [actor.teamId] : [] }));
});

interface Person {
  index: number;
  licencieId: string;
  firstName: string;
  lastName: string;
  teamId: string | null;
  actor: TrainingActor & { coachTeamList: string[] };
}

/** Liens valides de l'appareil → personnes (un lien invalide est signalé, jamais bloquant). */
/** Entrée de `tokens` désignant une personne de la session d'appareil (app iOS) : `as:<licencieId>`. */
const ACT_AS_PREFIX = "as:";

/**
 * Personnes de l'appareil, dans l'ordre de `tokens` (le front répond avec
 * `tokens[tokenIndex]`). Web : liens personnels. App : session d'appareil
 * (`Authorization: Bearer bmd_…`) et entrées `as:<licencieId>`, chacune
 * vérifiée dans les droits de la session — jamais une personne hors session.
 */
async function peopleOf(db: DbClient, club: PublicClub, tokens: string[], session: ResolvedDeviceSession | null): Promise<{ people: Person[]; invalid: number[] }> {
  const people: Person[] = [];
  const invalid: number[] = [];
  const granted = new Set(session?.grants.map((g) => g.licencieId) ?? []);
  await Promise.all(
    tokens.map(async (token, index) => {
      try {
        let l: { id: string; first_name: string; last_name: string };
        if (session) {
          const id = token.startsWith(ACT_AS_PREFIX) ? token.slice(ACT_AS_PREFIX.length) : "";
          if (!granted.has(id)) throw new Error("hors session");
          const { data } = await db.from("licencies").select("id, first_name, last_name").eq("id", id).eq("club_id", club.id).maybeSingle();
          if (!data) throw new Error("introuvable");
          l = data;
        } else {
          l = await licencieFromToken(db, club.id, token);
        }
        const actor = await actorFromLicencie(db, club.id, l.id);
        people.push({ index, licencieId: l.id, firstName: l.first_name, lastName: l.last_name, teamId: actor.teamId, actor });
      } catch {
        invalid.push(index);
      }
    }),
  );
  const unique = new Map<string, Person>();
  for (const p of people.sort((a, b) => a.index - b.index)) if (!unique.has(p.licencieId)) unique.set(p.licencieId, p);
  return { people: [...unique.values()], invalid: invalid.sort((a, b) => a - b) };
}

/** Un autre licencié actif du club porte-t-il le même nom de famille (accents, casse et tirets ignorés) ? */
async function hasNamesake(db: DbClient, clubId: string, people: Person[]): Promise<boolean> {
  const keys = new Set(people.map((p) => words(p.lastName).join(" ")).filter(Boolean));
  if (keys.size === 0) return false;
  const ids = new Set(people.map((p) => p.licencieId));
  const { data } = await db.from("licencies").select("id, last_name").eq("club_id", clubId).eq("active", true);
  return (data ?? []).some((l) => !ids.has(l.id) && keys.has(words(l.last_name ?? "").join(" ")));
}

/** Droits fusionnés de l'appareil (une famille) : admin si l'un l'est, équipes coachées réunies. */
function mergedActor(people: Person[]): TrainingActor {
  return {
    isAdmin: people.some((p) => p.actor.isAdmin),
    coachTeamIds: new Set(people.flatMap((p) => p.actor.coachTeamList)),
    userId: null,
    licencieId: people[0]?.licencieId ?? null,
  };
}

/**
 * POST …/action-center — Home « À faire » : réponses attendues aux prochains
 * entraînements de chaque enfant / du joueur, résumé des réponses pour les
 * équipes coachées, puis « À venir » (matchs + entraînements). Les liens
 * sont dans le corps (plusieurs enfants), jamais dans l'URL.
 */
publicTrainingsRouter.post("/action-center", async (c) => {
  const body = await parse(ActionCenterRequestDtoSchema, c);
  const db = c.get("supabase");
  const club = c.get("publicClub");
  const { people, invalid } = await peopleOf(db, club, body.tokens, await deviceSessionFromRequest(c.req, db, club.id));
  const ctx: TrainingCtx = { db, clubId: club.id, timezone: club.timezone, actor: mergedActor(people) };

  const from = new Date().toISOString();
  const to = new Date(Date.now() + HOME_DAYS * 86_400_000).toISOString();
  const playerTeams = [...new Set(people.map((p) => p.teamId).filter((id): id is string => Boolean(id)))];
  const coachTeams = [...new Set(people.flatMap((p) => p.actor.coachTeamList))];
  const allTeams = [...new Set([...playerTeams, ...coachTeams])];

  const { data: teamRows } = allTeams.length ? await db.from("teams").select("id, name, sexe").eq("club_id", club.id).in("id", allTeams) : { data: [] };
  const teamName = new Map((teamRows ?? []).map((t) => [t.id, formatTeamNameWithGender(t.name, t.sexe)]));

  const trainings = (await listOccurrences(ctx, { teamIds: allTeams, from, to })).filter((t) => t.endsAt > from);
  const responses = await responsesOf(
    ctx,
    trainings.map((t) => t.id),
    people.map((p) => p.licencieId),
  );
  const responseOf = new Map(responses.map((r) => [`${r.occurrence_id}:${r.licencie_id}`, r.response]));

  const actions: ActionCenterDto["actions"] = [];
  for (const p of people) {
    if (!p.teamId) continue;
    // Coach de sa propre équipe (ex. seniors) : il anime l'entraînement, on ne lui demande pas s'il vient.
    if (p.actor.coachTeamList.includes(p.teamId)) continue;
    trainings
      .filter((t) => t.team.id === p.teamId && t.status === "scheduled")
      .slice(0, MAX_TRAININGS_PER_PERSON)
      .forEach((t) => actions.push({ type: "TRAINING_RESPONSE", licencieId: p.licencieId, firstName: p.firstName, training: t, currentResponse: responseOf.get(`${t.id}:${p.licencieId}`) ?? null }));
  }
  // Coach : la prochaine séance de chaque équipe coachée, avec les réponses reçues.
  for (const teamId of coachTeams) {
    const next = trainings.find((t) => t.team.id === teamId && t.status === "scheduled" && canManageTeam(ctx.actor, teamId));
    const coach = people.find((p) => p.actor.coachTeamList.includes(teamId));
    if (next && coach) actions.push({ type: "COACH_TRAINING_SUMMARY", coachLicencieId: coach.licencieId, training: next });
  }
  // Matchs (Lot 2) : disponibilité, convocation à confirmer, étape suivante du coach.
  const matchActions = (await matchHomeActions(
    ctx,
    people.map((p) => ({ licencieId: p.licencieId, firstName: p.firstName, teamId: p.teamId, coachTeams: p.actor.coachTeamList })),
  )) as ActionCenterDto["actions"];
  actions.push(...matchActions);
  // Maillots (Lot 3) : « Vous êtes en charge du lavage des maillots après le match ».
  actions.push(...((await laundryHomeActions(ctx, people.map((p) => ({ licencieId: p.licencieId, firstName: p.firstName, teamId: p.teamId, coachTeams: p.actor.coachTeamList })))) as ActionCenterDto["actions"]));

  // Priorité (retour du club) : réponses attendues, puis convocations à confirmer, puis le coach, puis le reste ; chronologique.
  const rank = (a: ActionCenterDto["actions"][number]): number => {
    if (a.type === "TRAINING_RESPONSE") return a.currentResponse ? 3 : 0;
    if (a.type === "MATCH_AVAILABILITY") return a.currentResponse ? 3 : 0;
    if (a.type === "CONVOCATION_RESPONSE") return a.currentResponse === "PENDING" && !a.matchClosed ? 1 : 3;
    if (a.type === "LAUNDRY_DUTY") return a.seenAt ? 3 : 1;
    return 2;
  };
  const when = (a: ActionCenterDto["actions"][number]): string => ("training" in a ? a.training.startsAt : (a.match.startsAt ?? ""));
  actions.sort((a, b) => rank(a) - rank(b) || when(a).localeCompare(when(b)));

  const events: PlanningEventDto[] = await planning(ctx, { teamIds: allTeams, from, to });
  const upcoming = events.map((e) => ({
    ...e,
    forFirstNames: people.filter((p) => e.team && (p.teamId === e.team.id || p.actor.coachTeamList.includes(e.team.id))).map((p) => p.firstName),
  }));

  const result: ActionCenterDto = {
    people: people.map((p) => ({
      tokenIndex: p.index,
      licencieId: p.licencieId,
      firstName: p.firstName,
      lastName: p.lastName,
      team: p.teamId ? { id: p.teamId, name: teamName.get(p.teamId) ?? "Équipe" } : null,
      coachTeams: p.actor.coachTeamList.filter((id) => teamName.has(id)).map((id) => ({ id, name: teamName.get(id)! })),
    })),
    canAddRelative: people.length > 1 || (await hasNamesake(db, club.id, people)),
    invalidTokenIndexes: invalid,
    actions,
    upcoming,
  };
  return c.json(result);
});

/** Planning public : équipes de l'appareil (joueurs + équipes coachées), période choisie. */
publicTrainingsRouter.post("/planning", async (c) => {
  const body = await parse(ActionCenterRequestDtoSchema, c);
  const db = c.get("supabase");
  const club = c.get("publicClub");
  const { people } = await peopleOf(db, club, body.tokens, await deviceSessionFromRequest(c.req, db, club.id));
  const ctx: TrainingCtx = { db, clubId: club.id, timezone: club.timezone, actor: mergedActor(people) };
  const deviceTeams = [...new Set(people.flatMap((p) => [p.teamId, ...p.actor.coachTeamList]).filter((id): id is string => Boolean(id)))];
  // `teamId` (page Équipe) : seulement une équipe de l'appareil, jamais une autre.
  const only = c.req.query("teamId");
  const teamIds = only ? deviceTeams.filter((id) => id === only) : deviceTeams;
  const range = rangeOf(c.req.query());
  return c.json({ ...range, events: await planning(ctx, { teamIds, ...range }) });
});

export type { TrainingOccurrenceDto };

/** Présence réelle (coach / admin, séance commencée) : PRESENT / LATE / ABSENT. */
publicTrainingsRouter.put("/trainings/:occurrenceId/attendance/:licencieId", async (c) => {
  const ctx = await tokenCtx(c);
  const body = await parse(PutTrainingAttendanceDtoSchema, c);
  return c.json(await markAttendance(ctx, param(c, "occurrenceId"), param(c, "licencieId"), body.status));
});
