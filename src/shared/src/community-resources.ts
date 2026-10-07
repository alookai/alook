import { z } from "zod"
import { FriendApprovalPayloadSchema } from "./community-ws-events"

const id = z.string().min(1)
const nullableId = id.nullable()

export const CommunityChannelResourceSchema = z.strictObject({
  id,
  type: z.enum(["text", "forum", "thread", "dm"]),
  serverId: nullableId,
  categoryId: nullableId,
  name: z.string().nullable(),
  topic: z.string(),
  parentChannelId: nullableId,
  parentMessageId: nullableId,
  creatorId: nullableId,
  position: z.number(),
  archived: z.boolean(),
  createdAt: z.string(),
  lastMessageAt: z.string().nullable(),
  messageCount: z.number().int().nonnegative(),
})

export const CommunityAccessDecisionSchema = z.strictObject({
  channelId: id,
  canRead: z.boolean(),
  canSend: z.boolean(),
  canCreateDiscussion: z.boolean(),
})

export const CommunityMessageAttachmentSchema = z.strictObject({
  kind: z.enum(["image", "file"]),
  name: z.string(),
  url: z.string(),
  thumbnailUrl: z.string().optional(),
  contentType: z.string().optional(),
  size: z.string().optional(),
  sizeBytes: z.number().nonnegative().optional(),
  width: z.number().nonnegative().optional(),
  height: z.number().nonnegative().optional(),
})

export const CommunityMessageResourceSchema = z.strictObject({
  id,
  channelId: id,
  seq: z.number().int().nonnegative(),
  authorId: id,
  createdAt: z.string(),
  type: z.enum(["chat", "system"]),
  content: z.string(),
  replyToId: nullableId,
  clientNonce: z.string().nullable(),
  attachments: z.array(CommunityMessageAttachmentSchema),
  systemKind: z.literal("thread").optional(),
  authorName: z.string().optional(),
  authorAvatar: z.string().optional(),
  authorAvatarVersion: z.number().int().nonnegative().optional(),
  mentionType: z.literal("everyone").nullable().optional(),
  replyTo: z.strictObject({
    id,
    authorId: id.optional(),
    authorName: z.string(),
    text: z.string(),
    deleted: z.boolean().optional(),
  }).optional(),
  embeds: z.array(z.unknown()).optional(),
  reactions: z.array(z.strictObject({
    emoji: z.string(),
    count: z.number().int().nonnegative(),
    me: z.boolean(),
    userIds: z.array(id),
  })).optional(),
  thread: z.strictObject({
    id,
    name: z.string(),
    messageCount: z.number().int().nonnegative(),
    lastReplyAt: z.string().optional(),
    tags: z.array(z.string()).optional(),
    preview: z.string().optional(),
    participants: z.array(z.strictObject({ id, name: z.string(), avatar: z.string(), avatarVersion: z.number().int().nonnegative() })).optional(),
    participantCount: z.number().int().nonnegative().optional(),
  }).optional(),
  approval: FriendApprovalPayloadSchema.optional(),
})

export const CommunityReadStateResourceSchema = z.strictObject({
  channelId: id,
  lastReadMessageId: nullableId,
  lastReadAt: z.string().nullable(),
  lastReadSeq: z.number().int().nonnegative(),
})

export const CommunityMemberRelationSchema = z.strictObject({
  channelId: id,
  userId: id,
  relation: z.enum(["access", "notify"]),
  source: z.string(),
  isCreator: z.boolean(),
  role: z.string().nullable(),
  memberId: nullableId,
})

export const CommunityResourceProfileSchema = z.strictObject({
  id,
  name: z.string(),
  discriminator: z.string().nullable(),
  avatar: z.string().nullable(),
  avatarVersion: z.number().int().nonnegative(),
  statusEmoji: z.string().nullable(),
  statusText: z.string(),
})

export const CommunityPageSchema = z.strictObject({
  olderCursor: z.string().nullable(),
  newerCursor: z.string().nullable(),
  hasMoreOlder: z.boolean(),
  hasMoreNewer: z.boolean(),
  latestSeq: z.number().int().nonnegative(),
})

const envelope = { contractVersion: z.literal(2), channelId: id }
export const CommunityChannelReadSchema = z.strictObject({ ...envelope, channel: CommunityChannelResourceSchema, access: CommunityAccessDecisionSchema })
export const CommunityMessagesReadSchema = z.strictObject({ ...envelope, messages: z.array(CommunityMessageResourceSchema), page: CommunityPageSchema,
  surfaceReceipt: z.strictObject({ channelId: id, surfaceKind: z.enum(["channel", "forum", "thread", "dm"]) }) })
export const CommunityReadStateReadSchema = z.strictObject({ ...envelope, readState: CommunityReadStateResourceSchema })
export const CommunityMembersReadSchema = z.strictObject({ ...envelope, relation: z.enum(["access", "notify"]), members: z.array(CommunityMemberRelationSchema), profiles: z.array(CommunityResourceProfileSchema) })
export const CommunityThreadsReadSchema = z.strictObject({ ...envelope, channel: CommunityChannelResourceSchema,
  threads: z.array(CommunityChannelResourceSchema),
  included: z.strictObject({ messages: z.array(CommunityMessageResourceSchema), members: z.array(CommunityMemberRelationSchema), profiles: z.array(CommunityResourceProfileSchema),
    tags: z.array(z.strictObject({ messageId: id, tag: z.string() })),
    participantCounts: z.array(z.strictObject({ channelId: id, count: z.number().int().nonnegative() })) }),
  page: z.strictObject({ nextCursor: z.string().nullable(), hasMore: z.boolean() }) })
export const CommunityReadAdvanceSchema = z.strictObject({ ...envelope, changed: z.boolean(), targetSeq: z.number().int().nonnegative(), revision: z.number().int().nonnegative() })
export const CommunityReadErrorSchema = z.strictObject({ contractVersion: z.literal(2), error: z.strictObject({
  code: z.enum(["invalid_input", "invalid_reply_target", "unauthenticated", "not_found", "not_allowed", "blocked", "idempotency_conflict", "rate_limited", "temporarily_unavailable"]),
  message: z.string(), retryable: z.boolean(),
}) })

export type CommunityChannelResource = z.infer<typeof CommunityChannelResourceSchema>
export type CommunityMessageResource = z.infer<typeof CommunityMessageResourceSchema>
export type CommunityMemberRelation = z.infer<typeof CommunityMemberRelationSchema>

export function normalizeCommunityChannelResource(value: unknown): CommunityChannelResource {
  const raw = z.object({
    ...CommunityChannelResourceSchema.shape,
    topic: z.string().nullable().optional(),
    position: z.number().nullable().optional(),
    messageCount: z.number().int().nonnegative().nullable().optional(),
    categoryId: nullableId.optional(),
    parentChannelId: nullableId.optional(),
    parentMessageId: nullableId.optional(),
    creatorId: nullableId.optional(),
    lastMessageAt: z.string().nullable().optional(),
    archived: z.union([z.boolean(), z.literal(0), z.literal(1)]),
  }).parse(value)
  return CommunityChannelResourceSchema.parse({ ...raw, topic: raw.topic ?? "", position: raw.position ?? 0,
    messageCount: raw.messageCount ?? 0, categoryId: raw.categoryId ?? null, parentChannelId: raw.parentChannelId ?? null,
    parentMessageId: raw.parentMessageId ?? null, creatorId: raw.creatorId ?? null, lastMessageAt: raw.lastMessageAt ?? null,
    archived: raw.archived === true || raw.archived === 1 })
}

export function normalizeCommunityMessageResource(value: unknown, channelId: string): CommunityMessageResource {
  const raw = z.object({
    ...CommunityMessageResourceSchema.shape,
    channelId: id.optional(),
    replyToId: nullableId.optional(),
    clientNonce: z.string().nullable().optional(),
    attachments: z.array(CommunityMessageAttachmentSchema).optional(),
    embeds: z.array(z.unknown()).nullable().optional(),
  }).parse(value)
  if (raw.channelId !== undefined && raw.channelId !== channelId) throw new Error("Message resource scope mismatch")
  return CommunityMessageResourceSchema.parse({ ...raw, channelId, replyToId: raw.replyToId ?? raw.replyTo?.id ?? null,
    clientNonce: raw.clientNonce ?? null, attachments: raw.attachments ?? [], embeds: raw.embeds ?? undefined })
}
