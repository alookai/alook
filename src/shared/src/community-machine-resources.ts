import { z } from "zod"
import { CommunityMachineSummarySchema } from "./schemas"

export const CommunityMachineIdentityCacheSchema = CommunityMachineSummarySchema.pick({ id: true, hostname: true, displayName: true,
  platform: true, arch: true, osRelease: true, daemonVersion: true, createdAt: true, updatedAt: true })
export const CommunityMachineListReadSchema = z.strictObject({ machines: z.array(CommunityMachineSummarySchema), complete: z.literal(true) })
export type CommunityMachineIdentityCache = z.infer<typeof CommunityMachineIdentityCacheSchema>
