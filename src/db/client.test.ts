import { afterEach, describe, expect, it, vi } from "vitest";

let capturedFetch: typeof fetch | undefined;

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, options: { global: { fetch: typeof fetch } }) => {
    capturedFetch = options.global.fetch;
    return {};
  },
}));

const { createServiceSupabaseClient } = await import("./client.js");

afterEach(() => {
  vi.unstubAllGlobals();
  capturedFetch = undefined;
});

function clientFetch(): typeof fetch {
  createServiceSupabaseClient();
  return capturedFetch!;
}

describe("timeoutFetch (fetch injecté dans les clients Supabase)", () => {
  it("une requête interrompue relance une Error au message inchangé, avec l'erreur d'origine en `cause`", async () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));

    const error = await clientFetch()("https://x.test/rest/v1/clubs").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).constructor).toBe(Error);
    expect((error as Error).message).toBe("Requête Supabase interrompue après 15000ms sans réponse.");
    expect((error as Error).cause).toBe(abort);
  });

  it("une autre erreur réseau est relancée telle quelle", async () => {
    const network = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(network));
    await expect(clientFetch()("https://x.test/rest/v1/clubs")).rejects.toBe(network);
  });

  it("une réponse normale est renvoyée", async () => {
    const response = new Response("{}", { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(await clientFetch()("https://x.test/rest/v1/clubs")).toBe(response);
  });
});
