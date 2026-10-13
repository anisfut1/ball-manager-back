/**
 * Types du schéma PostgreSQL — écrits à la main.
 *
 * À remplacer/compléter par `supabase gen types typescript` dès qu'un vrai
 * projet Supabase existe (voir README). En attendant, ce fichier doit rester
 * synchronisé manuellement avec `supabase/migrations/`.
 *
 * Note : `Relationships: []`, ainsi que `Views` vides sur le schéma
 * `public`, sont requis par le typage générique de `@supabase/postgrest-js`
 * (voir `GenericTable`/`GenericSchema`) — ce ne sont pas des données, juste
 * la forme attendue par la lib. `Table<Row, Insert>` factorise cette forme
 * pour éviter la répétition.
 *
 * Multi-tenant (voir docs/MULTI_TENANCY.md) : `clubs` est le tenant. Les
 * anciens `app_role`/`user_roles` (globaux) ont été remplacés par
 * `club_role`/`club_memberships`/`membership_roles` (scopés au club).
 */

type Table<Row, Insert> = {
  Row: Row;
  Insert: Insert;
  Update: Partial<Insert>;
  Relationships: [];
};

type Fn<Args, Returns> = { Args: Args; Returns: Returns };

export type ClubStatus = "active" | "suspended";
export type MembershipStatus = "active" | "suspended";
export type ClubRole = "club_admin" | "correspondant_club" | "responsable_tables" | "coach" | "joueur" | "parent";
export type DerogationRequestStatus = "REQUESTED" | "IN_PROGRESS" | "NEEDS_CHANGE" | "COMPLETED" | "CANCELLED";
export type MatchStatus = "scheduled" | "played" | "postponed" | "cancelled" | "forfeit";
/** Tables de marque (demande du club, 2026-09-28) — SCORER = marqueur, TIMEKEEPER = chronométreur, CLUB_DELEGATE = délégué de club, REFEREE = arbitre (ajouté 2026-09-28). */
export type TableAssignmentRole = "SCORER" | "TIMEKEEPER" | "CLUB_DELEGATE" | "REFEREE";
export type EmarqueMatchStatus =
  | "not_applicable"
  | "pending"
  | "waiting_for_emarque"
  | "discovered"
  | "downloading"
  | "downloaded"
  | "parsing"
  | "imported"
  | "error"
  | "needs_review"
  | "not_available";
export type SyncProvider = "ffbb" | "fbi";
export type SyncStatus = "running" | "success" | "partial" | "error";
export type EmarqueImportStatus = "discovered" | "downloading" | "downloaded" | "parsing" | "imported" | "error" | "needs_review";
export type TeamSide = "home" | "away";
export type CoachRole = "principal" | "adjoint";
export type RefereeRole = "referee_1" | "referee_2" | "referee_3";
export type TableOfficialRole = "scorer" | "assistant_scorer" | "timekeeper" | "shot_clock_operator" | "commissioner" | "other";
export type HistoricalSyncMode = "current_season" | "last_30_days" | "none";
export type FbiJobType = "test_connection" | "discover_emarque" | "reconcile_schedule" | "check_derogation" | "check_all_derogations" | "import_licences";
export type FbiJobStatus = "pending" | "claimed" | "running" | "succeeded" | "failed";
export type MatchDocumentType = "emarque_zip" | "match_sheet" | "summary" | "shot_chart" | "other";
export type MatchDocumentStatus = "downloaded" | "parsing" | "imported" | "error";
export type FbiScheduleDiscrepancyKind = "mismatch" | "missing_in_ffbb" | "missing_in_fbi";

// `type`, pas `interface` : `GenericTable["Row"]` (postgrest-js) attend
// `Record<string, unknown>`, et seul un alias de type sur un littéral d'objet
// bénéficie de la signature d'index implicite qui satisfait cette contrainte
// (une interface, elle, reste "ouverte" et ne l'obtient pas) — sinon toute la
// `Database` s'effondre silencieusement en `never` pour TOUS les consommateurs.
export type FbiJobRow = {
  id: string;
  club_id: string;
  match_id: string | null;
  type: FbiJobType;
  status: FbiJobStatus;
  attempt_count: number;
  max_attempts: number;
  scheduled_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  result: unknown;
  created_at: string;
  /** Début de la fenêtre de vérification e-Marque d'un job relancé à la main (sinon : fin du match) — voir `nextEmarqueCheckAt`. */
  window_start: string | null;
};

export interface Database {
  public: {
    Tables: {
      clubs: Table<
        {
          id: string;
          name: string;
          ffbb_club_id: string;
          slug: string;
          timezone: string;
          status: ClubStatus;
          short_name: string | null;
          logo_url: string | null;
          accent_color: string | null;
          ffbb_enabled: boolean;
          ffbb_next_sync_at: string | null;
          created_at: string;
        },
        {
          id?: string;
          name: string;
          ffbb_club_id: string;
          slug: string;
          timezone?: string;
          status?: ClubStatus;
          short_name?: string | null;
          logo_url?: string | null;
          accent_color?: string | null;
          ffbb_enabled?: boolean;
          ffbb_next_sync_at?: string | null;
          created_at?: string;
        }
      >;

      platform_admins: Table<{ user_id: string; created_at: string }, { user_id: string; created_at?: string }>;

      club_memberships: Table<
        {
          id: string;
          club_id: string;
          user_id: string;
          licencie_id: string | null;
          status: MembershipStatus;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          user_id: string;
          licencie_id?: string | null;
          status?: MembershipStatus;
          created_at?: string;
          updated_at?: string;
        }
      >;

      club_venues: Table<
        { id: string; club_id: string; name: string; address: string | null; venue_id: string | null; active: boolean; sort_order: number; created_at: string; updated_at: string },
        { id?: string; club_id: string; name: string; address?: string | null; venue_id?: string | null; active?: boolean; sort_order?: number; created_at?: string; updated_at?: string }
      >;

      club_scheduling_rules: Table<
        { id: string; club_id: string; weekday: number; earliest_start: string; latest_start: string; created_at: string; updated_at: string },
        { id?: string; club_id: string; weekday: number; earliest_start: string; latest_start: string; created_at?: string; updated_at?: string }
      >;

      derogation_requests: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          team_id: string | null;
          created_by_user_id: string | null;
          created_by_licencie_id: string | null;
          requester_membership_id: string | null;
          requester_display_name: string;
          original_scheduled_at: string | null;
          original_venue_id: string | null;
          requested_start_at: string;
          requested_club_venue_id: string | null;
          is_custom_weekday: boolean;
          status: DerogationRequestStatus;
          created_at: string;
          updated_at: string;
          last_message_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          team_id?: string | null;
          created_by_user_id?: string | null;
          created_by_licencie_id?: string | null;
          requester_membership_id?: string | null;
          requester_display_name: string;
          original_scheduled_at?: string | null;
          original_venue_id?: string | null;
          requested_start_at: string;
          requested_club_venue_id?: string | null;
          is_custom_weekday?: boolean;
          status?: DerogationRequestStatus;
          created_at?: string;
          updated_at?: string;
          last_message_at?: string;
        }
      >;

      derogation_proposals: Table<
        { id: string; club_id: string; request_id: string; proposed_by_user_id: string | null; proposed_by_licencie_id: string | null; proposed_by_display_name: string; requested_start_at: string; requested_club_venue_id: string | null; is_custom_weekday: boolean; created_at: string },
        { id?: string; club_id: string; request_id: string; proposed_by_user_id?: string | null; proposed_by_licencie_id?: string | null; proposed_by_display_name: string; requested_start_at: string; requested_club_venue_id?: string | null; is_custom_weekday?: boolean; created_at?: string }
      >;

      derogation_messages: Table<
        {
          id: string;
          club_id: string;
          request_id: string;
          author_user_id: string | null;
          author_licencie_id: string | null;
          author_membership_id: string | null;
          author_display_name: string;
          author_role_label: string | null;
          body: string;
          message_type: "USER" | "SYSTEM";
          event: string | null;
          created_at: string;
        },
        {
          id?: string;
          club_id: string;
          request_id: string;
          author_user_id?: string | null;
          author_licencie_id?: string | null;
          author_membership_id?: string | null;
          author_display_name: string;
          author_role_label?: string | null;
          body: string;
          message_type: "USER" | "SYSTEM";
          event?: string | null;
          created_at?: string;
        }
      >;

      membership_roles: Table<
        { id: string; membership_id: string; role: ClubRole; scope_team_id: string | null; scope_key: string; created_at: string },
        { id?: string; membership_id: string; role: ClubRole; scope_team_id?: string | null; created_at?: string }
      >;

      licencies: Table<
        {
          id: string;
          club_id: string;
          first_name: string;
          last_name: string;
          birth_date: string | null;
          license_number: string | null;
          email: string | null;
          phone: string | null;
          photo_url: string | null;
          team_id: string | null;
          active: boolean;
          ffbb_licence_id: string | null;
          category_label: string | null;
          sexe: "M" | "F" | null;
          public_admin: boolean;
          public_coach: boolean;
          public_coordinator: boolean;
          coached_team_ids: string[];
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          first_name: string;
          last_name: string;
          birth_date?: string | null;
          license_number?: string | null;
          email?: string | null;
          phone?: string | null;
          photo_url?: string | null;
          team_id?: string | null;
          active?: boolean;
          ffbb_licence_id?: string | null;
          category_label?: string | null;
          sexe?: "M" | "F" | null;
          public_admin?: boolean;
          public_coach?: boolean;
          public_coordinator?: boolean;
          coached_team_ids?: string[];
          created_at?: string;
          updated_at?: string;
        }
      >;

      profiles: Table<
        { user_id: string; display_name: string | null; created_at: string; updated_at: string },
        { user_id: string; display_name?: string | null; created_at?: string; updated_at?: string }
      >;

      teams: Table<
        {
          id: string;
          club_id: string;
          name: string;
          category: string | null;
          sexe: "M" | "F" | null;
          numero_equipe: string | null;
          active: boolean;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          name: string;
          category?: string | null;
          sexe?: "M" | "F" | null;
          numero_equipe?: string | null;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        }
      >;

      competitions: Table<
        {
          id: string;
          ffbb_competition_id: string;
          name: string;
          code: string | null;
          sexe: string | null;
          type_competition: string | null;
          category_code: string | null;
          category_label: string | null;
          phase_code: string | null;
          live_stat: boolean;
          emarque_v2: boolean;
          publication_internet: boolean;
          season: string | null;
          parent_ffbb_competition_id: string | null;
          raw_ffbb_payload: unknown;
          ffbb_last_seen_at: string;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          ffbb_competition_id: string;
          name: string;
          code?: string | null;
          sexe?: string | null;
          type_competition?: string | null;
          category_code?: string | null;
          category_label?: string | null;
          phase_code?: string | null;
          live_stat?: boolean;
          emarque_v2?: boolean;
          publication_internet?: boolean;
          season?: string | null;
          parent_ffbb_competition_id?: string | null;
          raw_ffbb_payload?: unknown;
          ffbb_last_seen_at?: string;
          created_at?: string;
          updated_at?: string;
        }
      >;

      pools: Table<
        {
          id: string;
          ffbb_pool_id: string;
          competition_id: string;
          name: string;
          raw_ffbb_payload: unknown;
          standings: unknown;
          standings_updated_at: string | null;
          ffbb_last_seen_at: string;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          ffbb_pool_id: string;
          competition_id: string;
          name: string;
          raw_ffbb_payload?: unknown;
          standings?: unknown;
          standings_updated_at?: string | null;
          ffbb_last_seen_at?: string;
          created_at?: string;
          updated_at?: string;
        }
      >;

      venues: Table<
        {
          id: string;
          ffbb_venue_id: string | null;
          name: string | null;
          address: string | null;
          raw_ffbb_payload: unknown;
          ffbb_last_seen_at: string;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          ffbb_venue_id?: string | null;
          name?: string | null;
          address?: string | null;
          raw_ffbb_payload?: unknown;
          ffbb_last_seen_at?: string;
          created_at?: string;
          updated_at?: string;
        }
      >;

      ffbb_team_engagements: Table<
        {
          id: string;
          club_id: string;
          team_id: string;
          ffbb_engagement_id: string;
          competition_id: string;
          pool_id: string | null;
          season: string | null;
          name: string | null;
          numero_equipe: string | null;
          raw_ffbb_payload: unknown;
          ffbb_last_seen_at: string;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          team_id: string;
          ffbb_engagement_id: string;
          competition_id: string;
          pool_id?: string | null;
          season?: string | null;
          name?: string | null;
          numero_equipe?: string | null;
          raw_ffbb_payload?: unknown;
          ffbb_last_seen_at?: string;
          created_at?: string;
          updated_at?: string;
        }
      >;

      matches: Table<
        {
          id: string;
          club_id: string;
          ffbb_match_id: string;
          ffbb_unique_key: string | null;
          ffbb_gs_id: string | null;
          numero: string | null;
          team_id: string | null;
          competition_id: string | null;
          pool_id: string | null;
          journee: string | null;
          match_datetime: string | null;
          is_home: boolean | null;
          opponent_name: string | null;
          opponent_ffbb_organisme_id: string | null;
          opponent_logo_url: string | null;
          venue_id: string | null;
          venue_raw_label: string | null;
          score_home: number | null;
          score_away: number | null;
          status: MatchStatus;
          emarque_status: EmarqueMatchStatus;
          emarque_discovery_attempt_count: number;
          emarque_next_discovery_attempt_at: string | null;
          raw_ffbb_payload: unknown;
          ffbb_last_seen_at: string;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          ffbb_match_id: string;
          ffbb_unique_key?: string | null;
          ffbb_gs_id?: string | null;
          numero?: string | null;
          team_id?: string | null;
          competition_id?: string | null;
          pool_id?: string | null;
          journee?: string | null;
          match_datetime?: string | null;
          is_home?: boolean | null;
          opponent_name?: string | null;
          opponent_ffbb_organisme_id?: string | null;
          opponent_logo_url?: string | null;
          venue_id?: string | null;
          venue_raw_label?: string | null;
          score_home?: number | null;
          score_away?: number | null;
          status?: MatchStatus;
          emarque_status?: EmarqueMatchStatus;
          emarque_discovery_attempt_count?: number;
          emarque_next_discovery_attempt_at?: string | null;
          raw_ffbb_payload?: unknown;
          ffbb_last_seen_at?: string;
          created_at?: string;
          updated_at?: string;
        }
      >;

      table_assignments: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          licencie_id: string;
          role: TableAssignmentRole;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          licencie_id: string;
          role: TableAssignmentRole;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      match_referee_overrides: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          no_referee_needed: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          no_referee_needed?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      licencie_public_tokens: Table<
        {
          id: string;
          club_id: string;
          licencie_id: string;
          token_hash: string;
          token_ciphertext: { ciphertext: string; iv: string; authTag: string } | null;
          email: string | null;
          created_at: string;
          revoked_at: string | null;
          revoked_by: string | null;
        },
        {
          id?: string;
          club_id: string;
          licencie_id: string;
          token_hash: string;
          token_ciphertext?: { ciphertext: string; iv: string; authTag: string } | null;
          email?: string | null;
          created_at?: string;
          revoked_at?: string | null;
          revoked_by?: string | null;
        }
      >;

      licencie_claim_requests: Table<
        {
          id: string;
          club_id: string;
          licencie_id: string;
          requested_email: string | null;
          return_to: string;
          status: "pending" | "approved" | "rejected";
          created_at: string;
          expires_at: string;
          decided_by: string | null;
          decided_at: string | null;
        },
        {
          id?: string;
          club_id: string;
          licencie_id: string;
          requested_email?: string | null;
          return_to?: string;
          status?: "pending" | "approved" | "rejected";
          created_at?: string;
          expires_at?: string;
          decided_by?: string | null;
          decided_at?: string | null;
        }
      >;

      training_series: Table<
        {
          id: string;
          club_id: string;
          team_id: string;
          weekday: number;
          start_time: string;
          end_time: string;
          club_venue_id: string | null;
          location_label: string | null;
          starts_on: string;
          ends_on: string;
          created_by_user_id: string | null;
          created_by_licencie_id: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          team_id: string;
          weekday: number;
          start_time: string;
          end_time: string;
          club_venue_id?: string | null;
          location_label?: string | null;
          starts_on: string;
          ends_on: string;
          created_by_user_id?: string | null;
          created_by_licencie_id?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      training_occurrences: Table<
        {
          id: string;
          club_id: string;
          team_id: string;
          series_id: string | null;
          series_date: string | null;
          starts_at: string;
          ends_at: string;
          club_venue_id: string | null;
          location_label: string | null;
          status: "scheduled" | "cancelled";
          cancel_reason: string | null;
          is_modified: boolean;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          team_id: string;
          series_id?: string | null;
          series_date?: string | null;
          starts_at: string;
          ends_at: string;
          club_venue_id?: string | null;
          location_label?: string | null;
          status?: "scheduled" | "cancelled";
          cancel_reason?: string | null;
          is_modified?: boolean;
          created_at?: string;
          updated_at?: string;
        }
      >;

      training_responses: Table<
        {
          id: string;
          club_id: string;
          occurrence_id: string;
          licencie_id: string;
          response: "PRESENT" | "ABSENT" | "UNCERTAIN";
          responded_at: string;
          responded_by_user_id: string | null;
          responded_by_licencie_id: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          occurrence_id: string;
          licencie_id: string;
          response: "PRESENT" | "ABSENT" | "UNCERTAIN";
          responded_at?: string;
          responded_by_user_id?: string | null;
          responded_by_licencie_id?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      training_attendance: Table<
        {
          id: string;
          club_id: string;
          occurrence_id: string;
          licencie_id: string;
          status: "PRESENT" | "LATE" | "ABSENT";
          marked_at: string;
          marked_by_user_id: string | null;
          marked_by_licencie_id: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          occurrence_id: string;
          licencie_id: string;
          status: "PRESENT" | "LATE" | "ABSENT";
          marked_at?: string;
          marked_by_user_id?: string | null;
          marked_by_licencie_id?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      // App iOS : sessions d'appareil dérivées du lien personnel (voir docs/MOBILE_AUTH.md).
      device_sessions: Table<
        {
          id: string;
          club_id: string;
          secret_hash: string;
          platform: "ios" | "web";
          app_version: string | null;
          device_label: string | null;
          created_at: string;
          last_used_at: string;
          expires_at: string;
          revoked_at: string | null;
        },
        {
          id?: string;
          club_id: string;
          secret_hash: string;
          platform: "ios" | "web";
          app_version?: string | null;
          device_label?: string | null;
          created_at?: string;
          last_used_at?: string;
          expires_at: string;
          revoked_at?: string | null;
        }
      >;

      device_push_tokens: Table<
        {
          id: string;
          session_id: string;
          club_id: string;
          token: string;
          platform: "ios";
          environment: "development" | "production";
          app_version: string | null;
          created_at: string;
          last_seen_at: string;
          revoked_at: string | null;
          revoked_reason: string | null;
        },
        {
          id?: string;
          session_id: string;
          club_id: string;
          token: string;
          platform?: "ios";
          environment: "development" | "production";
          app_version?: string | null;
          created_at?: string;
          last_seen_at?: string;
          revoked_at?: string | null;
          revoked_reason?: string | null;
        }
      >;

      notification_outbox: Table<
        {
          id: string;
          club_id: string;
          kind: string;
          dedupe_key: string;
          licencie_ids: string[];
          title: string;
          body: string;
          path: string;
          status: "pending" | "sending" | "sent" | "failed" | "expired";
          attempts: number;
          last_error: string | null;
          devices_sent: number;
          created_at: string;
          next_attempt_at: string;
          sent_at: string | null;
        },
        {
          id?: string;
          club_id: string;
          kind: string;
          dedupe_key: string;
          licencie_ids: string[];
          title: string;
          body: string;
          path: string;
          status?: "pending" | "sending" | "sent" | "failed" | "expired";
          attempts?: number;
          last_error?: string | null;
          devices_sent?: number;
          created_at?: string;
          next_attempt_at?: string;
          sent_at?: string | null;
        }
      >;

      device_session_grants: Table<
        { session_id: string; club_id: string; licencie_id: string; token_id: string; created_at: string },
        { session_id: string; club_id: string; licencie_id: string; token_id: string; created_at?: string }
      >;

      auth_codes: Table<
        {
          id: string;
          club_id: string;
          code_hash: string;
          purpose: "app_sso" | "login_link";
          token_ids: string[];
          code_challenge: string | null;
          redirect_path: string | null;
          created_at: string;
          expires_at: string;
          used_at: string | null;
        },
        {
          id?: string;
          club_id: string;
          code_hash: string;
          purpose: "app_sso" | "login_link";
          token_ids: string[];
          code_challenge?: string | null;
          redirect_path?: string | null;
          created_at?: string;
          expires_at: string;
          used_at?: string | null;
        }
      >;

      match_laundry_assignments: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          team_id: string;
          licencie_id: string;
          assigned_at: string;
          assigned_by_user_id: string | null;
          assigned_by_licencie_id: string | null;
          seen_at: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          team_id: string;
          licencie_id: string;
          assigned_at?: string;
          assigned_by_user_id?: string | null;
          assigned_by_licencie_id?: string | null;
          seen_at?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      match_availability_requests: Table<
        { id: string; club_id: string; match_id: string; team_id: string; opened_at: string; opened_by_user_id: string | null; opened_by_licencie_id: string | null; created_at: string; reminded_at: string | null },
        { id?: string; club_id: string; match_id: string; team_id: string; opened_at?: string; opened_by_user_id?: string | null; opened_by_licencie_id?: string | null; created_at?: string; reminded_at?: string | null }
      >;

      match_availability_responses: Table<
        {
          id: string;
          club_id: string;
          request_id: string;
          licencie_id: string;
          response: "AVAILABLE" | "UNAVAILABLE" | "UNCERTAIN";
          responded_at: string;
          responded_by_user_id: string | null;
          responded_by_licencie_id: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          request_id: string;
          licencie_id: string;
          response: "AVAILABLE" | "UNAVAILABLE" | "UNCERTAIN";
          responded_at?: string;
          responded_by_user_id?: string | null;
          responded_by_licencie_id?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      match_convocations: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          team_id: string;
          draft_licencie_ids: string[];
          draft_meeting_at: string | null;
          draft_meeting_point: string | null;
          draft_meeting_venue_id: string | null;
          draft_coach_message: string | null;
          revision: number;
          meeting_at: string | null;
          meeting_point: string | null;
          meeting_venue_id: string | null;
          coach_message: string | null;
          match_snapshot: unknown;
          sent_at: string | null;
          sent_by_user_id: string | null;
          sent_by_licencie_id: string | null;
          created_at: string;
          reminded_at: string | null;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          team_id: string;
          draft_licencie_ids?: string[];
          draft_meeting_at?: string | null;
          draft_meeting_point?: string | null;
          draft_meeting_venue_id?: string | null;
          draft_coach_message?: string | null;
          revision?: number;
          meeting_at?: string | null;
          meeting_point?: string | null;
          meeting_venue_id?: string | null;
          coach_message?: string | null;
          match_snapshot?: unknown;
          sent_at?: string | null;
          sent_by_user_id?: string | null;
          sent_by_licencie_id?: string | null;
          created_at?: string;
          reminded_at?: string | null;
          updated_at?: string;
        }
      >;

      match_convocation_recipients: Table<
        {
          id: string;
          club_id: string;
          convocation_id: string;
          licencie_id: string;
          response: "PENDING" | "CONFIRMED" | "DECLINED";
          responded_at: string | null;
          responded_by_user_id: string | null;
          responded_by_licencie_id: string | null;
          removed_at: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          convocation_id: string;
          licencie_id: string;
          response?: "PENDING" | "CONFIRMED" | "DECLINED";
          responded_at?: string | null;
          responded_by_user_id?: string | null;
          responded_by_licencie_id?: string | null;
          removed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      match_convocation_dispatches: Table<
        { id: string; club_id: string; convocation_id: string; licencie_id: string; revision: number; rendered_message: string; sent_at: string },
        { id?: string; club_id: string; convocation_id: string; licencie_id: string; revision: number; rendered_message: string; sent_at?: string }
      >;

      derogation_notifications: Table<
        { id: string; club_id: string; kind: "fbi_incoming" | "fbi_outcome"; ref_key: string; created_at: string },
        { id?: string; club_id: string; kind: "fbi_incoming" | "fbi_outcome"; ref_key: string; created_at?: string }
      >;

      licence_import_runs: Table<
        {
          id: string;
          club_id: string;
          source: "fbi" | "file";
          created_at: string;
          created_by: string | null;
          total: number;
          inserted: number;
          updated: number;
          reactivated: number;
          unchanged: number;
          not_in_export: number;
        },
        {
          id?: string;
          club_id: string;
          source: "fbi" | "file";
          created_at?: string;
          created_by?: string | null;
          total: number;
          inserted: number;
          updated: number;
          reactivated: number;
          unchanged: number;
          not_in_export: number;
        }
      >;

      match_change_history: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          sync_run_id: string | null;
          field_name: string;
          old_value: string | null;
          new_value: string | null;
          detected_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          sync_run_id?: string | null;
          field_name: string;
          old_value?: string | null;
          new_value?: string | null;
          detected_at?: string;
        }
      >;

      sync_runs: Table<
        {
          id: string;
          club_id: string;
          provider: SyncProvider;
          started_at: string;
          finished_at: string | null;
          status: SyncStatus;
          stats: unknown;
          error_log: string | null;
          created_at: string;
        },
        {
          id?: string;
          club_id: string;
          provider: SyncProvider;
          started_at?: string;
          finished_at?: string | null;
          status?: SyncStatus;
          stats?: unknown;
          error_log?: string | null;
          created_at?: string;
        }
      >;

      fbi_credentials: Table<
        {
          id: string;
          club_id: string;
          username: string;
          password_ciphertext: string;
          password_iv: string;
          password_auth_tag: string;
          updated_by: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          username: string;
          password_ciphertext: string;
          password_iv: string;
          password_auth_tag: string;
          updated_by?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      fbi_reachability_checks: Table<
        { id: number; checked_at: string; via: "proxy" | "direct"; ok: boolean; http_status: number | null; elapsed_ms: number; error: string | null; egress_ip: string | null },
        { id?: number; checked_at?: string; via: "proxy" | "direct"; ok: boolean; http_status?: number | null; elapsed_ms: number; error?: string | null; egress_ip?: string | null }
      >;
      fbi_session_traces: Table<
        { id: string; club_id: string; started_at: string; finished_at: string; via: "proxy" | "direct"; outcome: string; request_count: number; failed_count: number; events: unknown; fingerprint: unknown },
        { id?: string; club_id: string; started_at: string; finished_at?: string; via: "proxy" | "direct"; outcome: string; request_count: number; failed_count: number; events: unknown; fingerprint?: unknown }
      >;
      fbi_saved_sessions: Table<
        { club_id: string; state_ciphertext: string; state_iv: string; state_auth_tag: string; created_at: string; updated_at: string },
        { club_id: string; state_ciphertext: string; state_iv: string; state_auth_tag: string; created_at?: string; updated_at?: string }
      >;
      emarque_debug_cells: Table<
        { id: string; match_id: string; team: string; row_index: number; row_top: number; row_bottom: number; results: unknown; png_base64: string | null; created_at: string },
        { id?: string; match_id: string; team: string; row_index: number; row_top: number; row_bottom: number; results: unknown; png_base64?: string | null; created_at?: string }
      >;
      platform_settings: Table<
        { key: string; value: string; updated_at: string },
        { key: string; value: string; updated_at?: string }
      >;
      fbi_integration_status: Table<
        {
          id: string;
          club_id: string;
          configured: boolean;
          last_test_at: string | null;
          last_test_success: boolean | null;
          last_test_message: string | null;
          last_login_at: string | null;
          last_login_success: boolean | null;
          last_job_at: string | null;
          last_job_status: string | null;
          last_error: string | null;
          auto_import_emarque: boolean;
          historical_sync_mode: HistoricalSyncMode;
          updated_at: string;
          last_credential_login_at: string | null;
        },
        {
          id?: string;
          club_id: string;
          configured?: boolean;
          last_test_at?: string | null;
          last_test_success?: boolean | null;
          last_test_message?: string | null;
          last_login_at?: string | null;
          last_login_success?: boolean | null;
          last_job_at?: string | null;
          last_job_status?: string | null;
          last_error?: string | null;
          last_credential_login_at?: string | null;
          auto_import_emarque?: boolean;
          historical_sync_mode?: HistoricalSyncMode;
          updated_at?: string;
        }
      >;

      fbi_jobs: Table<
        FbiJobRow,
        {
          id?: string;
          club_id: string;
          match_id?: string | null;
          type: FbiJobType;
          status?: FbiJobStatus;
          attempt_count?: number;
          max_attempts?: number;
          scheduled_at?: string;
          claimed_at?: string | null;
          claimed_by?: string | null;
          started_at?: string | null;
          finished_at?: string | null;
          last_error?: string | null;
          result?: unknown;
          created_at?: string;
          window_start?: string | null;
        }
      >;

      match_documents: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          type: MatchDocumentType;
          source: "fbi";
          filename: string | null;
          mime_type: string | null;
          sha256: string;
          storage_path: string;
          status: MatchDocumentStatus;
          discovered_at: string;
          downloaded_at: string | null;
          last_error: string | null;
          /** `NULL` = fichier encore présent dans Storage ; sinon, horodatage de sa suppression (retour du club, 2026-09-29 : "je veux juste l'interpréter... pas la stocker", voir docs/EMARQUE.md). */
          purged_at: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          type: MatchDocumentType;
          source?: "fbi";
          filename?: string | null;
          mime_type?: string | null;
          sha256: string;
          storage_path: string;
          status?: MatchDocumentStatus;
          discovered_at?: string;
          downloaded_at?: string | null;
          last_error?: string | null;
          purged_at?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      sync_locks: Table<
        { club_id: string; integration: SyncProvider; locked_at: string },
        { club_id: string; integration: SyncProvider; locked_at?: string }
      >;

      fbi_schedule_discrepancies: Table<
        {
          id: string;
          club_id: string;
          match_id: string | null;
          division_code: string | null;
          numero: string | null;
          kind: FbiScheduleDiscrepancyKind;
          field_name: string | null;
          ffbb_value: string | null;
          fbi_value: string | null;
          fbi_opponent_name: string | null;
          detected_at: string;
          last_seen_at: string;
          resolved_at: string | null;
          auto_corrected_at: string | null;
          created_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id?: string | null;
          division_code?: string | null;
          numero?: string | null;
          kind: FbiScheduleDiscrepancyKind;
          field_name?: string | null;
          ffbb_value?: string | null;
          fbi_value?: string | null;
          fbi_opponent_name?: string | null;
          detected_at?: string;
          last_seen_at?: string;
          resolved_at?: string | null;
          auto_corrected_at?: string | null;
          created_at?: string;
        }
      >;

      fbi_derogation_checks: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          fbi_row_key: string;
          id_derogation: string | null;
          numero: string | null;
          etat: string | null;
          date_depot: string | null;
          date_derogation: string | null;
          date_rencontre: string | null;
          heure: string | null;
          domicile: string | null;
          visiteur: string | null;
          demandeur: string | null;
          motif: string | null;
          date_rencontre_demandee: string | null;
          heure_demandee: string | null;
          adversaire: string | null;
          date_reponse: string | null;
          acceptation: string | null;
          motif_refus: string | null;
          modifier_date: boolean | null;
          modifier_horaire: boolean | null;
          modifier_salle: boolean | null;
          salle_demandee: string | null;
          inverser_rencontre: boolean | null;
          inverser_equipe: boolean | null;
          changes_read_at: string | null;
          checked_at: string;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          fbi_row_key: string;
          id_derogation?: string | null;
          numero?: string | null;
          etat?: string | null;
          date_depot?: string | null;
          date_derogation?: string | null;
          date_rencontre?: string | null;
          heure?: string | null;
          domicile?: string | null;
          visiteur?: string | null;
          demandeur?: string | null;
          motif?: string | null;
          date_rencontre_demandee?: string | null;
          heure_demandee?: string | null;
          adversaire?: string | null;
          date_reponse?: string | null;
          acceptation?: string | null;
          motif_refus?: string | null;
          modifier_date?: boolean | null;
          modifier_horaire?: boolean | null;
          modifier_salle?: boolean | null;
          salle_demandee?: string | null;
          inverser_rencontre?: boolean | null;
          inverser_equipe?: boolean | null;
          changes_read_at?: string | null;
          checked_at?: string;
          created_at?: string;
          updated_at?: string;
        }
      >;

      fbi_derogation_responses: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          fbi_row_key: string;
          id_derogation: string;
          decision: "accepted" | "refused";
          motif_refus: string | null;
          submitted_by: string | null;
          outcome: "success" | "error" | "unknown";
          fbi_message: string | null;
          created_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          fbi_row_key: string;
          id_derogation: string;
          decision: "accepted" | "refused";
          motif_refus?: string | null;
          submitted_by?: string | null;
          outcome: "success" | "error" | "unknown";
          fbi_message?: string | null;
          created_at?: string;
        }
      >;

      fbi_derogation_creations: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          motif: string;
          modifier_date: boolean;
          date_derogation: string | null;
          modifier_horaire: boolean;
          horaire: string | null;
          inverser_rencontre: boolean;
          inverser_equipe: boolean;
          submitted_by: string | null;
          outcome: "success" | "error" | "unknown";
          fbi_message: string | null;
          created_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          motif: string;
          modifier_date?: boolean;
          date_derogation?: string | null;
          modifier_horaire?: boolean;
          horaire?: string | null;
          inverser_rencontre?: boolean;
          inverser_equipe?: boolean;
          submitted_by?: string | null;
          outcome: "success" | "error" | "unknown";
          fbi_message?: string | null;
          created_at?: string;
        }
      >;

      emarque_imports: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          source: "fbi";
          file_hash: string | null;
          source_file_name: string | null;
          storage_path: string | null;
          status: EmarqueImportStatus;
          parser_version: string | null;
          quality_warnings: unknown;
          discovered_at: string;
          downloaded_at: string | null;
          imported_at: string | null;
          last_error: string | null;
          attempt_count: number;
          next_attempt_at: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          source?: "fbi";
          file_hash?: string | null;
          source_file_name?: string | null;
          storage_path?: string | null;
          status?: EmarqueImportStatus;
          parser_version?: string | null;
          quality_warnings?: unknown;
          discovered_at?: string;
          downloaded_at?: string | null;
          imported_at?: string | null;
          last_error?: string | null;
          attempt_count?: number;
          next_attempt_at?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      match_participants: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          emarque_import_id: string;
          team_side: TeamSide;
          jersey_number: string | null;
          first_name: string | null;
          last_name: string | null;
          license_number: string | null;
          is_captain: boolean;
          is_starter: boolean | null;
          licencie_id: string | null;
          extraction_confidence: number | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          emarque_import_id: string;
          team_side: TeamSide;
          jersey_number?: string | null;
          first_name?: string | null;
          last_name?: string | null;
          license_number?: string | null;
          is_captain?: boolean;
          is_starter?: boolean | null;
          licencie_id?: string | null;
          extraction_confidence?: number | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      match_coaches: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          emarque_import_id: string;
          team_side: TeamSide;
          role: CoachRole;
          first_name: string | null;
          last_name: string | null;
          license_number: string | null;
          licencie_id: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          emarque_import_id: string;
          team_side: TeamSide;
          role?: CoachRole;
          first_name?: string | null;
          last_name?: string | null;
          license_number?: string | null;
          licencie_id?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      match_officials: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          emarque_import_id: string;
          role: RefereeRole;
          first_name: string | null;
          last_name: string | null;
          license_number: string | null;
          licencie_id: string | null;
          created_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          emarque_import_id: string;
          role: RefereeRole;
          first_name?: string | null;
          last_name?: string | null;
          license_number?: string | null;
          licencie_id?: string | null;
          created_at?: string;
        }
      >;

      match_table_officials: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          emarque_import_id: string;
          role: TableOfficialRole;
          first_name: string | null;
          last_name: string | null;
          license_number: string | null;
          licencie_id: string | null;
          extraction_confidence: number | null;
          created_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          emarque_import_id: string;
          role: TableOfficialRole;
          first_name?: string | null;
          last_name?: string | null;
          license_number?: string | null;
          licencie_id?: string | null;
          extraction_confidence?: number | null;
          created_at?: string;
        }
      >;

      player_match_stats: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          participant_id: string;
          seconds_played: number | null;
          points: number | null;
          shots_made: number | null;
          three_points_made: number | null;
          two_points_interior_made: number | null;
          two_points_exterior_made: number | null;
          free_throws_made: number | null;
          fouls_committed: number | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          participant_id: string;
          seconds_played?: number | null;
          points?: number | null;
          shots_made?: number | null;
          three_points_made?: number | null;
          two_points_interior_made?: number | null;
          two_points_exterior_made?: number | null;
          free_throws_made?: number | null;
          fouls_committed?: number | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      shot_events: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          participant_id: string | null;
          team_side: TeamSide;
          period: number | null;
          made: boolean;
          shot_type: string | null;
          x: number | null;
          y: number | null;
          created_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          participant_id?: string | null;
          team_side: TeamSide;
          period?: number | null;
          made: boolean;
          shot_type?: string | null;
          x?: number | null;
          y?: number | null;
          created_at?: string;
        }
      >;
    };
    Views: Record<string, never>;
    Functions: {
      is_club_member: Fn<{ target_club_id: string }, boolean>;
      has_club_role: Fn<{ target_club_id: string; target_role: ClubRole }, boolean>;
      is_platform_admin: Fn<Record<string, never>, boolean>;
      try_acquire_sync_lock: Fn<{ p_club_id: string; p_integration: SyncProvider; p_stale_after?: string }, boolean>;
      release_sync_lock: Fn<{ p_club_id: string; p_integration: SyncProvider }, void>;
      claim_next_fbi_job: Fn<{ p_worker_id: string }, FbiJobRow | null>;
      claim_next_fbi_job_for_club: Fn<{ p_club_id: string; p_worker_id: string }, FbiJobRow | null>;
      claim_next_discover_job_in_session: Fn<{ p_club_id: string; p_worker_id: string }, FbiJobRow | null>;
    };
    Enums: {
      club_role: ClubRole;
    };
  };
}
