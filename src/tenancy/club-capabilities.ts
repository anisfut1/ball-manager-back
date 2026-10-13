import type { DbClient } from "../db/client.js";

/**
 * Copié depuis ball-manager-web src/lib/tenancy/club-capabilities.ts. Modèle central du
 * caractère FACULTATIF de FBI (§15/§17 de la demande) : le frontend
 * n'implémente JAMAIS `if (fbiCredentials) ...` lui-même, il lit cette
 * réponse via `GET /v1/clubs/:clubId/capabilities`.
 */
export interface ClubCapabilities {
  ffbb: boolean;
  fbi: boolean;
  emarque: boolean;
}

export const PUBLIC_ONLY_CAPABILITIES: ClubCapabilities = { ffbb: true, fbi: false, emarque: false };

export function computeClubCapabilities(input: { ffbbEnabled: boolean; fbiConfigured: boolean; fbiConnected: boolean }): ClubCapabilities {
  return {
    ffbb: input.ffbbEnabled,
    fbi: input.fbiConfigured,
    emarque: input.fbiConfigured && input.fbiConnected,
  };
}

export async function getClubCapabilities(supabase: DbClient, clubId: string): Promise<ClubCapabilities> {
  const [{ data: club }, { data: fbiStatus }] = await Promise.all([
    supabase.from("clubs").select("ffbb_enabled").eq("id", clubId).maybeSingle(),
    supabase.from("fbi_integration_status").select("configured, last_login_success").eq("club_id", clubId).maybeSingle(),
  ]);

  return computeClubCapabilities({
    ffbbEnabled: club?.ffbb_enabled ?? true,
    fbiConfigured: fbiStatus?.configured ?? false,
    fbiConnected: fbiStatus?.last_login_success ?? false,
  });
}
