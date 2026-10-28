import { z } from "zod"
import { serverRailEntrySchema } from "./community-server-rail"
import { AttentionScopeSchema, AttentionItemSchema } from "./community-attention"
import { CommunityServerMembershipResourceSchema, CommunityServerResourceSchema, CommunityCategoryResourceSchema, CommunityChannelResourceSchema, CommunityMessageResourceSchema, CommunityReadStateResourceSchema, CommunityChannelMembershipResourceSchema, CommunityResourceProfileSchema } from "./community-resources"

const nullableString = z.string().nullable()
const optionalNullableString = nullableString.optional()

export const serverSchema = CommunityServerResourceSchema
export const categorySchema = CommunityCategoryResourceSchema.extend({ pending: z.boolean() })

export const channelLocalSchema = z.strictObject({
  muted: z.boolean(),
  tags: z.array(z.string()),
  pending: z.boolean(),
  openerSeq: z.number().int().nonnegative().optional(),
  openerUnread: z.boolean().optional(),
  preview: z.string().optional(),
  firstMessageId: z.string().min(1).nullable().optional(),
  participantCount: z.number().int().nonnegative().optional(),
})

export const channelSchema = CommunityChannelResourceSchema.extend(channelLocalSchema.shape)

export const serverMembershipSchema = CommunityServerMembershipResourceSchema.extend({
  id: z.string().min(1), nickname: optionalNullableString, joinedAt: z.string().optional(), viewer: z.boolean(),
})

export const channelMembershipSchema = CommunityChannelMembershipResourceSchema.extend({ id: z.string().min(1) })

export const profileSchema = CommunityResourceProfileSchema
export const messageSchema = CommunityMessageResourceSchema

export const readStateSchema = CommunityReadStateResourceSchema.extend({ observedRevision: z.number().int().nonnegative().optional() })

export const friendshipSchema = z.strictObject({
  id: z.string().min(1),
  userId: z.string().min(1),
  kind: z.enum(["accepted", "incoming", "outgoing", "blocked"]),
  sub: z.string().optional(),
  needsOwnerApproval: optionalNullableString,
})

export const readStateClockSchema = z.strictObject({
  id: z.literal("account"),
  revision: z.number().int().nonnegative(),
})

export const folderSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
})

export const serverRailSchema = z.strictObject({
  id: z.literal("account"),
  entries: z.array(serverRailEntrySchema),
})

export const folderItemSchema = z.strictObject({
  id: z.string().min(1),
  folderId: z.string().min(1),
  serverId: z.string().min(1),
  position: z.number(),
})

export const notificationSettingSchema = z.strictObject({
  id: z.string().min(1),
  serverId: optionalNullableString,
  channelId: optionalNullableString,
  level: z.string(),
}).superRefine((row, ctx) => {
  if (Boolean(row.serverId) === Boolean(row.channelId)) {
    ctx.addIssue({
      code: "custom",
      message: "notification setting requires exactly one target",
    })
  }
})

export const communityCollectionSchemas = {
  servers: serverSchema,
  categories: categorySchema,
  channels: channelSchema,
  serverMemberships: serverMembershipSchema,
  channelMemberships: channelMembershipSchema,
  profiles: profileSchema,
  messages: messageSchema,
  friendships: friendshipSchema,
  readStates: readStateSchema,
  readStateClock: readStateClockSchema,
  attentionScopes: AttentionScopeSchema,
  attentionItems: AttentionItemSchema,
  serverRail: serverRailSchema,
  folders: folderSchema,
  folderItems: folderItemSchema,
  notificationSettings: notificationSettingSchema,
} as const

export type CommunityCollectionName = keyof typeof communityCollectionSchemas
export type CommunityCollectionRows = { [N in CommunityCollectionName]: z.output<typeof communityCollectionSchemas[N]> }
export type ServerRow = z.infer<typeof serverSchema>
export type CategoryRow = z.infer<typeof categorySchema>
export type ChannelRow = z.infer<typeof channelSchema>
export type ServerMembershipRow = z.infer<typeof serverMembershipSchema>
export type ChannelMembershipRow = z.infer<typeof channelMembershipSchema>
export type ProfileRow = z.infer<typeof profileSchema>
export type MessageRow = z.infer<typeof messageSchema>
export type FriendshipRow = z.infer<typeof friendshipSchema>
export type ReadStateRow = z.infer<typeof readStateSchema>
export type ReadStateClockRow = z.infer<typeof readStateClockSchema>
export type AttentionScopeRow = z.infer<typeof AttentionScopeSchema>
export type AttentionItemRow = z.infer<typeof AttentionItemSchema>
export type FolderRow = z.infer<typeof folderSchema>
export type FolderItemRow = z.infer<typeof folderItemSchema>
export type NotificationSettingRow = z.infer<typeof notificationSettingSchema>
