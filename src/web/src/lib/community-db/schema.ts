import { z } from "zod"

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

export const channelSchema = z.object({
  id: z.string().min(1),
  serverId: optionalNullableString,
  categoryId: optionalNullableString,
  name: z.string(),
  type: z.enum(["text", "forum", "thread", "dm"]),
  parentChannelId: optionalNullableString,
  parentMessageId: optionalNullableString,
  creatorId: optionalNullableString,
  position: z.number(),
  archived: z.boolean(),
  muted: z.boolean(),
  unread: z.boolean(),
  /** Forum channel's own unread bit, excluding participating child rows. */
  baseUnread: z.boolean().optional(),
  tags: z.array(z.string()),
  pending: z.boolean(),
  lastMessageAt: optionalNullableString,
  preview: z.string().optional(),
  lastUnreadSeq: z.number().int().nonnegative().optional(),
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

export const channelMembershipSchema = z.object({
  id: z.string().min(1),
  channelId: z.string().min(1),
  userId: z.string().min(1),
  relation: z.enum(["access", "notify"]),
  memberId: z.string().optional(),
  source: z.enum(["explicit", "inherited", "admin"]).optional(),
  isCreator: z.boolean().optional(),
})

export const profileSchema = z.object({
  userId: z.string().min(1),
  name: z.string(),
  discriminator: z.string(),
  avatar: z.string(),
  avatarVersion: z.number().int().nonnegative(),
  aboutMe: z.string().optional(),
  bannerColor: optionalNullableString,
  kind: z.enum(["human", "bot"]).optional(),
  ownerUserId: optionalNullableString,
  statusEmoji: optionalNullableString,
  statusText: optionalNullableString,
})

export const messageSchema = z.object({
  id: z.string().min(1),
  channelId: z.string().min(1),
  type: z.enum(["chat", "system"]),
  systemKind: z.literal("thread").optional(),
  authorId: z.string().optional(),
  authorName: z.string().optional(),
  authorAvatar: z.string().optional(),
  authorAvatarVersion: z.number().int().nonnegative().optional(),
  seq: z.number().int().nonnegative().optional(),
  createdAt: z.string().optional(),
  clientNonce: z.string().optional(),
  content: z.string().optional(),
  failed: z.boolean().optional(),
  replyToId: z.string().optional(),
}).passthrough()

export const readStateSchema = z.object({
  channelId: z.string().min(1),
  lastReadMessageId: nullableString,
  lastReadAt: z.string(),
  lastReadSeq: z.number().int().nonnegative(),
})

export const readStateClockSchema = z.object({
  id: z.literal("account"),
  revision: z.number().int().nonnegative(),
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
  readStates: readStateSchema,
  readStateClock: readStateClockSchema,
  folders: folderSchema,
  folderItems: folderItemSchema,
  notificationSettings: notificationSettingSchema,
} as const

export type CommunityCollectionName = keyof typeof communityCollectionSchemas
export type ServerRow = z.infer<typeof serverSchema>
export type CategoryRow = z.infer<typeof categorySchema>
export type ChannelRow = z.infer<typeof channelSchema>
export type ServerMembershipRow = z.infer<typeof serverMembershipSchema>
export type ChannelMembershipRow = z.infer<typeof channelMembershipSchema>
export type ProfileRow = z.infer<typeof profileSchema>
export type MessageRow = z.infer<typeof messageSchema>
export type ReadStateRow = z.infer<typeof readStateSchema>
export type ReadStateClockRow = z.infer<typeof readStateClockSchema>
export type FolderRow = z.infer<typeof folderSchema>
export type FolderItemRow = z.infer<typeof folderItemSchema>
export type NotificationSettingRow = z.infer<typeof notificationSettingSchema>

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
