import { z } from "zod"

const result = z.strictObject({ online: z.array(z.string().min(1)), offline: z.array(z.string().min(1)) })
const disjoint = (value: z.infer<typeof result>) => !value.offline.some(id => value.online.includes(id))

export const CommunityPresenceResultSchema = result.refine(disjoint, "Conflicting user presence")
export const CommunityPresenceReadSchema = result.extend({
  truncated: z.boolean().optional(), limit: z.number().int().positive().optional(), stale: z.literal(true).optional(),
}).refine(disjoint, "Conflicting user presence")
export type CommunityPresenceResult = z.infer<typeof CommunityPresenceResultSchema>
export type CommunityPresenceRead = z.infer<typeof CommunityPresenceReadSchema>
