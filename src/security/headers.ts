import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";

/**
 * En-têtes de sécurité d'une API JSON (S-12a). Aucune ressource de l'API
 * n'est chargée par une page d'une autre origine (ni image, ni PDF, ni
 * iframe : les photos sont servies par Supabase Storage et les appels du web
 * passent par fetch/CORS, que `Cross-Origin-Resource-Policy` ne concerne pas) :
 * `same-origin` suffit.
 */
const apiHeaders = secureHeaders({
  contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  crossOriginResourcePolicy: "same-origin",
  referrerPolicy: "no-referrer",
  strictTransportSecurity: "max-age=31536000",
  xFrameOptions: "DENY",
});

/** Swagger UI (/docs, hors production) charge ses scripts et styles depuis jsdelivr et injecte du code en ligne. */
const docsHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
    imgSrc: ["'self'", "data:", "https:"],
    fontSrc: ["https://cdn.jsdelivr.net", "data:"],
    connectSrc: ["'self'"],
    frameAncestors: ["'none'"],
  },
  crossOriginResourcePolicy: "same-origin",
  referrerPolicy: "no-referrer",
  strictTransportSecurity: "max-age=31536000",
  xFrameOptions: "DENY",
});

export const securityHeaders: MiddlewareHandler = (c, next) => (c.req.path === "/docs" ? docsHeaders(c, next) : apiHeaders(c, next));
