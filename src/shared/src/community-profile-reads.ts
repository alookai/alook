import { z } from "zod"
import { CommunityResourceProfileSchema, CommunityServerMembershipResourceSchema } from "./community-resources"
import { ROLES } from "./utils/community-roles"

export const CommunitySelfProfileReadSchema = CommunityResourceProfileSchema.pick({
  id: true, name: true, discriminator: true, avatar: true, avatarVersion: true,
  aboutMe: true, bannerColor: true, statusEmoji: true, statusText: true,
}).required()

export function parseCommunitySelfProfileRead(value: unknown, viewerId: string) {
  const profile = CommunitySelfProfileReadSchema.parse(value)
  if (profile.id !== viewerId) throw new Error("Self profile viewer mismatch")
  return profile
}

const card = CommunitySelfProfileReadSchema.omit({ avatar: true }).extend({
  image: CommunityResourceProfileSchema.shape.avatar,
  mutualServers: CommunityResourceProfileSchema.shape.mutualServers.unwrap(),
})
export const CommunityUserCardReadSchema = z.discriminatedUnion("kind", [
  card.extend({ kind: z.literal("human") }),
  card.extend({ kind: z.literal("bot"), ownerProfile: z.strictObject({ id: CommunityResourceProfileSchema.shape.id, handle: CommunityResourceProfileSchema.shape.ownerHandle.unwrap().unwrap() }), ownedByViewer: CommunityResourceProfileSchema.shape.ownedByViewer.unwrap() }),
])

export function parseCommunityUserCardRead(value: unknown, userId: string, viewerId: string) {
  const profile = CommunityUserCardReadSchema.parse(value)
  if (profile.id !== userId || (profile.kind === "bot" && profile.ownedByViewer !== (profile.ownerProfile.id === viewerId))) throw new Error("User card request scope mismatch")
  return profile
}
export type CommunityUserCardRead = z.infer<typeof CommunityUserCardReadSchema>

export const CommunityServerMemberReadSchema = CommunityResourceProfileSchema.pick({ name: true, discriminator: true, avatar: true, avatarVersion: true, statusEmoji: true, statusText: true }).required().extend({
  id: CommunityServerMembershipResourceSchema.shape.memberId,
  userId: CommunityResourceProfileSchema.shape.id,
  role: z.enum(ROLES),
  status: z.enum(["online", "offline"]),
  sub: z.string(),
  isBot: z.literal(true).optional(),
  ownerUserId: CommunityResourceProfileSchema.shape.id.optional(),
}).superRefine((row, ctx) => {
  if ((row.isBot === true) !== (row.ownerUserId !== undefined)) ctx.addIssue({ code: "custom", message: "Member owner metadata mismatch" })
})
const page = z.strictObject({
  viewerId: CommunityResourceProfileSchema.shape.id,
  serverId: CommunityServerMembershipResourceSchema.shape.serverId,
  members: z.array(CommunityServerMemberReadSchema),
  hasMore: z.boolean(), cursor: z.string().min(1).optional(), limit: z.number().int().positive(),
})
const validatePage = (value: z.infer<typeof page>, ctx: z.RefinementCtx) => {
  if ((value.hasMore && !value.cursor) || new Set(value.members.map(row => row.id)).size !== value.members.length
    || new Set(value.members.map(row => row.userId)).size !== value.members.length || value.members.length > value.limit
    || value.members.some(row => row.ownerUserId !== undefined && row.ownerUserId !== value.viewerId)) ctx.addIssue({ code: "custom", message: "Member page scope mismatch" })
}
export const CommunityServerMembersReadSchema = page.extend({ total: z.number().int().nonnegative() }).superRefine(validatePage)
export const CommunityServerMemberSearchReadSchema = page.superRefine(validatePage)

export function parseCommunityServerMembersRead(value: unknown, serverId: string, viewerId: string, search: boolean): z.infer<typeof page> & { total?: number } {
  const result = (search ? CommunityServerMemberSearchReadSchema : CommunityServerMembersReadSchema).parse(value)
  if (result.serverId !== serverId || result.viewerId !== viewerId) throw new Error("Member page request scope mismatch")
  return result
}

export const CommunityUserSearchReadSchema = z.strictObject({ users: z.array(CommunityResourceProfileSchema.pick({ id: true, name: true, discriminator: true, avatarVersion: true }).extend({ image: CommunityResourceProfileSchema.shape.avatar })) })

export type CommunityUserSearchRead = z.infer<typeof CommunityUserSearchReadSchema>

export type CommunitySelfProfileRead = z.infer<typeof CommunitySelfProfileReadSchema>

export const CommunityReactionActorProfileSchema = CommunityResourceProfileSchema.pick({ id: true, name: true, discriminator: true, avatar: true, avatarVersion: true })
export const CommunityReactionDetailsReadSchema = z.strictObject({
  messageId: CommunityResourceProfileSchema.shape.id,
  scope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("server"), serverId: CommunityServerMembershipResourceSchema.shape.serverId, channelId: CommunityResourceProfileSchema.shape.id }),
    z.strictObject({ kind: z.literal("dm"), channelId: CommunityResourceProfileSchema.shape.id }),
  ]),
  actors: z.array(z.strictObject({ userId: CommunityResourceProfileSchema.shape.id, profile: CommunityReactionActorProfileSchema.nullable() })),
}).superRefine((value, ctx) => {
  if (new Set(value.actors.map(row => row.userId)).size !== value.actors.length || value.actors.some(row => row.profile && row.profile.id !== row.userId)) ctx.addIssue({ code: "custom", message: "Reaction actor identity mismatch" })
})
export type CommunityReactionDetailsRead = z.infer<typeof CommunityReactionDetailsReadSchema>
export type CommunityReactionActorProfile = z.infer<typeof CommunityReactionActorProfileSchema>
export function parseCommunityReactionDetailsRead(value: unknown, messageId: string, scope: CommunityReactionDetailsRead["scope"]) {
  const result = CommunityReactionDetailsReadSchema.parse(value)
  if (result.messageId !== messageId || result.scope.kind !== scope.kind || result.scope.channelId !== scope.channelId
    || (result.scope.kind === "server" && scope.kind === "server" && result.scope.serverId !== scope.serverId)) throw new Error("Reaction message request scope mismatch")
  return result
}

export const CommunityBotProfileSummarySchema = CommunityResourceProfileSchema.pick({ id: true, name: true, avatarVersion: true }).extend({
  image: CommunityResourceProfileSchema.shape.avatar,
  discriminator: CommunityResourceProfileSchema.shape.discriminator.optional(),
  description: CommunityResourceProfileSchema.shape.aboutMe,
  presence: z.enum(["online", "offline"]).optional(),
}).strip()

export const CommunityBotsProfileReadSchema = z.object({
  bots: z.array(CommunityBotProfileSummarySchema.required({ discriminator: true, description: true, presence: true }).extend({ ownerUserId: CommunityResourceProfileSchema.shape.id })),
}).strip().superRefine((value, ctx) => {
  if (new Set(value.bots.map(row => row.id)).size !== value.bots.length) ctx.addIssue({ code: "custom", message: "Duplicate bot catalogue identity" })
})
export type CommunityBotsProfileRead = z.infer<typeof CommunityBotsProfileReadSchema>
export function parseCommunityBotsProfileRead(value: unknown, viewerId: string) {
  const result = CommunityBotsProfileReadSchema.parse(value)
  if (result.bots.some(row => row.ownerUserId !== viewerId)) throw new Error("Bot catalogue owner mismatch")
  return result
}
