import { z } from "zod"
import { CommunityResourceProfileSchema } from "./community-resources"

export const TaskEmailAddressCacheSchema = z.array(z.strictObject({
  workspaceId: z.string().min(1), agentId: z.string().min(1), emailAddress: z.string(),
}))
export const TaskMemberInstructionCacheSchema = z.strictObject({
  workspaceId: z.string().min(1), userId: z.string().min(1), globalInstruction: z.string(),
}).nullable()
export const TaskUserIdentityCacheSchema = CommunityResourceProfileSchema.pick({ id: true, name: true }).extend({ email: z.string() }).nullable()
