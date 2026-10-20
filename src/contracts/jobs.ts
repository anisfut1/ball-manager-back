import { z } from "./zod.js";

/** §36 de la demande : opérations potentiellement longues -> 202 + jobId, jamais une connexion HTTP maintenue ouverte. */
export const JobAcceptedDtoSchema = z
  .object({
    jobId: z.string().uuid(),
    status: z.literal("pending"),
  })
  .openapi("JobAcceptedDto");

export const JobStatusDtoSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(["test_connection", "discover_emarque", "reconcile_schedule", "check_derogation", "check_all_derogations", "import_licences", "create_derogation", "respond_derogation"]),
    status: z.enum(["pending", "claimed", "running", "succeeded", "failed"]),
    attemptCount: z.number(),
    lastError: z.string().nullable(),
    result: z.unknown().nullable(),
    scheduledAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .openapi("JobStatusDto");

export type JobStatusDto = z.infer<typeof JobStatusDtoSchema>;
