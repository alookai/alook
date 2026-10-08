import { z } from "zod"
import { CommunityChannelResourceSchema, CommunityMessageResourceSchema, CommunityReadStateResourceSchema, CommunityMemberRelationSchema, CommunityResourceProfileSchema } from "@alook/shared"
import { PARTICIPANT_SOURCE } from "@alook/shared/constants/community"

const nullableString = z.string().nullable()
const optionalNullableString = nullableString.optional()

export const serverSchema = z.object({
  id: z.string().min(1),
  // Optional only for v2 rows written before canonical rail ordering landed.
  // Registry restore migrates those rows from their persisted array order.
  position: z.number().int().nonnegative().optional(),
  name: z.string(),
  discriminator: z.string(),
  description: z.string(),
  ownerId: z.string(),
  icon: nullableString,
  official: z.boolean(),
  isOwner: z.boolean(),
  unread: z.boolean(),
  mentions: z.number().int().nonnegative(),
  detailComplete: z.boolean().default(false),
})

export const categorySchema = z.object({
  id: z.string().min(1),
  serverId: z.string().min(1),
  name: z.string(),
  position: z.number(),
  private: z.boolean(),
  creatorId: optionalNullableString,
  pending: z.boolean(),
})

export const channelSchema = CommunityChannelResourceSchema.pick({
  id: true, serverId: true, categoryId: true, type: true, parentChannelId: true,
  parentMessageId: true, creatorId: true, position: true, archived: true,
  lastMessageAt: true, createdAt: true, messageCount: true,
}).strip().partial({
  serverId: true, categoryId: true, parentChannelId: true, parentMessageId: true,
  creatorId: true, lastMessageAt: true, createdAt: true, messageCount: true,
}).extend({
  name: CommunityChannelResourceSchema.shape.name.unwrap(),
  muted: z.boolean(),
  unread: z.boolean(),
  /** Forum channel's own unread bit, excluding participating child rows. */
  baseUnread: z.boolean().optional(),
  tags: z.array(z.string()),
  pending: z.boolean(),
  openerSeq: z.number().int().nonnegative().optional(),
  openerUnread: z.boolean().optional(),
  preview: z.string().optional(),
  lastUnreadSeq: z.number().int().nonnegative().optional(),
  participantCount: z.number().int().nonnegative().optional(),
})

export const serverMembershipSchema = z.object({
  id: z.string().min(1),
  serverId: z.string().min(1),
  userId: z.string().min(1),
  memberId: z.string().optional(),
  role: z.string(),
  nickname: optionalNullableString,
  joinedAt: z.string().optional(),
  viewer: z.boolean(),
})

export const channelMembershipSchema = CommunityMemberRelationSchema.pick({
  channelId: true, userId: true, relation: true, isCreator: true,
}).strip().partial({ isCreator: true }).extend({
  id: z.string().min(1),
  memberId: z.string().optional(),
  source: z.enum([
    "explicit",
    "inherited",
    "admin",
    PARTICIPANT_SOURCE.MENTION,
    PARTICIPANT_SOURCE.SPOKE,
    PARTICIPANT_SOURCE.ADDED,
  ]).optional(),
})

export const profileSchema = CommunityResourceProfileSchema.omit({ id: true }).strip().extend({
  userId: CommunityResourceProfileSchema.shape.id,
  discriminator: CommunityResourceProfileSchema.shape.discriminator.unwrap(),
  avatar: CommunityResourceProfileSchema.shape.avatar.unwrap(),
  aboutMe: z.string().optional(),
  bannerColor: optionalNullableString,
  kind: z.enum(["human", "bot"]).optional(),
  ownerUserId: optionalNullableString,
  ownerHandle: optionalNullableString,
  mutualServers: z.number().int().nonnegative().optional(),
  ownedByViewer: z.boolean().optional(),
  statusEmoji: CommunityResourceProfileSchema.shape.statusEmoji.optional(),
  statusText: CommunityResourceProfileSchema.shape.statusText.nullable().optional(),
})

export const messageSchema = CommunityMessageResourceSchema.pick({
  id: true, channelId: true, type: true, systemKind: true, authorId: true, authorName: true,
  authorAvatar: true, authorAvatarVersion: true, seq: true, createdAt: true, content: true,
}).partial({ authorId: true, seq: true, createdAt: true, content: true }).extend({
  clientNonce: z.string().optional(),
  failed: z.boolean().optional(),
  replyToId: z.string().nullable().optional(),
}).loose()

export const readStateSchema = CommunityReadStateResourceSchema.strip()

export const friendshipSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  kind: z.enum(["accepted", "incoming", "outgoing", "blocked"]),
  sub: z.string().optional(),
  needsOwnerApproval: optionalNullableString,
})

export const readStateClockSchema = z.object({
  id: z.literal("account"),
  revision: z.number().int().nonnegative(),
})

export const attentionScopeSchema = z.strictObject({
  scopeId: z.string().min(1),
  channelId: z.string().min(1),
  serverId: optionalNullableString,
  parentChannelId: optionalNullableString,
  ordinaryUnread: z.boolean(),
  lastUnreadSeq: z.number().int().nonnegative(),
  lastAttentionSeq: z.number().int().nonnegative().nullable().optional(),
  attentionCount: z.number().int().nonnegative(),
})

export const attentionItemSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["mention", "reply", "friend_request", "forum_post"]),
  sourceId: z.string().min(1),
  scopeId: optionalNullableString,
  messageId: optionalNullableString,
  actorUserId: optionalNullableString,
  createdAt: z.string(),
  childChannelId: z.string().min(1).optional(),
  openerSeq: z.number().int().nonnegative().optional(),
  readTarget: z.strictObject({
    channelId: z.string().min(1),
    seq: z.number().int().nonnegative(),
  }).optional(),
})

export const folderSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  position: z.number(),
})

export const folderItemSchema = z.object({
  id: z.string().min(1),
  folderId: z.string().min(1),
  serverId: z.string().min(1),
  position: z.number(),
})

export const notificationSettingSchema = z.object({
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
  attentionScopes: attentionScopeSchema,
  attentionItems: attentionItemSchema,
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
export type AttentionScopeRow = z.infer<typeof attentionScopeSchema>
export type AttentionItemRow = z.infer<typeof attentionItemSchema>
export type FolderRow = z.infer<typeof folderSchema>
export type FolderItemRow = z.infer<typeof folderItemSchema>
export type NotificationSettingRow = z.infer<typeof notificationSettingSchema>

export function canonicalChannelRow(
  input: Pick<ChannelRow, "id" | "type"> & Partial<Omit<ChannelRow, "id" | "type" | "name">> & { name?: string | null },
  previous?: ChannelRow,
): ChannelRow {
  return channelSchema.parse({
    serverId: null,
    categoryId: null,
    parentChannelId: null,
    parentMessageId: null,
    creatorId: null,
    position: 0,
    archived: false,
    muted: false,
    unread: false,
    tags: [],
    pending: false,
    lastMessageAt: null,
    ...previous,
    ...input,
    name: input.name === undefined ? previous?.name ?? "" : input.name ?? "",
  })
}

export function serverMembershipKey(serverId: string, userId: string) {
  return `${serverId}:${userId}`
}

export function channelMembershipKey(
  channelId: string,
  userId: string,
  relation: ChannelMembershipRow["relation"],
) {
  return `${channelId}:${userId}:${relation}`
}

export function canonicalChannelMembershipRow(
  channelId: string,
  userId: string,
  relation: ChannelMembershipRow["relation"],
  fields?: Omit<ChannelMembershipRow, "id" | "channelId" | "userId" | "relation">,
): ChannelMembershipRow {
  return { ...fields, id: channelMembershipKey(channelId, userId, relation), channelId, userId, relation }
}

export function folderItemKey(folderId: string, serverId: string) {
  return `${folderId}:${serverId}`
}

export function notificationSettingKey(
  row: Pick<NotificationSettingRow, "serverId" | "channelId">,
) {
  if (row.channelId) return `channel:${row.channelId}`
  if (row.serverId) return `server:${row.serverId}`
  throw new Error("notification setting target missing")
}
