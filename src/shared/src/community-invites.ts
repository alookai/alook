import { z } from "zod"
import { BUSINESS_SCHEMA_VERSION } from "./business-schema-version"
import { CommunityInviteCreateSchema } from "./community-ws-events"
import { CommunityResourceBundleSchema, CommunityResourceProfileSchema, CommunityServerResourceSchema } from "./community-resources"

export const CommunityInviteListItemSchema = CommunityInviteCreateSchema.shape.invite.required({ maxUses: true, uses: true, expiresAt: true }).extend({
  uses: CommunityInviteCreateSchema.shape.invite.shape.uses.unwrap().unwrap().int().nonnegative(),
  creatorId: CommunityResourceProfileSchema.shape.id.nullable(),
})
export const CommunityInvitesReadSchema = z.strictObject({
  contractVersion: z.literal(BUSINESS_SCHEMA_VERSION),
  serverId: CommunityServerResourceSchema.shape.id,
  invites: z.array(CommunityInviteListItemSchema),
  resources: CommunityResourceBundleSchema,
}).superRefine((value, ctx) => {
  if (new Set(value.invites.map(row => row.id)).size !== value.invites.length) ctx.addIssue({ code: "custom", message: "Duplicate invite descriptor" })
  if (!value.resources.servers.some(row => row.id === value.serverId) || value.resources.servers.some(row => row.id !== value.serverId)) ctx.addIssue({ code: "custom", message: "Invite server resource mismatch" })
  if (value.invites.some(row => row.creatorId !== null && !value.resources.profiles.some(profile => profile.id === row.creatorId))) ctx.addIssue({ code: "custom", message: "Invite creator profile resource missing" })
})
export type CommunityInviteListItem = z.infer<typeof CommunityInviteListItemSchema>
export type CommunityInvitesRead = z.infer<typeof CommunityInvitesReadSchema>
