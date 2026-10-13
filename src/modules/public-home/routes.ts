import { Hono } from "hono";
import type { DbClient } from "../../db/client.js";

import type { PublicHomeDto } from "../../contracts/public-home.js";
import { formatTeamNameWithGender } from "../../util/team-name.js";
import { listMatchesForClub } from "../matches/shared.js";
import { resolvePublicClub, type PublicClub } from "../public/club-resolver.js";
import { licencieFromRequest } from "../public/credential.js";

/**
 * GET /v1/public/clubs/:clubSlug/home?token= — accueil PERSONNEL de l'espace
 * public (retour du club, 2026-10-01) : équipe où le licencié joue
 * (`team_id`), équipes qu'il coache (`coached_team_ids`, posées depuis
 * /joueurs), prochains matchs et derniers résultats de ces équipes, et ses
 * prochaines tables de marque. Lecture seule ; tout est filtré par club.
 */
interface PublicEnv {
  Variables: { supabase: DbClient; publicClub: PublicClub };
}

type Relation = "PLAYER" | "COACH";

export const publicHomeRouter = new Hono<PublicEnv>();
publicHomeRouter.use("*", resolvePublicClub<PublicEnv>());

publicHomeRouter.get("/", async (c) => {
  const db = c.get("supabase");
  const club = c.get("publicClub");
  const me = await licencieFromRequest(c.req, db, club.id);

  const { data: row } = await db.from("licencies").select("team_id, public_admin, public_coach, public_coordinator, coached_team_ids").eq("id", me.id).eq("club_id", club.id).maybeSingle();
  const relations = new Map<string, Set<Relation>>();
  const add = (teamId: string, relation: Relation) => relations.set(teamId, (relations.get(teamId) ?? new Set()).add(relation));
  if (row?.team_id) add(row.team_id, "PLAYER");
  for (const id of row?.coached_team_ids ?? []) add(id, "COACH");

  const teamIds = [...relations.keys()];
  const { data: teamRows } = teamIds.length ? await db.from("teams").select("id, name, sexe").eq("club_id", club.id).in("id", teamIds) : { data: [] };
  // Équipe supprimée / d'un autre club : ignorée (jamais affichée).
  const known = new Map((teamRows ?? []).map((t) => [t.id, formatTeamNameWithGender(t.name, t.sexe)]));
  const teams = teamIds.filter((id) => known.has(id)).flatMap((id) => [...relations.get(id)!].map((relation) => ({ id, name: known.get(id)!, relation })));

  const nowIso = new Date().toISOString();
  const perTeam = await Promise.all(
    [...known.keys()].map(async (teamId) => {
      const [next, past] = await Promise.all([
        listMatchesForClub(db, club, { teamId, from: nowIso, limit: "10" }),
        listMatchesForClub(db, club, { teamId, period: "past", limit: "5" }),
      ]);
      return { teamId, next: next.matches, past: past.matches };
    }),
  );

  // Dérogations jamais exposées ici (même règle que la liste publique des matchs).
  const merge = (pick: "next" | "past") => {
    const byId = new Map<string, { match: (typeof perTeam)[number]["next"][number]; relations: Set<Relation> }>();
    for (const t of perTeam) {
      for (const m of t[pick]) {
        const entry = byId.get(m.id) ?? { match: { ...m, derogationStatus: null }, relations: new Set<Relation>() };
        relations.get(t.teamId)?.forEach((r) => entry.relations.add(r));
        byId.set(m.id, entry);
      }
    }
    const dir = pick === "next" ? 1 : -1;
    return [...byId.values()]
      .filter((e) => pick === "past" || e.match.status !== "cancelled")
      .sort((a, b) => dir * ((a.match.matchDatetime ?? "").localeCompare(b.match.matchDatetime ?? "")))
      .map((e) => ({ match: e.match, relations: [...e.relations] }));
  };
  const upcoming = merge("next").slice(0, 12);
  const recentResults = merge("past")
    .filter((e) => e.match.scoreHome !== null && e.match.scoreAway !== null)
    .slice(0, 6);

  // Prochaines tables de marque du licencié.
  const { data: duties } = await db.from("table_assignments").select("match_id, role").eq("club_id", club.id).eq("licencie_id", me.id);
  const dutyMatchIds = [...new Set((duties ?? []).map((d) => d.match_id))];
  const { data: dutyMatches } = dutyMatchIds.length
    ? await db.from("matches").select("id, match_datetime, opponent_name, venue_raw_label, team_id").eq("club_id", club.id).in("id", dutyMatchIds).gte("match_datetime", nowIso)
    : { data: [] };
  const dutyTeamIds = [...new Set((dutyMatches ?? []).map((m) => m.team_id).filter((id): id is string => Boolean(id)))];
  const { data: dutyTeams } = dutyTeamIds.length ? await db.from("teams").select("id, name, sexe").in("id", dutyTeamIds) : { data: [] };
  const dutyTeamName = new Map((dutyTeams ?? []).map((t) => [t.id, formatTeamNameWithGender(t.name, t.sexe)]));
  const matchById = new Map((dutyMatches ?? []).map((m) => [m.id, m]));
  const tableDuties = (duties ?? [])
    .filter((d) => matchById.has(d.match_id))
    .map((d) => {
      const m = matchById.get(d.match_id)!;
      return { matchId: m.id, role: d.role, matchDatetime: m.match_datetime, teamName: m.team_id ? (dutyTeamName.get(m.team_id) ?? null) : null, opponentName: m.opponent_name, venueLabel: m.venue_raw_label };
    })
    .sort((a, b) => (a.matchDatetime ?? "").localeCompare(b.matchDatetime ?? ""));

  const body: PublicHomeDto = {
    licencie: { id: me.id, firstName: me.first_name, lastName: me.last_name },
    roles: { coach: row?.public_coach === true, coordinator: row?.public_coordinator === true, admin: row?.public_admin === true },
    teams,
    upcoming,
    recentResults,
    tableDuties,
  };
  return c.json(body);
});
