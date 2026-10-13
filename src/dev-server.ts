import { serve } from "@hono/node-server";
import { app } from "./app.js";

/**
 * Serveur local (`npm run dev`) — UNIQUEMENT pour le développement. En
 * production, Vercel invoque `api/index.ts` directement (voir
 * docs/DEPLOYMENT.md) ; ce fichier n'est jamais déployé comme fonction.
 */
const port = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ball-manager-back en écoute sur http://localhost:${info.port}`);
});
