import { z } from "zod"
import { COMMUNITY_RESOURCE_CONTRACT_VERSION } from "./community-contract"
import { FriendApprovalPayloadSchema } from "./community-friend-approval"

const id = z.string().min(1)
const nullableId = id.nullable()
export const COMMUNITY_CONVERSATION_ANCHOR_MISSING = "conversation_anchor_missing"
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

export const CommunityLegacyMessageAttachmentSchema = z.strictObject({
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


export const CommunityMessageAttachmentSchema = z.strictObject({
  id,
  name: z.string(),
  url: z.string(),
  thumbnailUrl: z.string().nullable(),
  contentType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  width: z.number().int().nonnegative().nullable(),
  height: z.number().int().nonnegative().nullable(),
})

export const CommunityMessagePreviewAttachmentSchema = CommunityMessageAttachmentSchema.partial().required({ name: true, url: true })

export const CommunityResourceProfileSchema = z.strictObject({
  id,
  name: z.string(),
  discriminator: z.string().min(1).nullable(),
  avatar: z.string().nullable(),
  avatarVersion: z.number().int().nonnegative(),
  aboutMe: z.string().optional(),
  bannerColor: z.string().nullable().optional(),
  kind: z.enum(["human", "bot"]).optional(),
  ownerUserId: nullableId.optional(),
  ownerHandle: z.string().nullable().optional(),
  mutualServers: z.number().int().nonnegative().optional(),
  ownedByViewer: z.boolean().optional(),
  statusEmoji: z.string().nullable().optional(),
  statusText: z.string().nullable().optional(),
})


export const CommunityMessageThreadParticipantSchema = CommunityResourceProfileSchema.pick({ id: true, name: true, avatar: true, avatarVersion: true })
const messageThreadSchema = z.strictObject({
  id,
  name: CommunityChannelResourceSchema.shape.name,
  messageCount: CommunityChannelResourceSchema.shape.messageCount,
  lastReplyAt: CommunityChannelResourceSchema.shape.lastMessageAt.optional(),
  tags: z.array(z.string()).optional(),
  preview: z.string().optional(),
  participants: z.array(CommunityMessageThreadParticipantSchema).optional(),
  participantCount: z.number().int().nonnegative().optional(),
})
const legacyMessageThreadSchema = messageThreadSchema.extend({
  name: z.string(),
  lastReplyAt: z.string().optional(),
  participants: z.array(CommunityMessageThreadParticipantSchema.extend({ avatar: z.string() })).optional(),
})
const messageThreadPreviewSchema = messageThreadSchema.partial().required({ id: true }).extend({
  participants: z.array(CommunityMessageThreadParticipantSchema.partial().required({ id: true })).optional(),
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
  authorAvatar: z.string().nullable().optional(),
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
  thread: messageThreadSchema.optional(),
  approval: FriendApprovalPayloadSchema.optional(),
})

export const CommunityMessagePreviewSchema = CommunityMessageResourceSchema.partial().required({
  id: true, type: true,
}).extend({ attachments: z.array(CommunityMessagePreviewAttachmentSchema).optional(), thread: messageThreadPreviewSchema.optional() })

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


export const CommunityPageSchema = z.strictObject({
  olderCursor: z.string().nullable(),
  newerCursor: z.string().nullable(),
  hasMoreOlder: z.boolean(),
  hasMoreNewer: z.boolean(),
  latestSeq: z.number().int().nonnegative(),
})

const envelope = { contractVersion: z.literal(COMMUNITY_RESOURCE_CONTRACT_VERSION), channelId: id }
export const CommunityChannelReadSchema = z.strictObject({ ...envelope, channel: CommunityChannelResourceSchema, access: CommunityAccessDecisionSchema })
export const CommunityMessagesReadSchema = z.strictObject({ ...envelope, messages: z.array(CommunityMessageResourceSchema), page: CommunityPageSchema,
  surfaceReceipt: z.strictObject({ channelId: id, surfaceKind: z.enum(["channel", "forum", "thread", "dm"]) }) })
export const CommunityConversationEntryReadSchema = CommunityMessagesReadSchema.extend({
  viewerId: id,
  peer: CommunityResourceProfileSchema.nullable(),
  channel: CommunityChannelResourceSchema,
  access: CommunityAccessDecisionSchema.extend({ canRead: z.literal(true) }),
  readState: CommunityReadStateResourceSchema,
  readStateRevision: z.number().int().nonnegative(),
  forumFeed: z.lazy(() => CommunityThreadsReadSchema).optional(),
  opener: CommunityMessageResourceSchema.optional(),
  parent: CommunityChannelResourceSchema.optional(),
  selection: z.strictObject({
    reason: z.enum(["explicit_anchor", "read_pointer", "tail", "read_pointer_missing"]),
    anchorMessageId: nullableId,
  }),
}).superRefine((entry, ctx) => {
  for (const [path, channelId] of [
    [["channel", "id"], entry.channel.id],
    [["access", "channelId"], entry.access.channelId],
    [["readState", "channelId"], entry.readState.channelId],
    [["surfaceReceipt", "channelId"], entry.surfaceReceipt.channelId],
    ...entry.messages.map((message, index) => [["messages", index, "channelId"], message.channelId] as const),
  ] as const) {
    if (channelId !== entry.channelId) ctx.addIssue({ code: "custom", path: [...path], message: "Conversation entry scope mismatch" })
  }
  if ((entry.channel.type === "dm") !== (entry.peer !== null) || entry.peer?.id === entry.viewerId) ctx.addIssue({ code: "custom", path: ["peer"], message: "Conversation entry peer mismatch" })
  if (entry.opener && (entry.channel.type !== "thread" || entry.opener.id !== entry.channel.parentMessageId || entry.opener.channelId !== entry.channel.parentChannelId)) ctx.addIssue({ code: "custom", path: ["opener"], message: "Conversation entry opener scope mismatch" })
  if (entry.parent && (entry.channel.type !== "thread" || entry.parent.id !== entry.channel.parentChannelId || entry.parent.serverId !== entry.channel.serverId || entry.parent.type !== "text" && entry.parent.type !== "forum")) ctx.addIssue({ code: "custom", path: ["parent"], message: "Conversation entry parent scope mismatch" })
  if (entry.forumFeed && (entry.channel.type !== "forum" || entry.forumFeed.channelId !== entry.channelId || entry.forumFeed.channel.id !== entry.channelId
    || entry.forumFeed.channel.serverId !== entry.channel.serverId || entry.forumFeed.threads.some(thread => thread.parentChannelId !== entry.channelId || thread.serverId !== entry.channel.serverId))) ctx.addIssue({ code: "custom", path: ["forumFeed"], message: "Conversation entry forum scope mismatch" })
  if (entry.forumFeed) {
    const feed = entry.forumFeed, children = new Set(feed.threads.map(thread => thread.id)), profiles = new Set(feed.included.profiles.map(profile => profile.id))
    const openers = new Set(feed.threads.flatMap(thread => thread.parentMessageId ? [thread.parentMessageId] : []))
    if (feed.included.messages.some(message => message.channelId !== entry.channelId && !children.has(message.channelId))
      || feed.included.tags.some(row => !openers.has(row.messageId)) || feed.included.participantCounts.some(row => !children.has(row.channelId))
      || feed.included.members.some(member => !children.has(member.channelId) || member.relation !== "notify" || !profiles.has(member.userId))) ctx.addIssue({ code: "custom", path: ["forumFeed", "included"], message: "Conversation entry forum included scope mismatch" })
  }
  const surfaceKind = entry.channel.type === "text" ? "channel" : entry.channel.type
  if (entry.surfaceReceipt.surfaceKind !== surfaceKind) ctx.addIssue({ code: "custom", path: ["surfaceReceipt", "surfaceKind"], message: "Conversation entry surface mismatch" })
  if (entry.channel.archived) ctx.addIssue({ code: "custom", path: ["channel", "archived"], message: "Conversation entry is archived" })
  const anchored = entry.selection.reason === "explicit_anchor" || entry.selection.reason === "read_pointer"
  if (anchored !== (entry.selection.anchorMessageId !== null)) ctx.addIssue({ code: "custom", path: ["selection"], message: "Conversation entry selection mismatch" })
  if (entry.selection.reason === "read_pointer" && entry.selection.anchorMessageId !== entry.readState.lastReadMessageId) ctx.addIssue({ code: "custom", path: ["selection", "anchorMessageId"], message: "Conversation entry read pointer mismatch" })
  if (entry.selection.reason === "read_pointer_missing" && entry.readState.lastReadMessageId === null) ctx.addIssue({ code: "custom", path: ["selection", "reason"], message: "Conversation entry missing read pointer" })
})
export const CommunityMessagePostedSchema = CommunityMessagesReadSchema.pick({ contractVersion: true, channelId: true }).extend({
  message: CommunityMessageResourceSchema, deduped: z.boolean(), threadId: id.optional(),
})
export const CommunityMessageReadSchema = CommunityMessagePostedSchema.omit({ deduped: true, threadId: true })
export const CommunityMembersReadSchema = z.strictObject({ ...envelope, relation: z.enum(["access", "notify"]), members: z.array(CommunityMemberRelationSchema), profiles: z.array(CommunityResourceProfileSchema) })
export const CommunityThreadsReadSchema = z.strictObject({ ...envelope, channel: CommunityChannelResourceSchema,
  threads: z.array(CommunityChannelResourceSchema),
  included: z.strictObject({ messages: z.array(CommunityMessageResourceSchema), members: z.array(CommunityMemberRelationSchema), profiles: z.array(CommunityResourceProfileSchema),
    tags: z.array(z.strictObject({ messageId: id, tag: z.string() })),
    participantCounts: z.array(z.strictObject({ channelId: id, count: z.number().int().nonnegative() })) }),
  page: z.strictObject({ nextCursor: z.string().nullable(), hasMore: z.boolean() }) })
export const CommunityReadAdvanceSchema = z.strictObject({ ...envelope, changed: z.boolean(), targetSeq: z.number().int().nonnegative(), revision: z.number().int().nonnegative() })
export const CommunityReadErrorSchema = z.strictObject({ contractVersion: z.literal(COMMUNITY_RESOURCE_CONTRACT_VERSION), error: z.strictObject({
  code: z.enum(["invalid_input", "invalid_reply_target", "unauthenticated", "not_found", "not_allowed", "blocked", "idempotency_conflict", "rate_limited", "temporarily_unavailable"]),
  message: z.string(), retryable: z.boolean(),
}) })

const legacyProfileSchema = CommunityResourceProfileSchema.pick({
  id: true, name: true, avatar: true, avatarVersion: true,
}).extend({ discriminator: z.string().nullable(), statusEmoji: z.string().nullable(), statusText: z.string() })
export const CommunityLegacyMessageResourceSchema = CommunityMessageResourceSchema.extend({ authorAvatar: z.string().optional(), attachments: z.array(CommunityLegacyMessageAttachmentSchema), thread: legacyMessageThreadSchema.optional() })
const legacyEnvelope = { contractVersion: z.literal(2), channelId: id }
const legacyReadSchemas = {
  channel: CommunityChannelReadSchema.extend(legacyEnvelope),
  messages: CommunityMessagesReadSchema.extend({ ...legacyEnvelope, messages: z.array(CommunityLegacyMessageResourceSchema) }),
  members: CommunityMembersReadSchema.extend({ ...legacyEnvelope, profiles: z.array(legacyProfileSchema) }),
  threads: CommunityThreadsReadSchema.extend({ ...legacyEnvelope, included: CommunityThreadsReadSchema.shape.included.extend({
    messages: z.array(CommunityLegacyMessageResourceSchema), profiles: z.array(legacyProfileSchema),
  }) }),
  readAdvance: CommunityReadAdvanceSchema.extend(legacyEnvelope),
  error: CommunityReadErrorSchema.extend({ contractVersion: z.literal(2) }),
}
const resourceReadSchemas = {
  channel: CommunityChannelReadSchema, messages: CommunityMessagesReadSchema,
  members: CommunityMembersReadSchema, threads: CommunityThreadsReadSchema, readAdvance: CommunityReadAdvanceSchema, error: CommunityReadErrorSchema,
}

export function communityReadSchemas(contract: 2): typeof legacyReadSchemas
export function communityReadSchemas(contract: 3): typeof resourceReadSchemas
export function communityReadSchemas(contract: 2 | 3): typeof legacyReadSchemas | typeof resourceReadSchemas
export function communityReadSchemas(contract: 2 | 3) {
  return contract === 2 ? legacyReadSchemas : resourceReadSchemas
}

export type CommunityChannelResource = z.infer<typeof CommunityChannelResourceSchema>
export type CommunityChannelIdentity = z.infer<typeof CommunityChannelIdentitySchema>
export type CommunityMessageResource = z.infer<typeof CommunityMessageResourceSchema>
export type CommunityMemberRelation = z.infer<typeof CommunityMemberRelationSchema>
export type CommunityReadStateResource = z.infer<typeof CommunityReadStateResourceSchema>
export type CommunityAccessDecision = z.infer<typeof CommunityAccessDecisionSchema>
export type CommunityResourceProfile = z.infer<typeof CommunityResourceProfileSchema>
export type CommunityMessageAttachment = z.infer<typeof CommunityMessageAttachmentSchema>
export type CommunityMessagePreview = z.infer<typeof CommunityMessagePreviewSchema>
export type CommunityMessagePreviewAttachment = z.infer<typeof CommunityMessagePreviewAttachmentSchema>
export type CommunityLegacyMessageAttachment = z.infer<typeof CommunityLegacyMessageAttachmentSchema>
export type CommunityMessagesRead = z.infer<typeof CommunityMessagesReadSchema>
export type CommunityConversationEntryRead = z.infer<typeof CommunityConversationEntryReadSchema>
export type CommunityThreadsRead = z.infer<typeof CommunityThreadsReadSchema>
export type CommunityLegacyThreadsRead = z.infer<typeof legacyReadSchemas.threads>
export type CommunityMembersRead = z.infer<typeof CommunityMembersReadSchema>
export type CommunityMessageSurfaceReceipt = CommunityMessagesRead["surfaceReceipt"]

const legacyChannelResourcePreviewSchema = CommunityChannelResourceSchema.partial().strip().extend({
  archived: legacyArchivedSchema.optional(),
})

export function normalizeCommunityChannelResourcePreview(value: unknown): Partial<CommunityChannelResource> {
  return legacyChannelResourcePreviewSchema.parse(value)
}

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

export function communityChannelResourceFromStorage(value: unknown): CommunityChannelResource {
  return CommunityChannelResourceSchema.strip().extend({ archived: legacyArchivedSchema }).parse(value)
}

const legacyMessageResourceSchema = CommunityLegacyMessageResourceSchema.strip().extend({
  channelId: id.optional(),
  replyToId: nullableId.optional(),
  clientNonce: CommunityMessageResourceSchema.shape.clientNonce.default(null),
  attachments: CommunityLegacyMessageResourceSchema.shape.attachments.default([]),
  embeds: CommunityMessageResourceSchema.shape.embeds.nullable().transform((value) => value ?? undefined),
})

export function normalizeCommunityMessageResource(value: unknown, channelId: string) {
  const raw = legacyMessageResourceSchema.parse(value)
  if (raw.channelId !== undefined && raw.channelId !== channelId) throw new Error("Message resource scope mismatch")
  return { ...raw, channelId: id.parse(channelId), replyToId: raw.replyToId ?? raw.replyTo?.id ?? null }
}

export function communityMessagePreviewFromLegacy(value: unknown, channelId: string): CommunityMessagePreview {
  const input = typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
  const message = normalizeCommunityMessageResource(value, channelId)
  const attachments = message.attachments.map(({ kind: _kind, size: _size, ...metadata }) => metadata)
  const preview = CommunityMessagePreviewSchema.parse({
    ...message,
    attachments: input.attachments === undefined ? undefined : attachments,
    clientNonce: input.clientNonce === undefined ? undefined : message.clientNonce,
    replyToId: input.replyToId === undefined ? message.replyTo?.id : input.replyToId,
    thread: message.thread ? {
      ...message.thread,
      participants: message.thread.participants?.map(({ avatar, name, ...identity }) => ({
        ...identity,
        ...(name ? { name } : {}),
        ...(avatar && avatar !== (name.trim().charAt(0) || "?").toUpperCase() ? { avatar } : {}),
      })),
    } : undefined,
  })
  return Object.fromEntries(Object.entries(preview).filter(([, field]) => field !== undefined)) as CommunityMessagePreview
}

export type CommunityLegacyMessageResource = z.infer<typeof CommunityLegacyMessageResourceSchema>
