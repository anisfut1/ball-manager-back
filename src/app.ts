import { Hono } from "hono";
import { cors } from "hono/cors";
import { swaggerUI } from "@hono/swagger-ui";
import type { AppEnv } from "./auth/context.js";
import { ApiError } from "./api-error.js";
import { getEnv } from "./config/env.js";
import { v1Router } from "./api/v1/index.js";
import { internalRouter } from "./api/internal/index.js";
import { generateOpenApiDocument } from "./openapi.js";
import { logError } from "./logger.js";
import { securityHeaders } from "./security/headers.js";
import { isProductionDeployment } from "./security/runtime-env.js";

export const app = new Hono<AppEnv>();

/**
 * CORS (§39 de la demande) : liste configurable d'origines, jamais un
 * wildcard avec authentification. `FRONTEND_ORIGINS` est une liste séparée
 * par des virgules (voir .env.example).
 */
app.use(
  "*",
  cors({
    origin: (origin) => {
      // L'app mobile native (ball-manager-app) n'envoie pas d'en-tête Origin : CORS ne concerne que le web.
      const allowed = getEnv().FRONTEND_ORIGINS.split(",").map((o) => o.trim());
      return origin && allowed.includes(origin) ? origin : "";
    },
    // X-Personal-Link-Token : lien personnel hors URL (web, R-014) ; X-BM-As : personne active d'une session d'appareil (app mobile).
    allowHeaders: ["Content-Type", "Authorization", "X-Personal-Link-Token", "X-BM-As"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  }),
);

/** En-têtes de sécurité (S-12a), après CORS pour ne jamais écraser ses en-têtes. */
app.use("*", securityHeaders);

/** GET /health — §41 de la demande : simple, sans auth, sans secret. */
app.get("/health", (c) => c.json({ status: "ok" }));

// /openapi.json reste public en production : ball-manager-app génère ses types depuis cette URL
// (scripts/generate-api-types.mjs). À cacher une fois ce script changé (voir src/app-docs.test.ts).
app.get("/openapi.json", (c) => c.json(generateOpenApiDocument()));
// Swagger UI : disponible en développement et en preview, introuvable en production (S-11).
app.get("/docs", (c, next) => (isProductionDeployment() ? c.notFound() : next()), swaggerUI({ url: "/openapi.json" }));

app.route("/v1", v1Router);
app.route("/internal", internalRouter);

/**
 * Contrat d'erreur uniforme (§40 de la demande) : `{ error: { code,
 * message } }`, jamais de stack trace en production.
 */
app.onError((error, c) => {
  if (error instanceof ApiError) {
    const body = error.details === undefined ? { code: error.code, message: error.message } : { code: error.code, message: error.message, details: error.details };
    return c.json({ error: body }, error.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503);
  }

  logError("Erreur interne non gérée", error, { path: c.req.path, method: c.req.method });
  return c.json({ error: { code: "INTERNAL_ERROR", message: "Une erreur interne est survenue." } }, 500);
});

app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Route introuvable." } }, 404));
