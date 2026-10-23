import { z } from "zod"
import { PARTICIPANT_SOURCE } from "@alook/shared/constants/community"
import { serverRailEntrySchema, AttentionScopeSchema, AttentionItemSchema, CommunityChannelResourceSchema, CommunityMessageResourceSchema, CommunityMessagePreviewSchema, CommunityReadStateResourceSchema, CommunityMemberRelationSchema, CommunityResourceProfileSchema } from "@alook/shared"

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

export const channelLocalSchema = z.object({
  muted: z.boolean(),
  unread: z.boolean(),
  /** Forum channel's own unread bit, excluding participating child rows. */
  baseUnread: z.boolean().optional(),
  tags: z.array(z.string()),
  pending: z.boolean(),
  openerSeq: z.number().int().nonnegative().optional(),
  openerUnread: z.boolean().optional(),
  preview: z.string().optional(),
  firstMessageId: z.string().min(1).nullable().optional(),
  lastUnreadSeq: z.number().int().nonnegative().optional(),
  participantCount: z.number().int().nonnegative().optional(),
})

export const channelSchema = z.discriminatedUnion("resourceComplete", [
  CommunityChannelResourceSchema.strip().extend({
    ...channelLocalSchema.shape,
    resourceComplete: z.literal(true),
  }),
  CommunityChannelResourceSchema.partial({
    serverId: true, categoryId: true, parentChannelId: true, parentMessageId: true,
    creatorId: true, lastMessageAt: true, createdAt: true, messageCount: true, topic: true,
  }).strip().extend({
    ...channelLocalSchema.shape,
    resourceComplete: z.literal(false).default(false),
  }),
])

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

export const channelMembershipSchema = CommunityMemberRelationSchema.strip().partial({
  source: true, isCreator: true, role: true, memberId: true,
}).extend({
  id: z.string().min(1),
  source: z.enum(["explicit", "inherited", "admin", PARTICIPANT_SOURCE.MENTION, PARTICIPANT_SOURCE.SPOKE, PARTICIPANT_SOURCE.ADDED]).optional(),
})

const incompleteProfileSchema = CommunityResourceProfileSchema.partial().required({ id: true }).strip().extend({
  identityComplete: z.literal(false),
})

export const profileSchema = z.discriminatedUnion("identityComplete", [
  CommunityResourceProfileSchema.strip().extend({
    discriminator: CommunityResourceProfileSchema.shape.discriminator.unwrap(),
    identityComplete: z.literal(true),
  }),
  incompleteProfileSchema,
])

export const messageSchema = z.discriminatedUnion("resourceComplete", [
  CommunityMessageResourceSchema.strip().extend({ resourceComplete: z.literal(true) }),
  CommunityMessagePreviewSchema.strip().required({ channelId: true }).extend({
    resourceComplete: z.literal(false).default(false),
  }),
])

export const readStateSchema = CommunityReadStateResourceSchema.strip().extend({ observedRevision: z.number().int().nonnegative().optional() })

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

export const folderSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
})

export const serverRailSchema = z.object({
  id: z.literal("account"),
  entries: z.array(serverRailEntrySchema),
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

export function canonicalChannelRow(
  input: Pick<ChannelRow, "id" | "type"> & Partial<Omit<ChannelRow, "id" | "type" | "name">> & { name?: string | null },
  previous?: ChannelRow,
): ChannelRow {
  if (input.resourceComplete === true) CommunityChannelResourceSchema.strip().parse(input)
  const fields = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
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
    ...fields,
    name: input.name === undefined ? previous?.name ?? null : input.name,
    resourceComplete: input.resourceComplete === true || previous?.resourceComplete === true,
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
