import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

/** Requête HTTP/2 factice : le test pilote les événements `response`, `data` et `close`. */
class FakeRequest extends EventEmitter {
  setTimeout = vi.fn();
  close = vi.fn();
  end = vi.fn();
}

let lastRequest: FakeRequest;

vi.mock("node:http2", () => ({
  connect: () => {
    const session = new EventEmitter() as EventEmitter & { request: () => FakeRequest; closed: boolean; destroyed: boolean; close: () => void };
    session.closed = false;
    session.destroyed = false;
    session.close = () => undefined;
    session.request = () => (lastRequest = new FakeRequest());
    return session;
  },
}));

const { createApnsSender } = await import("./apns.js");

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const config = {
  teamId: "ABCDE12345",
  keyId: "KEYID12345",
  bundleId: "fr.test.app",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const message = { title: "t", body: "b", threadId: "th", path: "/" };

async function respond(status: number, body: string | null) {
  const sender = createApnsSender(config);
  const result = sender.send("device-token", "production", message);
  lastRequest.emit("response", { ":status": status });
  if (body !== null) lastRequest.emit("data", Buffer.from(body));
  lastRequest.emit("close");
  return result;
}

describe("createApnsSender — lecture de la raison d'échec APNs", () => {
  it("200 : envoi réussi", async () => {
    expect(await respond(200, null)).toEqual({ ok: true });
  });

  it("raison lue dans le JSON de la réponse, définitive pour BadDeviceToken", async () => {
    expect(await respond(400, JSON.stringify({ reason: "BadDeviceToken" }))).toEqual({ ok: false, status: 400, reason: "BadDeviceToken", permanent: true });
  });

  it("JSON sans raison : repli sur « HTTP <code> »", async () => {
    expect(await respond(503, "{}")).toEqual({ ok: false, status: 503, reason: "HTTP 503", permanent: false });
  });

  it("corps non JSON : les 80 premiers caractères servent de raison", async () => {
    const body = "x".repeat(200);
    expect(await respond(500, body)).toEqual({ ok: false, status: 500, reason: "x".repeat(80), permanent: false });
  });

  it("corps vide : repli sur « HTTP <code> »", async () => {
    expect(await respond(502, null)).toEqual({ ok: false, status: 502, reason: "HTTP 502", permanent: false });
  });

  it("410 est toujours définitif", async () => {
    expect(await respond(410, JSON.stringify({ reason: "Unregistered" }))).toMatchObject({ permanent: true });
  });
});
