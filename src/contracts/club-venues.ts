import { z } from "./zod.js";

export const ClubVenueAdminDtoSchema = z
  .object({ id: z.string().uuid(), name: z.string(), address: z.string().nullable(), active: z.boolean(), sortOrder: z.number().int() })
  .openapi("ClubVenueAdminDto");

export const ClubVenueListDtoSchema = z.object({ venues: z.array(ClubVenueAdminDtoSchema) }).openapi("ClubVenueListDto");

export const UpdateClubVenueDtoSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100).optional(),
  })
  .strict()
  .openapi("UpdateClubVenueDto");

/** Indisponibilité d'un gymnase (journée, matin avant 13 h, après-midi à partir de 13 h) et ses conflits. */
export const VenueClosurePeriodSchema = z.enum(["day", "morning", "afternoon"]).openapi("VenueClosurePeriod");

export const VenueClosureConflictDtoSchema = z
  .object({
    kind: z.enum(["MATCH", "TRAINING"]),
    id: z.string().uuid(),
    teamName: z.string().nullable(),
    opponentName: z.string().nullable(),
    startsAt: z.string(),
    endsAt: z.string(),
  })
  .openapi("VenueClosureConflictDto");

export const VenueClosureDtoSchema = z
  .object({
    id: z.string().uuid(),
    clubVenueId: z.string().uuid(),
    venueName: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    period: VenueClosurePeriodSchema,
    reason: z.string().nullable(),
    conflicts: z.array(VenueClosureConflictDtoSchema),
  })
  .openapi("VenueClosureDto");

export const VenueClosureListDtoSchema = z.object({ closures: z.array(VenueClosureDtoSchema) }).openapi("VenueClosureListDto");

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format AAAA-MM-JJ.");

export const CreateVenueClosureDtoSchema = z
  .object({
    clubVenueId: z.string().uuid(),
    startDate: dateKey,
    endDate: dateKey,
    period: VenueClosurePeriodSchema.default("day"),
    reason: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine((v) => v.endDate >= v.startDate, { message: "La date de fin doit être après la date de début.", path: ["endDate"] })
  .openapi("CreateVenueClosureDto");
