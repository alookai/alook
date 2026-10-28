import { CommunityResourceProfileSchema } from "./community-profile-resource"
export { CommunityResourceProfileSchema } from "./community-profile-resource"
import { z } from "zod"
import { COMMUNITY_RESOURCE_CONTRACT_VERSION } from "./community-contract"
import { FriendApprovalPayloadSchema } from "./community-friend-approval"
import { PARTICIPANT_SOURCE } from "./constants/community"
import { BotCreationPayloadSchema } from "./community-bot-creation"

const id = z.string().min(1)
const nullableId = id.nullable()
export const COMMUNITY_CONVERSATION_ANCHOR_MISSING = "conversation_anchor_missing"
const storedArchivedSchema = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((value) => value === true || value === 1)

export const CommunityServerResourceSchema = z.strictObject({
  id: z.string().min(1),
  position: z.number().int().nonnegative(),
  name: z.string(),
  discriminator: z.string(),
  description: z.string(),
  ownerId: z.string(),
  icon: z.string().nullable(),
  official: z.boolean(),
  isOwner: z.boolean(),
})

export const CommunityCategoryResourceSchema = z.strictObject({
  id: z.string().min(1),
  serverId: z.string().min(1),
  name: z.string(),
  position: z.number(),
  private: z.boolean(),
  creatorId: z.string().nullable(),
})

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
}).strip()

export const CommunityAccessDecisionSchema = z.strictObject({
  channelId: id,
  canRead: z.boolean(),
  canSend: z.boolean(),
  canCreateDiscussion: z.boolean(),
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
  }).refine(reply => reply.deleted === true || reply.authorId !== undefined, { message: "Live reply author identity missing" }).optional(),
  embeds: z.array(z.unknown()).optional(),
  reactions: z.array(z.strictObject({
    emoji: z.string(),
    count: z.number().int().nonnegative(),
    me: z.boolean(),
    userIds: z.array(id),
  })).optional(),
  thread: messageThreadSchema.optional(),
  approval: FriendApprovalPayloadSchema.optional(),
  botCreation: BotCreationPayloadSchema.optional(),
})

export function communityMessageProfileIds(messages: readonly Pick<CommunityMessageResource, "authorId" | "replyTo">[]) {
  return [...new Set(messages.flatMap(message => [message.authorId, ...(message.replyTo?.authorId && message.replyTo.deleted !== true ? [message.replyTo.authorId] : [])]))]
}

export const CommunityMessageResourcesSchema = z.strictObject({
  messages: z.array(CommunityMessageResourceSchema),
  profiles: z.array(CommunityResourceProfileSchema),
}).superRefine((resources, ctx) => {
  const ids = new Set(resources.profiles.map(profile => profile.id))
  if (ids.size !== resources.profiles.length || communityMessageProfileIds(resources.messages).some(id => !ids.has(id))) {
    ctx.addIssue({ code: "custom", path: ["profiles"], message: "Message profile missing or duplicated in resource graph" })
  }
})

export const CommunityReadStateResourceSchema = z.strictObject({
  channelId: id,
  lastReadMessageId: nullableId,
  lastReadAt: z.string().nullable(),
  lastReadSeq: z.number().int().nonnegative(),
})

export const CommunityServerMembershipResourceSchema = z.strictObject({
  serverId: id, userId: id, memberId: id, role: z.string(),
})

export const CommunityChannelMembershipResourceSchema = z.strictObject({
  channelId: id,
  userId: id,
  relation: z.enum(["access", "notify"]),
  source: z.enum([...Object.values(PARTICIPANT_SOURCE), "explicit", "inherited", "admin", "access-decision"]),
})

export const CommunityMemberRelationSchema = CommunityChannelMembershipResourceSchema.extend({
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
export const CommunityResourceBundleSchema = CommunityMessageResourcesSchema.safeExtend({
  viewerId: id,
  servers: z.array(CommunityServerResourceSchema), serverMemberships: z.array(CommunityServerMembershipResourceSchema),
  channels: z.array(CommunityChannelResourceSchema), memberships: z.array(CommunityChannelMembershipResourceSchema),
}).superRefine((bundle, ctx) => {
  const channels = new Set(bundle.channels.map(row => row.id))
  const servers = new Set(bundle.servers.map(row => row.id))
  if (channels.size !== bundle.channels.length || servers.size !== bundle.servers.length
    || new Set(bundle.messages.map(row => row.id)).size !== bundle.messages.length
    || new Set(bundle.profiles.map(row => row.id)).size !== bundle.profiles.length
    || new Set(bundle.memberships.map(row => `${row.channelId}:${row.userId}:${row.relation}`)).size !== bundle.memberships.length
    || new Set(bundle.serverMemberships.map(row => `${row.serverId}:${row.userId}`)).size !== bundle.serverMemberships.length
    || bundle.messages.some(row => !channels.has(row.channelId))
    || bundle.servers.some(row => !bundle.serverMemberships.some(member => member.serverId === row.id && member.userId === bundle.viewerId))
    || bundle.channels.some(row => !bundle.memberships.some(member => member.channelId === row.id && member.userId === bundle.viewerId && member.relation === "access"))
    || bundle.channels.some(row => row.serverId !== null && !servers.has(row.serverId) || row.parentChannelId !== null && !channels.has(row.parentChannelId))
    || bundle.memberships.some(row => row.userId !== bundle.viewerId || !channels.has(row.channelId))
    || bundle.serverMemberships.some(row => row.userId !== bundle.viewerId || !servers.has(row.serverId))) ctx.addIssue({ code: "custom", message: "Resource bundle scope mismatch" })
})
export type CommunityResourceBundle = z.infer<typeof CommunityResourceBundleSchema>

export const CommunityChannelReadSchema = z.strictObject({ ...envelope, channel: CommunityChannelResourceSchema, access: CommunityAccessDecisionSchema })
export const CommunityMessagesReadSchema = CommunityMessageResourcesSchema.safeExtend({ ...envelope, page: CommunityPageSchema,
  surfaceReceipt: z.strictObject({ channelId: id, surfaceKind: z.enum(["channel", "forum", "thread", "dm"]) }) })
export const CommunityConversationEntryReadSchema = CommunityMessagesReadSchema.safeExtend({
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
  if (entry.opener) {
    const graph = CommunityMessageResourcesSchema.safeParse({ messages: [...entry.messages, entry.opener], profiles: entry.profiles })
    if (!graph.success) for (const issue of graph.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message })
  }
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
export const CommunityMessageReadSchema = z.strictObject({ ...envelope,
  message: CommunityMessageResourceSchema, profiles: CommunityMessageResourcesSchema.shape.profiles,
}).superRefine((read, ctx) => {
  const graph = CommunityMessageResourcesSchema.safeParse({ messages: [read.message], profiles: read.profiles })
  if (!graph.success) for (const issue of graph.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message })
})
export const CommunityMessagePostedSchema = CommunityMessageReadSchema.safeExtend({ deduped: z.boolean(), threadId: id.optional() })
export const CommunityMembersReadSchema = z.strictObject({ ...envelope, relation: z.enum(["access", "notify"]), members: z.array(CommunityMemberRelationSchema), profiles: z.array(CommunityResourceProfileSchema) })
export const CommunityThreadsReadSchema = z.strictObject({ ...envelope, channel: CommunityChannelResourceSchema,
  threads: z.array(CommunityChannelResourceSchema),
  included: CommunityMessageResourcesSchema.safeExtend({ members: z.array(CommunityMemberRelationSchema),
    tags: z.array(z.strictObject({ messageId: id, tag: z.string() })),
    participantCounts: z.array(z.strictObject({ channelId: id, count: z.number().int().nonnegative() })) }),
  page: z.strictObject({ nextCursor: z.string().nullable(), hasMore: z.boolean() }) })
export const CommunityReadAdvanceSchema = z.strictObject({ ...envelope, changed: z.boolean(), targetSeq: z.number().int().nonnegative(), revision: z.number().int().nonnegative() })
export const CommunityInviteJoinTargetSchema = z.object({ serverId: CommunityServerResourceSchema.shape.id }).strip()
export const CommunityReadErrorSchema = z.strictObject({ contractVersion: z.literal(COMMUNITY_RESOURCE_CONTRACT_VERSION), error: z.strictObject({
  code: z.enum(["invalid_input", "invalid_reply_target", "unauthenticated", "not_found", "not_allowed", "blocked", "idempotency_conflict", "rate_limited", "temporarily_unavailable"]),
  message: z.string(), retryable: z.boolean(), details: z.array(z.string()).optional(),
}) })

const resourceReadSchemas = {
  channel: CommunityChannelReadSchema, messages: CommunityMessagesReadSchema,
  members: CommunityMembersReadSchema, threads: CommunityThreadsReadSchema, readAdvance: CommunityReadAdvanceSchema, error: CommunityReadErrorSchema,
}

export function communityReadSchemas(contract: number = COMMUNITY_RESOURCE_CONTRACT_VERSION) {
  if (contract !== COMMUNITY_RESOURCE_CONTRACT_VERSION) throw new Error("Community resource protocol mismatch")
  return resourceReadSchemas
}

export type CommunityServerResource = z.infer<typeof CommunityServerResourceSchema>
export type CommunityCategoryResource = z.infer<typeof CommunityCategoryResourceSchema>
export type CommunityChannelResource = z.infer<typeof CommunityChannelResourceSchema>
export type CommunityChannelIdentity = z.infer<typeof CommunityChannelIdentitySchema>
export type CommunityMessageResource = z.infer<typeof CommunityMessageResourceSchema>
export type CommunityMemberRelation = z.infer<typeof CommunityMemberRelationSchema>
export type CommunityReadStateResource = z.infer<typeof CommunityReadStateResourceSchema>
export type CommunityAccessDecision = z.infer<typeof CommunityAccessDecisionSchema>
export type CommunityResourceProfile = z.infer<typeof CommunityResourceProfileSchema>
export type CommunityMessageAttachment = z.infer<typeof CommunityMessageAttachmentSchema>
export type CommunityMessageRead = z.infer<typeof CommunityMessageReadSchema>
export type CommunityMessagePosted = z.infer<typeof CommunityMessagePostedSchema>
export type CommunityMessageResources = z.infer<typeof CommunityMessageResourcesSchema>
export type CommunityMessagesRead = z.infer<typeof CommunityMessagesReadSchema>
export type CommunityConversationEntryRead = z.infer<typeof CommunityConversationEntryReadSchema>
export type CommunityThreadsRead = z.infer<typeof CommunityThreadsReadSchema>
export type CommunityMembersRead = z.infer<typeof CommunityMembersReadSchema>
export type CommunityMessageSurfaceReceipt = CommunityMessagesRead["surfaceReceipt"]

export function communityChannelResourceFromStorage(value: unknown): CommunityChannelResource {
  return CommunityChannelResourceSchema.strip().extend({ archived: storedArchivedSchema }).parse(value)
}


export function communityUserAvatarUrl(userId: string, avatarVersion?: number): string {
  const base = `/api/community/users/${userId}/avatar`
  return avatarVersion && avatarVersion > 0 ? `${base}?v=${avatarVersion}` : base
}

export function communityBotAvatarUrl(botId: string, avatarVersion?: number): string {
  const base = `/api/community/bots/${botId}/avatar`
  return avatarVersion && avatarVersion > 0 ? `${base}?v=${avatarVersion}` : base
}

export function canonicalCommunityUserImage(userId: string, image: string | null, avatarVersion: number): string | null {
  if (!image) return null
  if (image === communityUserAvatarUrl(userId)) return communityUserAvatarUrl(userId, avatarVersion)
  if (image === communityBotAvatarUrl(userId)) return communityBotAvatarUrl(userId, avatarVersion)
  return image
}
