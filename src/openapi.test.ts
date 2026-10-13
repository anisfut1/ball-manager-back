import { describe, expect, it } from "vitest";
import { generateOpenApiDocument } from "./openapi.js";

/**
 * §26 de la demande : garantit que toute route/DTO nouvellement ajoutée
 * est RÉELLEMENT présente dans le document généré — jamais un endpoint qui
 * existe côté handler mais pas dans le contrat que ball-manager-web génère avec
 * `npm run api:generate`.
 */
describe("generateOpenApiDocument", () => {
  const doc = generateOpenApiDocument();

  it("expose les 8 routes/champs des gaps résolus dans cette phase", () => {
    expect(doc.paths).toHaveProperty("/v1/clubs/{clubId}");
    expect(doc.paths["/v1/clubs/{clubId}"]).toHaveProperty("patch"); // gap 1

    expect(doc.paths).toHaveProperty(["/v1/clubs/{clubId}/integrations/ffbb"]);
    expect(doc.paths["/v1/clubs/{clubId}/integrations/ffbb"]).toHaveProperty("patch"); // gap 2

    expect(doc.paths["/v1/me"]!.get!.responses["200"].content["application/json"].schema.$ref).toContain("MeDto"); // gap 3

    expect(doc.paths["/v1/clubs/{clubId}/integrations/fbi"]).toHaveProperty("patch"); // gap 4

    expect(doc.paths).toHaveProperty("/v1/clubs/{clubId}/emarque-imports"); // gap 5
    expect(doc.paths["/v1/clubs/{clubId}/emarque-tracking"]).toHaveProperty("get"); // suivi des stats, 2026-10-06
    expect(doc.paths["/v1/clubs/{clubId}/emarque-tracking/{matchId}/relaunch"]).toHaveProperty("post");

    expect(doc.components?.schemas).toHaveProperty("MatchDocumentDto"); // documents (mimeType/discoveredAt)

    expect(doc.components?.schemas).toHaveProperty("IssueDto"); // gap 6

    expect(doc.paths["/v1/clubs/{clubId}/matches"]!.get!.parameters?.length).toBeGreaterThan(0); // gap 7 (query params documentés)

    expect(doc.components?.schemas).toHaveProperty("FbiIntegrationStatusDto"); // gap 8 (username)
  });

  it("documente le username FBI dans le schéma, jamais password/ciphertext", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = (doc.components?.schemas as any).FbiIntegrationStatusDto;
    expect(schema.properties).toHaveProperty("username");
    expect(schema.properties).not.toHaveProperty("password");
    expect(JSON.stringify(schema)).not.toMatch(/ciphertext|password/i);
  });

  it("documente les query params de GET /v1/clubs/:clubId/matches (period/from/to/teamId/homeAway/status/limit/offset)", () => {
    const params = doc.paths["/v1/clubs/{clubId}/matches"]!.get!.parameters ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const names = params.filter((p: any) => p.in === "query").map((p: any) => p.name);
    expect(names).toEqual(expect.arrayContaining(["period", "from", "to", "teamId", "homeAway", "status", "limit", "offset"]));
  });

  it("expose les 4 routes du module Tables de marque (demande du club, 2026-09-28)", () => {
    expect(doc.paths["/v1/clubs/{clubId}/matches/{matchId}/table-suggestions"]).toHaveProperty("get");
    expect(doc.paths["/v1/clubs/{clubId}/matches/{matchId}/table-assignments/{role}"]).toHaveProperty("put");
    expect(doc.paths["/v1/clubs/{clubId}/matches/{matchId}/table-assignments/{role}"]).toHaveProperty("delete");
    expect(doc.paths["/v1/clubs/{clubId}/table-assignments"]).toHaveProperty("get");

    expect(doc.components?.schemas).toHaveProperty("TableSuggestionsDto");
    expect(doc.components?.schemas).toHaveProperty("TableAssignmentsListDto");

    // ?role= obligatoire (§37 : contrat le plus propre, une seule route couvre les rôles).
    const suggestionsParams = doc.paths["/v1/clubs/{clubId}/matches/{matchId}/table-suggestions"]!.get!.parameters ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roleParam = suggestionsParams.find((p: any) => p.in === "query" && p.name === "role") as any;
    expect(roleParam).toBeDefined();
    expect(roleParam.required).toBe(true);
  });

  it("expose REFEREE comme 4e rôle et la route de bascule 'pas besoin d'arbitre' (retour du club, 2026-09-28)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roleSchema = (doc.components?.schemas as any).TableAssignmentRole;
    expect(roleSchema.enum).toEqual(expect.arrayContaining(["SCORER", "TIMEKEEPER", "CLUB_DELEGATE", "REFEREE"]));

    expect(doc.paths["/v1/clubs/{clubId}/matches/{matchId}/referee-status"]).toHaveProperty("put");
    expect(doc.components?.schemas).toHaveProperty("PutRefereeStatusDto");
    expect(doc.components?.schemas).toHaveProperty("RefereeStatusResultDto");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const forMatchSchema = (doc.components?.schemas as any).TableAssignmentsForMatchDto;
    expect(forMatchSchema.properties).toHaveProperty("refereeNotNeeded");
  });

  it("expose le flux public sans compte (retour du club, 2026-09-29) — aucune route sous /v1/public ne porte bearerAuth", () => {
    const publicPaths = ["/v1/public/clubs/{clubSlug}", "/v1/public/clubs/{clubSlug}/licencies", "/v1/public/clubs/{clubSlug}/me", "/v1/public/clubs/{clubSlug}/table-assignments"];
    for (const path of publicPaths) expect(doc.paths).toHaveProperty(path);

    expect(doc.paths["/v1/public/clubs/{clubSlug}/licencies/{licencieId}/request-link"]).toHaveProperty("post");
    expect(doc.paths["/v1/public/clubs/{clubSlug}/licencies/{licencieId}/claim"]).toBeUndefined();
    expect(doc.paths["/v1/public/clubs/{clubSlug}/derogations"]).toHaveProperty("get");
    expect(doc.paths["/v1/public/clubs/{clubSlug}/standings"]).toHaveProperty("get");
    expect(doc.paths["/v1/clubs/{clubId}/standings"]!.get!.security).toEqual([{ BearerAuth: [] }]);
    expect(doc.paths["/v1/public/clubs/{clubSlug}/matches/{matchId}/table-assignments/{role}"]).toHaveProperty("put");
    expect(doc.paths["/v1/public/clubs/{clubSlug}/matches/{matchId}/table-assignments/{role}"]).toHaveProperty("delete");

    const publicOps = [
      doc.paths["/v1/public/clubs/{clubSlug}"]!.get!,
      doc.paths["/v1/public/clubs/{clubSlug}/licencies"]!.get!,
      doc.paths["/v1/public/clubs/{clubSlug}/licencies/{licencieId}/request-link"]!.post!,
      doc.paths["/v1/public/clubs/{clubSlug}/derogations"]!.get!,
      doc.paths["/v1/public/clubs/{clubSlug}/me"]!.get!,
      doc.paths["/v1/public/clubs/{clubSlug}/table-assignments"]!.get!,
      doc.paths["/v1/public/clubs/{clubSlug}/matches/{matchId}/table-assignments/{role}"]!.put!,
      doc.paths["/v1/public/clubs/{clubSlug}/matches/{matchId}/table-assignments/{role}"]!.delete!,
    ];
    for (const op of publicOps) expect(op.security ?? []).toEqual([]); // jamais de session Supabase sur ce flux

    expect(doc.components?.schemas).toHaveProperty("RequestPersonalLinkResultDto");
    expect(doc.components?.schemas).not.toHaveProperty("ClaimResultDto");
    expect(doc.components?.schemas).toHaveProperty("PublicTableAssignmentsListDto");
  });

  it("expose la gestion admin des accès publics (liste + réinitialisation)", () => {
    expect(doc.paths["/v1/clubs/{clubId}/table-assignments/public-access"]).toHaveProperty("get");
    expect(doc.paths["/v1/clubs/{clubId}/table-assignments/public-access/{licencieId}/reset"]).toHaveProperty("post");
    expect(doc.components?.schemas).toHaveProperty("PublicAccessListDto");
  });

  it("expose les routes de maintenance plateforme (purge e-Marque rétroactive, suppression des saisons précédentes, nouvelle tentative des imports en erreur) — platform_admin uniquement", () => {
    expect(doc.paths["/v1/platform/maintenance/purge-emarque-documents"]).toHaveProperty("post");
    expect(doc.paths["/v1/platform/maintenance/delete-old-seasons"]).toHaveProperty("post");
    expect(doc.paths["/v1/platform/maintenance/retry-failed-emarque-imports"]).toHaveProperty("post");
    expect(doc.paths["/v1/platform/maintenance/purge-emarque-documents"]!.post!.security).toEqual(expect.arrayContaining([expect.any(Object)]));
    expect(doc.paths["/v1/platform/maintenance/delete-old-seasons"]!.post!.security).toEqual(expect.arrayContaining([expect.any(Object)]));
    expect(doc.paths["/v1/platform/maintenance/retry-failed-emarque-imports"]!.post!.security).toEqual(expect.arrayContaining([expect.any(Object)]));
    expect(doc.components?.schemas).toHaveProperty("PurgeEmarqueDocumentsResultDto");
    expect(doc.components?.schemas).toHaveProperty("DeleteOldSeasonsResultDto");
    expect(doc.components?.schemas).toHaveProperty("RetryFailedEmarqueImportsResultDto");
  });

  it("expose la vue publique en lecture seule des matchs (retour du club, 2026-09-29) — aucune route sous /v1/public/clubs/{clubSlug}/matches|teams ne porte bearerAuth", () => {
    const publicMatchesPaths = [
      "/v1/public/clubs/{clubSlug}/teams",
      "/v1/public/clubs/{clubSlug}/matches",
      "/v1/public/clubs/{clubSlug}/matches/{matchId}",
      "/v1/public/clubs/{clubSlug}/matches/{matchId}/documents",
      "/v1/public/clubs/{clubSlug}/matches/{matchId}/derogation",
    ];
    for (const path of publicMatchesPaths) expect(doc.paths).toHaveProperty(path);

    const publicMatchesOps = publicMatchesPaths.map((path) => doc.paths[path]!.get!);
    for (const op of publicMatchesOps) expect(op.security ?? []).toEqual([]); // jamais de session Supabase sur ce flux

    // Jamais de route d'écriture exposée publiquement (dérogation créer/répondre, vérifier sur FBI) — lecture seule uniquement.
    expect(doc.paths["/v1/public/clubs/{clubSlug}/matches/{matchId}/derogation"]).not.toHaveProperty("post");
  });

  it("espace public : `token` (query) jamais obligatoire — session d'appareil ou en-tête X-Personal-Link-Token acceptés (apps mobiles)", () => {
    const required: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods as Record<string, { parameters?: { name: string; required?: boolean }[] }>)) {
        if ((op.parameters ?? []).some((p) => p.name === "token" && p.required)) required.push(`${method} ${path}`);
      }
    }
    expect(required).toEqual([]);
  });

  it("génère un document valide (openapi 3.0.0, titre, au moins 15 routes)", () => {
    expect(doc.openapi).toBe("3.0.0");
    expect(doc.info.title).toBe("ball-manager-back");
    expect(Object.keys(doc.paths).length).toBeGreaterThanOrEqual(15);
  });

  it("expose le workflow interne des demandes de dérogation (coach → coordinateur) et la gestion des membres, toutes protégées par bearerAuth", () => {
    const ops = [
      doc.paths["/v1/clubs/{clubId}/derogation-requests/context"]!.get!,
      doc.paths["/v1/clubs/{clubId}/derogation-requests"]!.get!,
      doc.paths["/v1/clubs/{clubId}/derogation-requests"]!.post!,
      doc.paths["/v1/clubs/{clubId}/derogation-requests/{requestId}"]!.get!,
      doc.paths["/v1/clubs/{clubId}/derogation-requests/{requestId}/messages"]!.post!,
      doc.paths["/v1/clubs/{clubId}/derogation-requests/{requestId}/actions"]!.post!,
      doc.paths["/v1/clubs/{clubId}/derogation-requests/{requestId}/proposals"]!.post!,
      doc.paths["/v1/clubs/{clubId}/matches/{matchId}/derogation-availability"]!.get!,
      doc.paths["/v1/clubs/{clubId}/matches/{matchId}/derogation-slot-check"]!.get!,
      doc.paths["/v1/clubs/{clubId}/members"]!.get!,
      doc.paths["/v1/clubs/{clubId}/members"]!.post!,
      doc.paths["/v1/clubs/{clubId}/members/{membershipId}/roles"]!.put!,
    ];
    for (const op of ops) expect(op.security).toEqual([{ BearerAuth: [] }]);
    for (const schema of ["DerogationRequestDetailDto", "DerogationAvailabilityDto", "DerogationContextDto", "DerogationRequestStatus", "ClubMemberDto"]) {
      expect(doc.components?.schemas).toHaveProperty(schema);
    }
  });
});
