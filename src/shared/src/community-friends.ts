import { z } from "zod"
import { BUSINESS_SCHEMA_VERSION } from "./business-schema-version"
import { friendshipSchema } from "./community-cache"
import { CommunityResourceBundleSchema, type CommunityResourceBundle } from "./community-resources"

export const CommunityAcceptedFriendDescriptorSchema = friendshipSchema.pick({ id: true, userId: true, sub: true })
export const CommunityBlockedFriendDescriptorSchema = friendshipSchema.pick({ id: true, userId: true })
export const CommunityPendingFriendDescriptorSchema = friendshipSchema.pick({ id: true, userId: true, needsOwnerApproval: true }).extend({
  kind: friendshipSchema.shape.kind.extract(["incoming", "outgoing"]),
})

const envelope = { contractVersion: z.literal(BUSINESS_SCHEMA_VERSION) }
const fresh = { ...envelope, resources: CommunityResourceBundleSchema, stale: z.literal(false).optional() }
const stale = { ...envelope, stale: z.literal(true) }
function checkProfiles(rows: Array<{ userId: string }>, resources: CommunityResourceBundle, ctx: z.RefinementCtx) {
  if (rows.some(row => !resources.profiles.some(profile => profile.id === row.userId))) {
    ctx.addIssue({ code: "custom", message: "Friend profile resource missing" })
  }
}
export const CommunityAcceptedFriendsReadSchema = z.union([
  z.strictObject({ ...fresh, friends: z.array(CommunityAcceptedFriendDescriptorSchema) }).superRefine((value, ctx) => checkProfiles(value.friends, value.resources, ctx)),
  z.strictObject({ ...stale, friends: z.array(CommunityAcceptedFriendDescriptorSchema).length(0) }),
])
export const CommunityBlockedFriendsReadSchema = z.union([
  z.strictObject({ ...fresh, blocked: z.array(CommunityBlockedFriendDescriptorSchema) }).superRefine((value, ctx) => checkProfiles(value.blocked, value.resources, ctx)),
  z.strictObject({ ...stale, blocked: z.array(CommunityBlockedFriendDescriptorSchema).length(0) }),
])
export const CommunityPendingFriendsReadSchema = z.union([
  z.strictObject({ ...fresh, pending: z.array(CommunityPendingFriendDescriptorSchema) }).superRefine((value, ctx) => checkProfiles(value.pending, value.resources, ctx)),
  z.strictObject({ ...stale, pending: z.array(CommunityPendingFriendDescriptorSchema).length(0) }),
])
export type CommunityAcceptedFriendsRead = z.infer<typeof CommunityAcceptedFriendsReadSchema>
export type CommunityBlockedFriendsRead = z.infer<typeof CommunityBlockedFriendsReadSchema>
export type CommunityPendingFriendsRead = z.infer<typeof CommunityPendingFriendsReadSchema>
