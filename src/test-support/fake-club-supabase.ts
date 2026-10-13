import { randomUUID } from "node:crypto";
/**
 * Fake Supabase réutilisable pour les tests de routes Hono (§17/§19/§25 de
 * la demande : "tester les permissions" pour chaque nouvelle route) — même
 * esprit que le fake déjà utilisé par `tenancy/club-context.test.ts`, mais
 * partagé pour éviter de le dupliquer dans chaque fichier de test de route.
 *
 * Couvre uniquement ce dont les middlewares/routes ont besoin — PAS un mock
 * générique de tout Supabase, et n'applique AUCUNE RLS réelle : l'isolation
 * cross-tenant réelle reste garantie par `supabase/tests/isolation_test.sql`
 * contre un vrai PostgreSQL ; ce fake ne vérifie que la logique applicative
 * (permissions, validation, branchement) au-dessus.
 */

export interface FakeClubRow {
  id: string;
  slug: string;
  name: string;
  short_name: string | null;
  logo_url: string | null;
  accent_color: string | null;
  timezone: string;
  status: "active" | "suspended";
  ffbb_club_id: string;
  ffbb_enabled: boolean;
  ffbb_next_sync_at: string | null;
}

export interface FakeMembershipRow {
  id: string;
  club_id: string;
  user_id: string;
  status: "active" | "suspended";
  /** Rattachement à un licencié (§ fiche joueur) — voir club_memberships.licencie_id. */
  licencie_id?: string | null;
}

export interface FakeLicencieRow {
  id: string;
  club_id: string;
  first_name: string;
  last_name: string;
  license_number: string | null;
  birth_date: string | null;
  email: string | null;
  phone: string | null;
  photo_url: string | null;
  team_id?: string | null;
  active: boolean;
  ffbb_licence_id?: string | null;
  category_label?: string | null;
  sexe?: "M" | "F" | null;
  public_admin?: boolean;
  public_coach?: boolean;
  public_coordinator?: boolean;
  coached_team_ids?: string[];
}

export interface FakeRoleRow {
  membership_id: string;
  role: string;
  scope_team_id?: string | null;
}

/** Lignes génériques des tables "demandes de dérogation" (forme libre, voir migrations). */
export type FakeRow = Record<string, unknown>;

export interface FakeFbiCredentialsRow {
  club_id: string;
  username: string;
  password_ciphertext: string;
  password_iv: string;
  password_auth_tag: string;
}

export interface FakeFbiIntegrationStatusRow {
  club_id: string;
  configured: boolean;
  last_login_success: boolean | null;
  last_login_at: string | null;
  auto_import_emarque: boolean;
  last_error: string | null;
}

export interface FakeSyncRunRow {
  id: string;
  club_id: string;
  provider: "ffbb" | "fbi";
  status: string;
  started_at: string;
  finished_at: string | null;
  error_log: string | null;
}

export interface FakeMatchRow {
  id: string;
  club_id: string;
  numero: string | null;
  journee: string | null;
  match_datetime: string | null;
  is_home: boolean | null;
  opponent_name: string | null;
  venue_raw_label: string | null;
  score_home: number | null;
  score_away: number | null;
  status: string;
  emarque_status: string;
  team_id: string | null;
  competition_id?: string | null;
  venue_id?: string | null;
}

export interface FakeCompetitionRow {
  id: string;
  category_label: string | null;
  name?: string;
}

export interface FakeEngagementRow {
  club_id: string;
  team_id: string;
  ffbb_engagement_id: string;
  pool_id: string | null;
}

export interface FakePoolRow {
  id: string;
  name: string;
  competition_id: string;
  standings: unknown;
  standings_updated_at: string | null;
}

export interface FakeTeamRow {
  id: string;
  club_id: string;
  name: string;
  category?: string | null;
  sexe?: "M" | "F" | null;
  numero_equipe?: string | null;
  active?: boolean;
}

export interface FakeEmarqueImportRow {
  id: string;
  club_id: string;
  match_id: string;
  status: string;
  source: "fbi";
  parser_version: string | null;
  quality_warnings: unknown;
  discovered_at: string;
  downloaded_at: string | null;
  imported_at: string | null;
  last_error: string | null;
  attempt_count: number;
  next_attempt_at: string | null;
  created_at: string;
}

export interface FakeProfileRow {
  user_id: string;
  display_name: string | null;
}

export interface FakeMatchDocumentRow {
  id: string;
  club_id: string;
  match_id: string;
  type: "emarque_zip" | "match_sheet" | "summary" | "shot_chart" | "other";
  filename: string | null;
  mime_type: string | null;
  status: "downloaded" | "parsing" | "imported" | "error";
  discovered_at: string;
  downloaded_at: string | null;
  storage_path: string;
  source: "fbi";
  purged_at?: string | null;
}

export interface FakeFbiScheduleDiscrepancyRow {
  id: string;
  club_id: string;
  match_id: string | null;
  division_code: string | null;
  numero: string | null;
  kind: "mismatch" | "missing_in_ffbb" | "missing_in_fbi";
  field_name: string | null;
  ffbb_value: string | null;
  fbi_value: string | null;
  fbi_opponent_name: string | null;
  detected_at: string;
  resolved_at: string | null;
  auto_corrected_at?: string | null;
}

export interface FakeFbiDerogationCheckRow {
  id: string;
  club_id: string;
  match_id: string;
  numero: string | null;
  etat: string | null;
  date_depot: string | null;
  date_derogation: string | null;
  date_rencontre: string | null;
  heure: string | null;
  domicile: string | null;
  visiteur: string | null;
  demandeur?: string | null;
  motif?: string | null;
  date_rencontre_demandee?: string | null;
  heure_demandee?: string | null;
  adversaire?: string | null;
  date_reponse?: string | null;
  acceptation?: string | null;
  motif_refus?: string | null;
  checked_at: string;
}

export interface FakeTableAssignmentRow {
  id: string;
  club_id: string;
  match_id: string;
  licencie_id: string;
  role: string;
  created_by: string | null;
  updated_at?: string;
}

export interface FakeRefereeOverrideRow {
  id: string;
  club_id: string;
  match_id: string;
  no_referee_needed: boolean;
  created_by: string | null;
  updated_at?: string;
}

export interface FakePublicTokenRow {
  id: string;
  club_id: string;
  licencie_id: string;
  token_hash: string;
  token_ciphertext?: { ciphertext: string; iv: string; authTag: string } | null;
  email: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface FakeFbiJobRow {
  id: string;
  club_id: string;
  match_id: string | null;
  type: string;
  status: string;
  scheduled_at?: string;
  claimed_at?: string | null;
  finished_at?: string | null;
  last_error?: string | null;
  window_start?: string | null;
  created_at?: string;
}

export interface FakeClubSupabaseState {
  clubs: FakeClubRow[];
  memberships: FakeMembershipRow[];
  roles: FakeRoleRow[];
  fbiCredentials: FakeFbiCredentialsRow[];
  fbiIntegrationStatus: FakeFbiIntegrationStatusRow[];
  syncRuns: FakeSyncRunRow[];
  matches: FakeMatchRow[];
  competitions: FakeCompetitionRow[];
  teams: FakeTeamRow[];
  emarqueImports: FakeEmarqueImportRow[];
  profiles: FakeProfileRow[];
  licencies: FakeLicencieRow[];
  fbiScheduleDiscrepancies: FakeFbiScheduleDiscrepancyRow[];
  fbiDerogationChecks: FakeFbiDerogationCheckRow[];
  fbiJobs: FakeFbiJobRow[];
  tableAssignments: FakeTableAssignmentRow[];
  refereeOverrides: FakeRefereeOverrideRow[];
  publicTokens: FakePublicTokenRow[];
  engagements: FakeEngagementRow[];
  pools: FakePoolRow[];
  clubVenues: FakeRow[];
  schedulingRules: FakeRow[];
  derogationRequests: FakeRow[];
  derogationProposals: FakeRow[];
  derogationMessages: FakeRow[];
  matchDocuments: FakeMatchDocumentRow[];
  claimRequests: FakeRow[];
  licenceImportRuns: FakeRow[];
  derogationNotifications: FakeRow[];
  trainingSeries: FakeRow[];
  trainingOccurrences: FakeRow[];
  trainingResponses: FakeRow[];
  availabilityRequests: FakeRow[];
  trainingAttendance: FakeRow[];
  laundry: FakeRow[];
  availabilityResponses: FakeRow[];
  convocations: FakeRow[];
  convocationRecipients: FakeRow[];
  convocationDispatches: FakeRow[];
  venues: FakeRow[];
  /** App iOS : sessions d'appareil, droits et codes d'autorisation (docs/MOBILE_AUTH.md). */
  deviceSessions: FakeRow[];
  deviceSessionGrants: FakeRow[];
  authCodes: FakeRow[];
  devicePushTokens: FakeRow[];
  notificationOutbox: FakeRow[];
  isPlatformAdmin: boolean;
  /** Clés `${clubId}:${integration}` actuellement verrouillées (voir try_acquire_sync_lock/release_sync_lock). */
  syncLocks: Set<string>;
}

export function makeFakeClubSupabaseState(overrides: Partial<FakeClubSupabaseState> = {}): FakeClubSupabaseState {
  return {
    clubs: [],
    memberships: [],
    roles: [],
    fbiCredentials: [],
    fbiIntegrationStatus: [],
    syncRuns: [],
    licencies: [],
    matches: [],
    competitions: [],
    teams: [],
    emarqueImports: [],
    profiles: [],
    fbiScheduleDiscrepancies: [],
    fbiDerogationChecks: [],
    fbiJobs: [],
    tableAssignments: [],
    refereeOverrides: [],
    publicTokens: [],
    engagements: [],
    pools: [],
    clubVenues: [],
    schedulingRules: [],
    derogationRequests: [],
    derogationProposals: [],
    derogationMessages: [],
    matchDocuments: [],
    claimRequests: [],
    licenceImportRuns: [],
    derogationNotifications: [],
    trainingSeries: [],
    trainingOccurrences: [],
    trainingResponses: [],
    availabilityRequests: [],
    trainingAttendance: [],
    laundry: [],
    availabilityResponses: [],
    convocations: [],
    convocationRecipients: [],
    convocationDispatches: [],
    venues: [],
    deviceSessions: [],
    deviceSessionGrants: [],
    authCodes: [],
    devicePushTokens: [],
    notificationOutbox: [],
    isPlatformAdmin: false,
    syncLocks: new Set(),
    ...overrides,
  };
}

let fakeClock = Date.parse("2026-10-01T08:00:00.000Z");
/** Horodatage strictement croissant (ordre chronologique stable des messages en test). */
function fakeNow(): string {
  fakeClock += 1000;
  return new Date(fakeClock).toISOString();
}

/**
 * Table générique mutable (insert / update / delete / upsert) pour les
 * nouvelles tables — `unique` simule un index unique (ex. index PARTIEL
 * "une demande active par match") en renvoyant l'erreur Postgres 23505.
 */
function mutableTable(getRows: () => FakeRow[], setRows: (rows: FakeRow[]) => void, options: { defaults?: (row: FakeRow) => FakeRow; unique?: (row: FakeRow, rows: FakeRow[]) => boolean } = {}) {
  const withDefaults = (row: FakeRow): FakeRow => ({ id: randomUUID(), created_at: fakeNow(), ...(options.defaults ? options.defaults(row) : {}), ...row });
  const match = (row: FakeRow, filters: { col: string; value: unknown; op: "eq" | "in" | "lt" }[]) =>
    filters.every((f) => (f.op === "in" ? (f.value as unknown[]).includes(row[f.col]) : f.op === "lt" ? (row[f.col] as string) < (f.value as string) : row[f.col] === f.value));

  return {
    select: (_cols?: string) => queryable(getRows()),
    insert(payload: FakeRow | FakeRow[]) {
      const rows = (Array.isArray(payload) ? payload : [payload]).map(withDefaults);
      let error: { code: string; message: string } | null = null;
      for (const row of rows) {
        if (options.unique?.(row, getRows())) {
          error = { code: "23505", message: "duplicate key value violates unique constraint" };
          break;
        }
        getRows().push(row);
      }
      const result = { data: error ? null : rows, error };
      return {
        select: () => ({
          single: () => Promise.resolve({ data: error ? null : rows[0], error }),
          maybeSingle: () => Promise.resolve({ data: error ? null : (rows[0] ?? null), error }),
        }),
        then: (onFulfilled: (value: typeof result) => unknown) => Promise.resolve(result).then(onFulfilled),
      };
    },
    update(patch: FakeRow) {
      const filters: { col: string; value: unknown; op: "eq" | "in" | "lt" }[] = [];
      const apply = () => {
        const rows = getRows().filter((row) => match(row, filters));
        rows.forEach((row) => Object.assign(row, patch));
        return rows;
      };
      const api = {
        eq(col: string, value: unknown) {
          filters.push({ col, value, op: "eq" });
          return api;
        },
        // `.is(col, null)` : mise à jour conditionnelle (ex. code d'autorisation à usage unique).
        is(col: string, value: null) {
          filters.push({ col, value, op: "eq" });
          return api;
        },
        in(col: string, values: unknown[]) {
          filters.push({ col, value: values, op: "in" });
          return api;
        },
        lt(col: string, value: string) {
          filters.push({ col, value, op: "lt" });
          return api;
        },
        select: () => ({
          maybeSingle: () => Promise.resolve({ data: apply()[0] ?? null, error: null }),
          single: () => {
            const rows = apply();
            return Promise.resolve(rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "not found" } });
          },
        }),
        then: (onFulfilled: (value: { data: FakeRow[]; error: null }) => unknown) => Promise.resolve({ data: apply(), error: null }).then(onFulfilled),
      };
      return api;
    },
    delete() {
      const filters: { col: string; value: unknown; op: "eq" | "in" }[] = [];
      const api = {
        eq(col: string, value: unknown) {
          filters.push({ col, value, op: "eq" });
          return api;
        },
        // `.select()` après delete : renvoie les lignes supprimées (comme PostgREST).
        select: () => {
          const removed = getRows().filter((row) => match(row, filters));
          setRows(getRows().filter((row) => !match(row, filters)));
          return Promise.resolve({ data: removed, error: null });
        },
        then: (onFulfilled: (value: { error: null }) => unknown) => {
          setRows(getRows().filter((row) => !match(row, filters)));
          return Promise.resolve({ error: null }).then(onFulfilled);
        },
      };
      return api;
    },
    upsert(payload: FakeRow | FakeRow[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
      const keys = (opts?.onConflict ?? "id").split(",").map((k) => k.trim());
      const out: FakeRow[] = [];
      for (const row of Array.isArray(payload) ? payload : [payload]) {
        const existing = getRows().find((r) => keys.every((k) => r[k] === row[k]));
        if (existing) {
          if (!opts?.ignoreDuplicates) Object.assign(existing, row);
          out.push(existing);
        } else {
          const created = withDefaults(row);
          getRows().push(created);
          out.push(created);
        }
      }
      const result = { data: out, error: null };
      return {
        select: () => ({
          single: () => Promise.resolve({ data: out[0], error: null }),
          then: (onFulfilled: (value: typeof result) => unknown) => Promise.resolve(result).then(onFulfilled),
        }),
        then: (onFulfilled: (value: typeof result) => unknown) => Promise.resolve(result).then(onFulfilled),
      };
    },
  };
}

function matchClub(row: FakeClubRow, col: string, value: string): boolean {
  if (col === "id") return row.id === value;
  if (col === "slug") return row.slug === value;
  return (row as unknown as Record<string, unknown>)[col] === value;
}

/** Petit constructeur de requête chaînable `.eq()/.gte()/.lte()/.in()` générique sur un tableau en mémoire — suffisant pour les filtres réellement utilisés par les routes testées, pas un moteur de requête complet. */
function queryable<T extends object>(rows: T[]) {
  let filtered = rows;
  const orderKeys: { col: string; ascending: boolean }[] = [];
  const field = (r: T, col: string): unknown => (r as Record<string, unknown>)[col];
  const api = {
    eq(col: string, value: unknown) {
      filtered = filtered.filter((r) => field(r, col) === value);
      return api;
    },
    neq(col: string, value: unknown) {
      filtered = filtered.filter((r) => field(r, col) !== value);
      return api;
    },
    in(col: string, values: unknown[]) {
      filtered = filtered.filter((r) => values.includes(field(r, col)));
      return api;
    },
    is(col: string, value: null) {
      filtered = filtered.filter((r) => field(r, col) === value);
      return api;
    },
    gte(col: string, value: string) {
      filtered = filtered.filter((r) => (field(r, col) as string) >= value);
      return api;
    },
    lte(col: string, value: string) {
      filtered = filtered.filter((r) => (field(r, col) as string) <= value);
      return api;
    },
    lt(col: string, value: string) {
      filtered = filtered.filter((r) => (field(r, col) as string) < value);
      return api;
    },
    gt(col: string, value: string) {
      filtered = filtered.filter((r) => (field(r, col) as string) > value);
      return api;
    },
    // Appels multiples de `.order()` cumulent les clés de tri (comme le vrai
    // client Supabase — `ORDER BY col1, col2`, jamais un simple écrasement
    // du tri précédent par le dernier appel).
    order(col: string, opts?: { ascending?: boolean }) {
      orderKeys.push({ col, ascending: opts?.ascending ?? true });
      filtered = [...filtered].sort((a, b) => {
        for (const key of orderKeys) {
          const av = field(a, key.col) as string | number | null;
          const bv = field(b, key.col) as string | number | null;
          if (av === bv) continue;
          if (av === null) return 1;
          if (bv === null) return -1;
          return (av < bv ? -1 : 1) * (key.ascending ? 1 : -1);
        }
        return 0;
      });
      return api;
    },
    limit(n: number) {
      filtered = filtered.slice(0, n);
      return api;
    },
    range(from: number, to: number) {
      const total = filtered.length;
      filtered = filtered.slice(from, to + 1);
      return Promise.resolve({ data: filtered, error: null, count: total });
    },
    maybeSingle() {
      return Promise.resolve({ data: filtered[0] ?? null, error: null });
    },
    single() {
      return filtered[0] ? Promise.resolve({ data: filtered[0], error: null }) : Promise.resolve({ data: null, error: { message: "not found" } });
    },
    then(onFulfilled: (value: { data: T[]; error: null; count: number }) => unknown) {
      return Promise.resolve({ data: filtered, error: null, count: filtered.length }).then(onFulfilled);
    },
  };
  return api;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildFakeClubSupabase(state: FakeClubSupabaseState): any {
  const clubsTable = {
    select: (_cols?: string) => {
      const filters: { col: string; value: string }[] = [];
      const api = {
        eq(col: string, value: string) {
          filters.push({ col, value });
          return api;
        },
        maybeSingle() {
          const row = state.clubs.find((c) => filters.every((f) => matchClub(c, f.col, f.value)));
          return Promise.resolve({ data: row ?? null, error: null });
        },
        single() {
          const row = state.clubs.find((c) => filters.every((f) => matchClub(c, f.col, f.value)));
          return row ? Promise.resolve({ data: row, error: null }) : Promise.resolve({ data: null, error: { message: "not found" } });
        },
        // Liste (ex. GET /v1/public/clubs) : toutes les lignes qui passent les filtres.
        then(onFulfilled: (value: { data: FakeClubRow[]; error: null }) => unknown) {
          return Promise.resolve({ data: state.clubs.filter((c) => filters.every((f) => matchClub(c, f.col, f.value))), error: null }).then(onFulfilled);
        },
      };
      return api;
    },
    update: (patch: Partial<FakeClubRow>) => ({
      eq(_col: string, id: string) {
        const row = state.clubs.find((c) => c.id === id);
        const api = {
          select: () => api,
          single: () => {
            if (!row) return Promise.resolve({ data: null, error: { message: "not found" } });
            Object.assign(row, patch);
            return Promise.resolve({ data: row, error: null });
          },
        };
        return api;
      },
    }),
  };

  const membershipsTable = mutableTable(
    () => state.memberships as unknown as FakeRow[],
    (rows) => (state.memberships = rows as unknown as FakeMembershipRow[]),
    { defaults: () => ({ status: "active", licencie_id: null }) },
  );

  const rolesTable = mutableTable(
    () => state.roles as unknown as FakeRow[],
    (rows) => (state.roles = rows as unknown as FakeRoleRow[]),
    { defaults: () => ({ scope_team_id: null }) },
  );

  const ACTIVE_REQUEST_STATUSES = ["REQUESTED", "IN_PROGRESS", "NEEDS_CHANGE"];
  const derogationRequestsTable = mutableTable(
    () => state.derogationRequests,
    (rows) => (state.derogationRequests = rows),
    {
      defaults: () => {
        const now = fakeNow();
        return { status: "REQUESTED", updated_at: now, last_message_at: now, is_custom_weekday: false };
      },
      // Index unique PARTIEL derogation_requests_one_active_per_match.
      unique: (row, rows) => ACTIVE_REQUEST_STATUSES.includes(row.status as string) && rows.some((r) => r.match_id === row.match_id && ACTIVE_REQUEST_STATUSES.includes(r.status as string)),
    },
  );

  const fbiCredentialsTable = {
    select: (_cols?: string) => ({
      eq: (_col: string, clubId: string) => ({
        maybeSingle: () => Promise.resolve({ data: state.fbiCredentials.find((r) => r.club_id === clubId) ?? null, error: null }),
      }),
    }),
    upsert: (row: FakeFbiCredentialsRow) => {
      const index = state.fbiCredentials.findIndex((r) => r.club_id === row.club_id);
      if (index >= 0) state.fbiCredentials[index] = row;
      else state.fbiCredentials.push(row);
      return Promise.resolve({ error: null });
    },
  };

  const fbiIntegrationStatusTable = {
    select: (_cols?: string) => ({
      eq: (_col: string, clubId: string) => ({
        maybeSingle: () => Promise.resolve({ data: state.fbiIntegrationStatus.find((r) => r.club_id === clubId) ?? null, error: null }),
      }),
    }),
    upsert: (patch: Partial<FakeFbiIntegrationStatusRow> & { club_id: string }) => {
      const index = state.fbiIntegrationStatus.findIndex((r) => r.club_id === patch.club_id);
      if (index >= 0) Object.assign(state.fbiIntegrationStatus[index]!, patch);
      else
        state.fbiIntegrationStatus.push({
          configured: false,
          last_login_success: null,
          last_login_at: null,
          auto_import_emarque: false,
          last_error: null,
          ...patch,
        });
      return Promise.resolve({ error: null });
    },
  };

  const matchesTable = {
    select: (_cols?: string, _opts?: { count?: string }) => queryable(state.matches),
    update: (patch: Partial<FakeMatchRow>) => {
      const filters: { col: string; value: unknown }[] = [];
      const api = {
        eq(col: string, value: unknown) {
          filters.push({ col, value });
          return api;
        },
        select() {
          const rows = state.matches.filter((m) => filters.every((f) => (m as unknown as Record<string, unknown>)[f.col] === f.value));
          rows.forEach((r) => Object.assign(r, patch));
          return Promise.resolve({ data: rows, error: null });
        },
        // `.update(patch).eq(...)` attendu directement, sans `.select()`.
        then(onFulfilled: (v: { error: null }) => unknown) {
          return api.select().then(() => ({ error: null })).then(onFulfilled);
        },
      };
      return api;
    },
  };

  let teamCounter = 0;
  const teamsTable = {
    select: (_cols?: string) => queryable(state.teams),
    insert: (payload: Omit<FakeTeamRow, "id">) => ({
      select: () => ({
        single: () => {
          teamCounter += 1;
          // `active` par défaut à `true` (comme la colonne Postgres `not null default true`) si non fourni.
          const row: FakeTeamRow = { id: `team-auto-${teamCounter}`, active: true, ...payload };
          state.teams.push(row);
          return Promise.resolve({ data: row, error: null });
        },
      }),
    }),
    update: (patch: Partial<FakeTeamRow>) => {
      const filters: { col: string; value: unknown }[] = [];
      const api = {
        eq(col: string, value: unknown) {
          filters.push({ col, value });
          return api;
        },
        select() {
          const rows = state.teams.filter((t) => filters.every((f) => (t as unknown as Record<string, unknown>)[f.col] === f.value));
          rows.forEach((r) => Object.assign(r, patch));
          return {
            single: () => (rows[0] ? Promise.resolve({ data: rows[0], error: null }) : Promise.resolve({ data: null, error: { message: "not found" } })),
          };
        },
      };
      return api;
    },
  };
  const competitionsTable = { select: (_cols?: string) => queryable(state.competitions) };
  const emarqueImportsTable = { select: (_cols?: string, _opts?: { count?: string }) => queryable(state.emarqueImports) };
  const fbiScheduleDiscrepanciesTable = { select: (_cols?: string) => queryable(state.fbiScheduleDiscrepancies) };
  const fbiDerogationChecksTable = { select: (_cols?: string) => queryable(state.fbiDerogationChecks) };

  let fbiJobCounter = 0;
  const fbiJobsTable = {
    select: (_cols?: string) => queryable(state.fbiJobs),
    insert: (payload: { club_id: string; match_id?: string | null; type: string; scheduled_at?: string; window_start?: string | null }) => {
      const matchId = payload.match_id ?? null;
      const blockingStatuses = ["pending", "claimed", "running"];
      const hasConflict = state.fbiJobs.some(
        (j) => j.club_id === payload.club_id && j.match_id === matchId && j.type === payload.type && blockingStatuses.includes(j.status),
      );
      // Thenable ET chaînable `.select("id").single()` (comme le vrai client).
      const settle = <T extends { error: unknown }>(result: T, row: unknown) =>
        Object.assign(Promise.resolve(result), { select: () => ({ single: () => Promise.resolve({ data: row, error: result.error }) }) });
      if (hasConflict) return settle({ error: { code: "23505", message: "duplicate key value violates unique constraint" } }, null);

      fbiJobCounter += 1;
      const now = new Date().toISOString();
      state.fbiJobs.push({
        id: `fbi-job-${fbiJobCounter}`,
        club_id: payload.club_id,
        match_id: matchId,
        type: payload.type,
        status: "pending",
        scheduled_at: payload.scheduled_at ?? now,
        window_start: payload.window_start ?? null,
        created_at: now,
      });
      return settle({ error: null }, state.fbiJobs[state.fbiJobs.length - 1]);
    },
    // `.update(patch).eq(...).in(...).lt(...)`, thenable sans `.select()` —
    // même contrat que `licenciesTable.update`, voir reclaimStaleReconcileScheduleJob
    // (modules/derogations/fbi-session-lock.ts) qui l'appelle ainsi.
    update: (patch: Partial<FakeFbiJobRow>) => {
      const filters: { col: string; value: unknown; op: "eq" | "in" | "lt" }[] = [];
      const applyAndCollect = () => {
        const rows = state.fbiJobs.filter((j) =>
          filters.every((f) => {
            const fieldValue = (j as unknown as Record<string, unknown>)[f.col];
            if (f.op === "in") return (f.value as unknown[]).includes(fieldValue);
            if (f.op === "lt") return typeof fieldValue === "string" && fieldValue < (f.value as string);
            return fieldValue === f.value;
          }),
        );
        rows.forEach((r) => Object.assign(r, patch));
        return rows;
      };
      const api = {
        eq(col: string, value: unknown) {
          filters.push({ col, value, op: "eq" });
          return api;
        },
        in(col: string, values: unknown[]) {
          filters.push({ col, value: values, op: "in" });
          return api;
        },
        lt(col: string, value: unknown) {
          filters.push({ col, value, op: "lt" });
          return api;
        },
        then(onFulfilled: (value: { data: FakeFbiJobRow[]; error: null }) => unknown) {
          return Promise.resolve({ data: applyAndCollect(), error: null }).then(onFulfilled);
        },
      };
      return api;
    },
  };

  let tableAssignmentCounter = 0;
  const tableAssignmentsTable = {
    select: (_cols?: string) => queryable(state.tableAssignments),
    // `.upsert(row, { onConflict }).select("id").single()` — même contrat que le vrai client (voir modules/tables/routes.ts, PUT .../table-assignments/:role).
    upsert: (row: Omit<FakeTableAssignmentRow, "id">, _opts?: { onConflict?: string }) => ({
      select: (_cols?: string) => ({
        single: () => {
          const existingIndex = state.tableAssignments.findIndex((a) => a.club_id === row.club_id && a.match_id === row.match_id && a.role === row.role);
          if (existingIndex >= 0) {
            Object.assign(state.tableAssignments[existingIndex]!, row);
            return Promise.resolve({ data: state.tableAssignments[existingIndex], error: null });
          }
          tableAssignmentCounter += 1;
          const created: FakeTableAssignmentRow = { id: `table-assignment-${tableAssignmentCounter}`, ...row };
          state.tableAssignments.push(created);
          return Promise.resolve({ data: created, error: null });
        },
      }),
    }),
    delete: () => {
      const filters: { col: string; value: unknown }[] = [];
      const api = {
        eq(col: string, value: unknown) {
          filters.push({ col, value });
          return api;
        },
        then(onFulfilled: (value: { error: null }) => unknown) {
          state.tableAssignments = state.tableAssignments.filter((a) => !filters.every((f) => (a as unknown as Record<string, unknown>)[f.col] === f.value));
          return Promise.resolve({ error: null }).then(onFulfilled);
        },
      };
      return api;
    },
  };

  let refereeOverrideCounter = 0;
  const refereeOverridesTable = {
    select: (_cols?: string) => queryable(state.refereeOverrides),
    // Directement thenable (pas de `.select()` chaîné) — même contrat que le
    // vrai appel dans modules/tables/routes.ts, PUT .../referee-status.
    upsert: (row: Omit<FakeRefereeOverrideRow, "id">, _opts?: { onConflict?: string }) => {
      const existingIndex = state.refereeOverrides.findIndex((r) => r.club_id === row.club_id && r.match_id === row.match_id);
      if (existingIndex >= 0) Object.assign(state.refereeOverrides[existingIndex]!, row);
      else {
        refereeOverrideCounter += 1;
        state.refereeOverrides.push({ id: `referee-override-${refereeOverrideCounter}`, ...row });
      }
      return Promise.resolve({ error: null });
    },
    delete: () => {
      const filters: { col: string; value: unknown }[] = [];
      const api = {
        eq(col: string, value: unknown) {
          filters.push({ col, value });
          return api;
        },
        then(onFulfilled: (value: { error: null }) => unknown) {
          state.refereeOverrides = state.refereeOverrides.filter((r) => !filters.every((f) => (r as unknown as Record<string, unknown>)[f.col] === f.value));
          return Promise.resolve({ error: null }).then(onFulfilled);
        },
      };
      return api;
    },
  };

  const publicTokensTable = {
    select: (_cols?: string) => queryable(state.publicTokens),
    // Simule les 2 index uniques de la migration (club_id+licencie_id PARTIEL sur actifs, et token_hash) — jamais un simple push sans vérification.
    insert: (row: Partial<FakePublicTokenRow> & { club_id: string; licencie_id: string; token_hash: string }) => {
      const activeLicencieDuplicate = state.publicTokens.some((t) => t.club_id === row.club_id && t.licencie_id === row.licencie_id && t.revoked_at === null);
      const tokenHashDuplicate = state.publicTokens.some((t) => t.token_hash === row.token_hash);
      if (activeLicencieDuplicate || tokenHashDuplicate) return Promise.resolve({ error: { code: "23505", message: "duplicate key value violates unique constraint" } });

      // Identifiant dérivé de l'état partagé (pas d'un compteur local) : un client fake est reconstruit à chaque requête.
      const created: FakePublicTokenRow = { id: `public-token-${state.publicTokens.length + 1}`, email: null, created_at: new Date().toISOString(), revoked_at: null, revoked_by: null, ...row };
      state.publicTokens.push(created);
      return Promise.resolve({ error: null });
    },
    // `.update(patch).eq(...).eq(...).is(...)`, thenable sans `.select()` — même contrat que `fbiJobsTable.update`.
    update: (patch: Partial<FakePublicTokenRow>) => {
      const filters: { col: string; value: unknown }[] = [];
      const api = {
        eq(col: string, value: unknown) {
          filters.push({ col, value });
          return api;
        },
        is(col: string, value: null) {
          filters.push({ col, value });
          return api;
        },
        then(onFulfilled: (value: { error: null }) => unknown) {
          const rows = state.publicTokens.filter((t) => filters.every((f) => (t as unknown as Record<string, unknown>)[f.col] === f.value));
          rows.forEach((r) => Object.assign(r, patch));
          return Promise.resolve({ error: null }).then(onFulfilled);
        },
      };
      return api;
    },
  };

  const syncRunsTable = { select: (_cols?: string) => queryable(state.syncRuns) };
  const profilesTable = { select: (_cols?: string) => queryable(state.profiles) };

  // Stubs minimaux (toujours vides) : les routes de la fiche joueur
  // (modules/licencies/routes.ts) agrègent aussi ces deux tables, mais leur
  // jointure profonde n'est PAS testée ici — même choix que le détail d'un
  // match (`modules/matches/routes.ts#GET /:matchId`, jamais unit-testé
  // pour la même raison, voir son propre fichier de test) : seule la
  // logique de permission (admin/self/aucun) est couverte au niveau route,
  // la jointure elle-même est vérifiée manuellement contre la vraie base.
  const matchParticipantsTable = { select: (_cols?: string) => queryable<never>([]) };
  // `queryable([])` plutôt qu'un stub sur-mesure : couvre à la fois
  // `.in("participant_id", ids)` (fiche joueur, modules/licencies/routes.ts)
  // ET `.eq("match_id", ...).eq("club_id", ...)` (détail d'un match,
  // modules/matches/shared.ts) — toujours vide dans les deux cas (même
  // raison que `matchParticipantsTable` ci-dessus).
  const playerMatchStatsTable = { select: (_cols?: string) => queryable<never>([]) };
  // Mêmes stubs "toujours vides" que ci-dessus, même raison (jointures du
  // détail d'un match non unit-testées en profondeur).
  const matchCoachesTable = { select: (_cols?: string) => queryable<never>([]) };
  const matchOfficialsTable = { select: (_cols?: string) => queryable<never>([]) };
  const matchTableOfficialsTable = { select: (_cols?: string) => queryable<never>([]) };

  let matchDocumentCounter = 0;
  const matchDocumentsTable = {
    select: (_cols?: string) => queryable(state.matchDocuments),
    insert: (row: Partial<FakeMatchDocumentRow> & { club_id: string; match_id: string }) => {
      matchDocumentCounter += 1;
      const created: FakeMatchDocumentRow = {
        id: `match-document-${matchDocumentCounter}`,
        type: "match_sheet",
        filename: null,
        mime_type: null,
        status: "downloaded",
        discovered_at: new Date().toISOString(),
        downloaded_at: null,
        storage_path: `fake/${matchDocumentCounter}`,
        source: "fbi",
        purged_at: null,
        ...row,
      };
      state.matchDocuments.push(created);
      return Promise.resolve({ data: created, error: null });
    },
    update: (patch: Partial<FakeMatchDocumentRow>) => ({
      eq: (_col: string, id: string) => {
        const row = state.matchDocuments.find((d) => d.id === id);
        if (row) Object.assign(row, patch);
        return Promise.resolve({ error: null });
      },
    }),
  };

  let licencieCounter = 0;
  const licenciesTable = {
    select: (_cols?: string) => queryable(state.licencies),
    insert: (payload: Partial<FakeLicencieRow> | Partial<FakeLicencieRow>[]) => {
      const rows = Array.isArray(payload) ? payload : [payload];
      const inserted = rows.map((row) => {
        licencieCounter += 1;
        return { id: `licencie-auto-${licencieCounter}`, active: true, ...row } as FakeLicencieRow;
      });
      state.licencies.push(...inserted);
      const result = { data: inserted, error: null };
      // Thenable (insert simple) ET chaînable `.select().single()` (ajout manuel).
      return Object.assign(Promise.resolve(result), {
        select: () => ({ single: () => Promise.resolve({ data: inserted[0] ?? null, error: null }) }),
      });
    },
    update: (patch: Partial<FakeLicencieRow>) => {
      const filters: { col: string; value: unknown; op: "eq" | "in" }[] = [];
      const applyAndCollect = () => {
        const rows = state.licencies.filter((l) =>
          filters.every((f) => {
            const fieldValue = (l as unknown as Record<string, unknown>)[f.col];
            return f.op === "in" ? (f.value as unknown[]).includes(fieldValue) : fieldValue === f.value;
          }),
        );
        rows.forEach((r) => Object.assign(r, patch));
        return rows;
      };
      const api = {
        eq(col: string, value: unknown) {
          filters.push({ col, value, op: "eq" });
          return api;
        },
        in(col: string, values: unknown[]) {
          filters.push({ col, value: values, op: "in" });
          return api;
        },
        select() {
          const rows = applyAndCollect();
          return {
            single: () => (rows[0] ? Promise.resolve({ data: rows[0], error: null }) : Promise.resolve({ data: null, error: { message: "not found" } })),
          };
        },
        // Thenable : `await ...update(patch).eq(...).in(...)` SANS `.select()`
        // (voir `autoAssignTeamsForClub`) — applique les filtres accumulés et
        // résout directement, même contrat que `queryable().then()`.
        then(onFulfilled: (value: { data: FakeLicencieRow[]; error: null }) => unknown) {
          return Promise.resolve({ data: applyAndCollect(), error: null }).then(onFulfilled);
        },
      };
      return api;
    },
    delete: () => {
      const filters: { col: string; value: unknown }[] = [];
      const api = {
        eq(col: string, value: unknown) {
          filters.push({ col, value });
          return api;
        },
        then(onFulfilled: (value: { error: null }) => unknown) {
          state.licencies = state.licencies.filter((l) => !filters.every((f) => (l as unknown as Record<string, unknown>)[f.col] === f.value));
          return Promise.resolve({ error: null }).then(onFulfilled);
        },
      };
      return api;
    },
  };

  return {
    from(table: string) {
      switch (table) {
        case "clubs":
          return clubsTable;
        case "club_memberships":
          return membershipsTable;
        case "membership_roles":
          return rolesTable;
        case "fbi_credentials":
          return fbiCredentialsTable;
        case "fbi_integration_status":
          return fbiIntegrationStatusTable;
        case "sync_runs":
          return syncRunsTable;
        case "table_assignments":
          return tableAssignmentsTable;
        case "match_referee_overrides":
          return refereeOverridesTable;
        case "licencie_public_tokens":
          return publicTokensTable;
        case "matches":
          return matchesTable;
        case "competitions":
          return competitionsTable;
        case "club_venues":
          return mutableTable(() => state.clubVenues, (rows) => (state.clubVenues = rows), { defaults: () => ({ active: true, sort_order: 0, address: null }) });
        case "club_scheduling_rules":
          return { select: (_cols?: string) => queryable(state.schedulingRules) };
        case "derogation_requests":
          return derogationRequestsTable;
        case "derogation_proposals":
          return mutableTable(() => state.derogationProposals, (rows) => (state.derogationProposals = rows));
        case "derogation_messages":
          return mutableTable(() => state.derogationMessages, (rows) => (state.derogationMessages = rows));
        case "ffbb_team_engagements":
          return { select: (_cols?: string) => queryable(state.engagements) };
        case "pools":
          return { select: (_cols?: string) => queryable(state.pools) };
        case "teams":
          return teamsTable;
        case "emarque_imports":
          return emarqueImportsTable;
        case "fbi_schedule_discrepancies":
          return fbiScheduleDiscrepanciesTable;
        case "fbi_derogation_checks":
          return fbiDerogationChecksTable;
        case "fbi_jobs":
          return fbiJobsTable;
        case "profiles":
          return profilesTable;
        case "licencies":
          return licenciesTable;
        case "match_participants":
          return matchParticipantsTable;
        case "player_match_stats":
          return playerMatchStatsTable;
        case "match_coaches":
          return matchCoachesTable;
        case "match_officials":
          return matchOfficialsTable;
        case "match_table_officials":
          return matchTableOfficialsTable;
        case "match_documents":
          return matchDocumentsTable;
        case "training_series":
          return mutableTable(
            () => state.trainingSeries,
            (rows) => (state.trainingSeries = rows),
            { defaults: () => ({ club_venue_id: null, location_label: null, updated_at: fakeNow() }) },
          );
        case "training_occurrences":
          return mutableTable(
            () => state.trainingOccurrences,
            (rows) => (state.trainingOccurrences = rows),
            {
              defaults: () => ({ status: "scheduled", cancel_reason: null, is_modified: false, club_venue_id: null, location_label: null, series_id: null, series_date: null, updated_at: fakeNow() }),
              unique: (row, rows) => row.series_id != null && rows.some((r) => r.series_id === row.series_id && r.series_date === row.series_date),
            },
          );
        case "device_sessions":
          return mutableTable(() => state.deviceSessions, (rows) => (state.deviceSessions = rows), { defaults: () => ({ revoked_at: null, app_version: null, device_label: null }) });
        case "device_session_grants":
          return mutableTable(() => state.deviceSessionGrants, (rows) => (state.deviceSessionGrants = rows));
        case "auth_codes":
          return mutableTable(() => state.authCodes, (rows) => (state.authCodes = rows), { defaults: () => ({ used_at: null, code_challenge: null, redirect_path: null }) });
        case "device_push_tokens":
          return mutableTable(() => state.devicePushTokens, (rows) => (state.devicePushTokens = rows), { defaults: () => ({ revoked_at: null, revoked_reason: null, platform: "ios" }) });
        case "notification_outbox":
          return mutableTable(() => state.notificationOutbox, (rows) => (state.notificationOutbox = rows), {
            defaults: () => ({ status: "pending", attempts: 0, last_error: null, devices_sent: 0, created_at: new Date().toISOString(), next_attempt_at: new Date().toISOString(), sent_at: null }),
          });
        case "match_laundry_assignments":
          return mutableTable(() => state.laundry, (rows) => (state.laundry = rows), { defaults: () => ({ seen_at: null, updated_at: fakeNow() }) });
        case "training_attendance":
          return mutableTable(() => state.trainingAttendance, (rows) => (state.trainingAttendance = rows));
        case "match_availability_requests":
          return mutableTable(() => state.availabilityRequests, (rows) => (state.availabilityRequests = rows), {
            defaults: () => ({ opened_at: fakeNow() }),
            unique: (row, rows) => rows.some((r) => r.match_id === row.match_id && r.team_id === row.team_id),
          });
        case "match_availability_responses":
          return mutableTable(() => state.availabilityResponses, (rows) => (state.availabilityResponses = rows));
        case "match_convocations":
          return mutableTable(() => state.convocations, (rows) => (state.convocations = rows), {
            defaults: () => ({ draft_licencie_ids: [], draft_meeting_at: null, draft_meeting_point: null, draft_meeting_venue_id: null, draft_coach_message: null, revision: 0, meeting_at: null, meeting_point: null, meeting_venue_id: null, coach_message: null, match_snapshot: null, sent_at: null, updated_at: fakeNow() }),
            unique: (row, rows) => rows.some((r) => r.match_id === row.match_id && r.team_id === row.team_id),
          });
        case "match_convocation_recipients":
          return mutableTable(() => state.convocationRecipients, (rows) => (state.convocationRecipients = rows), {
            defaults: () => ({ response: "PENDING", responded_at: null, removed_at: null, updated_at: fakeNow() }),
          });
        case "match_convocation_dispatches":
          return mutableTable(() => state.convocationDispatches, (rows) => (state.convocationDispatches = rows));
        case "venues":
          return { select: (_cols?: string) => queryable(state.venues) };
        case "training_responses":
          return mutableTable(
            () => state.trainingResponses,
            (rows) => (state.trainingResponses = rows),
          );
        case "derogation_notifications":
          return mutableTable(
            () => state.derogationNotifications,
            (rows) => (state.derogationNotifications = rows),
            { unique: (row, rows) => rows.some((r) => r.club_id === row.club_id && r.kind === row.kind && r.ref_key === row.ref_key) },
          );
        case "licence_import_runs":
          return mutableTable(
            () => state.licenceImportRuns,
            (rows) => (state.licenceImportRuns = rows),
          );
        case "licencie_claim_requests":
          return mutableTable(
            () => state.claimRequests,
            (rows) => (state.claimRequests = rows),
            {
              defaults: () => ({ status: "pending", return_to: "accueil", expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(), decided_by: null, decided_at: null }),
              unique: (row, rows) => row.status === "pending" && rows.some((r) => r.licencie_id === row.licencie_id && r.status === "pending"),
            },
          );
        default:
          throw new Error(`Table inattendue dans le fake Supabase de test : ${table}`);
      }
    },
    rpc(fn: string, args?: { p_club_id?: string; p_integration?: string }) {
      if (fn === "is_platform_admin") return Promise.resolve({ data: state.isPlatformAdmin, error: null });
      if (fn === "try_acquire_sync_lock") {
        const key = `${args?.p_club_id}:${args?.p_integration}`;
        if (state.syncLocks.has(key)) return Promise.resolve({ data: false, error: null });
        state.syncLocks.add(key);
        return Promise.resolve({ data: true, error: null });
      }
      if (fn === "release_sync_lock") {
        const key = `${args?.p_club_id}:${args?.p_integration}`;
        state.syncLocks.delete(key);
        return Promise.resolve({ data: null, error: null });
      }
      throw new Error(`RPC inattendue dans le fake Supabase de test : ${fn}`);
    },
  };
}
