import { z } from "zod"
import { COMMUNITY_CONTRACT_VERSION } from "./community-contract"
import { FriendApprovalPayloadSchema } from "./community-friend-approval"

const id = z.string().min(1)
const nullableId = id.nullable()
const legacyArchivedSchema = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((value) => value === true || value === 1)

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

export const CommunityChannelIdentitySchema = CommunityChannelResourceSchema.pick({
  id: true, type: true, serverId: true, name: true, parentChannelId: true,
  parentMessageId: true, creatorId: true, archived: true, lastMessageAt: true, createdAt: true,
}).partial({ createdAt: true }).strip()

const legacyChannelIdentitySchema = CommunityChannelIdentitySchema.extend({
  archived: legacyArchivedSchema,
  parentChannelId: nullableId.default(null),
  parentMessageId: nullableId.default(null),
  creatorId: nullableId.default(null),
  lastMessageAt: CommunityChannelResourceSchema.shape.lastMessageAt.default(null),
})

export function normalizeCommunityChannelIdentity(value: unknown) {
  return legacyChannelIdentitySchema.parse(value)
}

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

const envelope = { contractVersion: z.literal(COMMUNITY_CONTRACT_VERSION), channelId: id }
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
export const CommunityReadErrorSchema = z.strictObject({ contractVersion: z.literal(COMMUNITY_CONTRACT_VERSION), error: z.strictObject({
  code: z.enum(["invalid_input", "invalid_reply_target", "unauthenticated", "not_found", "not_allowed", "blocked", "idempotency_conflict", "rate_limited", "temporarily_unavailable"]),
  message: z.string(), retryable: z.boolean(),
}) })

export type CommunityChannelResource = z.infer<typeof CommunityChannelResourceSchema>
export type CommunityChannelIdentity = z.infer<typeof CommunityChannelIdentitySchema>
export type CommunityMessageResource = z.infer<typeof CommunityMessageResourceSchema>
export type CommunityMemberRelation = z.infer<typeof CommunityMemberRelationSchema>
export type CommunityReadStateResource = z.infer<typeof CommunityReadStateResourceSchema>
export type CommunityAccessDecision = z.infer<typeof CommunityAccessDecisionSchema>
export type CommunityResourceProfile = z.infer<typeof CommunityResourceProfileSchema>
export type CommunityMessageAttachment = z.infer<typeof CommunityMessageAttachmentSchema>
export type CommunityMessagesRead = z.infer<typeof CommunityMessagesReadSchema>
export type CommunityThreadsRead = z.infer<typeof CommunityThreadsReadSchema>
export type CommunityMembersRead = z.infer<typeof CommunityMembersReadSchema>
export type CommunityMessageSurfaceReceipt = CommunityMessagesRead["surfaceReceipt"]

const legacyChannelResourceSchema = CommunityChannelResourceSchema.strip().extend({
  topic: CommunityChannelResourceSchema.shape.topic.nullish().transform((value) => value ?? ""),
  position: CommunityChannelResourceSchema.shape.position.nullish().transform((value) => value ?? 0),
  messageCount: CommunityChannelResourceSchema.shape.messageCount.nullish().transform((value) => value ?? 0),
  categoryId: nullableId.default(null),
  parentChannelId: nullableId.default(null),
  parentMessageId: nullableId.default(null),
  creatorId: nullableId.default(null),
  lastMessageAt: CommunityChannelResourceSchema.shape.lastMessageAt.default(null),
  archived: legacyArchivedSchema,
})

export function normalizeCommunityChannelResource(value: unknown): CommunityChannelResource {
  return legacyChannelResourceSchema.parse(value)
}

const legacyMessageResourceSchema = CommunityMessageResourceSchema.strip().extend({
  channelId: id.optional(),
  replyToId: nullableId.optional(),
  clientNonce: CommunityMessageResourceSchema.shape.clientNonce.default(null),
  attachments: CommunityMessageResourceSchema.shape.attachments.default([]),
  embeds: CommunityMessageResourceSchema.shape.embeds.nullable().transform((value) => value ?? undefined),
})

export function normalizeCommunityMessageResource(value: unknown, channelId: string): CommunityMessageResource {
  const raw = legacyMessageResourceSchema.parse(value)
  if (raw.channelId !== undefined && raw.channelId !== channelId) throw new Error("Message resource scope mismatch")
  return { ...raw, channelId: id.parse(channelId), replyToId: raw.replyToId ?? raw.replyTo?.id ?? null }
}
