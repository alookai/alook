import { z } from "zod"

const id = z.string().min(1)

export const AttentionScopeSchema = z.strictObject({
  scopeId: id,
  channelId: id,
  serverId: id.nullable().optional(),
  parentChannelId: id.nullable().optional(),
  ordinaryUnread: z.boolean(),
  lastUnreadSeq: z.number().int().nonnegative(),
  lastAttentionSeq: z.number().int().nonnegative().nullable().optional(),
  attentionCount: z.number().int().nonnegative(),
})

export const AttentionItemSchema = z.strictObject({
  id,
  kind: z.enum(["mention", "reply", "friend_request", "forum_post"]),
  sourceId: id,
  scopeId: id.nullable().optional(),
  messageId: id.nullable().optional(),
  actorUserId: id.nullable().optional(),
  createdAt: z.string(),
  childChannelId: id.optional(),
  openerSeq: z.number().int().nonnegative().optional(),
  readTarget: z.strictObject({
    channelId: id,
    seq: z.number().int().nonnegative(),
  }).optional(),
}).superRefine((item, ctx) => {
  if (item.kind === "friend_request") {
    if (!item.actorUserId || item.scopeId != null || item.messageId != null) {
      ctx.addIssue({ code: "custom", message: "friend request cannot reference a scope or message" })
    }
    if (item.childChannelId || item.openerSeq !== undefined || item.readTarget) {
      ctx.addIssue({ code: "custom", message: "friend request cannot carry forum presentation refs" })
    }
    return
  }
  if (!item.scopeId || !item.messageId) {
    ctx.addIssue({ code: "custom", message: "message attention requires scope and message refs" })
  }
  if (item.kind === "forum_post") {
    if (
      item.actorUserId != null
      || !item.childChannelId
      || item.openerSeq === undefined
      || !item.readTarget
      || item.sourceId !== item.childChannelId
      || item.readTarget.seq !== item.openerSeq
    ) {
      ctx.addIssue({ code: "custom", message: "forum post requires exact child, opener, and read-target refs" })
    }
    return
  }
  if (!item.actorUserId) {
    ctx.addIssue({ code: "custom", message: "message attention requires an actor" })
  }
  if (item.childChannelId || item.openerSeq !== undefined || item.readTarget) {
    ctx.addIssue({ code: "custom", message: "mention or reply cannot carry forum presentation refs" })
  }
})

export const AttentionIncludedServerSchema = z.strictObject({
  id,
  name: z.string(),
  discriminator: z.string(),
})

export const AttentionIncludedChannelSchema = z.strictObject({
  id,
  serverId: id,
  name: z.string(),
  type: z.enum(["text", "forum", "thread"]),
  parentChannelId: id.nullable(),
  parentMessageId: id.nullable(),
  creatorId: id.nullable(),
  archived: z.boolean(),
  lastMessageAt: z.string().nullable(),
  openerSeq: z.number().int().nonnegative().optional(),
  openerUnread: z.boolean().optional(),
})

export const AttentionIncludedDmSchema = z.strictObject({
  id,
  userId: id,
  name: z.string(),
  discriminator: z.string(),
  avatar: z.string(),
  avatarVersion: z.number().int().nonnegative(),
  lastMessageAt: z.string(),
  lastUnreadSeq: z.number().int().nonnegative(),
})

export const AttentionIncludedProfileSchema = z.strictObject({
  userId: id,
  name: z.string(),
  discriminator: z.string(),
  avatar: z.string(),
  avatarVersion: z.number().int().nonnegative(),
})

export const AttentionIncludedMessageSchema = z.strictObject({
  id,
  channelId: id,
  type: z.enum(["chat", "system"]),
  authorId: id.optional(),
  authorName: z.string().optional(),
  seq: z.number().int().nonnegative(),
  createdAt: z.string(),
  content: z.string(),
})

export const AttentionIncludedSchema = z.strictObject({
  servers: z.array(AttentionIncludedServerSchema),
  channels: z.array(AttentionIncludedChannelSchema),
  dms: z.array(AttentionIncludedDmSchema),
  profiles: z.array(AttentionIncludedProfileSchema),
  messages: z.array(AttentionIncludedMessageSchema),
})

export const AccountAttentionSnapshotSchema = z.strictObject({
  scopes: z.array(AttentionScopeSchema),
  items: z.array(AttentionItemSchema),
  limit: z.number().int().positive(),
  truncated: z.boolean(),
  included: AttentionIncludedSchema,
}).superRefine((snapshot, ctx) => {
  const scopeIds = new Set<string>()
  for (const scope of snapshot.scopes) {
    if (scopeIds.has(scope.scopeId)) {
      ctx.addIssue({ code: "custom", message: `duplicate attention scope: ${scope.scopeId}` })
    }
    scopeIds.add(scope.scopeId)
  }
  const itemIds = new Set<string>()
  const serverById = new Map(snapshot.included.servers.map((server) => [server.id, server]))
  const channelById = new Map(snapshot.included.channels.map((channel) => [channel.id, channel]))
  const dmById = new Map(snapshot.included.dms.map((dm) => [dm.id, dm]))
  const profileById = new Map(snapshot.included.profiles.map((profile) => [profile.userId, profile]))
  const messageById = new Map(snapshot.included.messages.map((message) => [message.id, message]))
  const rejectDuplicates = (values: string[], kind: string) => {
    const seen = new Set<string>()
    for (const value of values) {
      if (seen.has(value)) ctx.addIssue({ code: "custom", message: `duplicate included ${kind}: ${value}` })
      seen.add(value)
    }
  }
  rejectDuplicates(snapshot.included.servers.map((server) => server.id), "server")
  rejectDuplicates(snapshot.included.channels.map((channel) => channel.id), "channel")
  rejectDuplicates(snapshot.included.dms.map((dm) => dm.id), "dm")
  rejectDuplicates(snapshot.included.profiles.map((profile) => profile.userId), "profile")
  rejectDuplicates(snapshot.included.messages.map((message) => message.id), "message")
  for (const scope of snapshot.scopes) {
    if (scope.serverId) {
      const channel = channelById.get(scope.channelId)
      if (!serverById.has(scope.serverId) || !channel || channel.serverId !== scope.serverId) {
        ctx.addIssue({ code: "custom", message: `attention scope references missing owner: ${scope.scopeId}` })
        continue
      }
      if (scope.parentChannelId) {
        const parent = channelById.get(scope.parentChannelId)
        const opener = channel.parentMessageId
          ? messageById.get(channel.parentMessageId)
          : undefined
        if (
          channel.parentChannelId !== scope.parentChannelId
          || !parent
          || parent.serverId !== scope.serverId
          || !opener
          || opener.channelId !== parent.id
          || channel.openerSeq !== opener.seq
          || channel.openerUnread === undefined
        ) {
          ctx.addIssue({ code: "custom", message: `attention scope references missing parent: ${scope.scopeId}` })
        }
      } else if (channel.parentChannelId !== null) {
        ctx.addIssue({ code: "custom", message: `attention scope parent mismatch: ${scope.scopeId}` })
      }
    } else {
      const dm = dmById.get(scope.channelId)
      if (!dm || !profileById.has(dm.userId)) {
        ctx.addIssue({ code: "custom", message: `attention scope references missing DM owner: ${scope.scopeId}` })
      }
    }
  }
  for (const item of snapshot.items) {
    if (itemIds.has(item.id)) {
      ctx.addIssue({ code: "custom", message: `duplicate attention item: ${item.id}` })
    }
    itemIds.add(item.id)
    if (item.scopeId && !scopeIds.has(item.scopeId)) {
      ctx.addIssue({ code: "custom", message: `attention item references missing scope: ${item.scopeId}` })
    }
    if (item.kind === "friend_request") {
      if (!item.actorUserId || !profileById.has(item.actorUserId)) {
        ctx.addIssue({ code: "custom", message: `friend request references missing profile: ${item.id}` })
      }
      continue
    }
    const scope = item.scopeId
      ? snapshot.scopes.find((candidate) => candidate.scopeId === item.scopeId)
      : undefined
    const message = item.messageId ? messageById.get(item.messageId) : undefined
    if (!scope || !message) {
      ctx.addIssue({ code: "custom", message: `attention item references missing message: ${item.id}` })
      continue
    }
    if (item.kind === "forum_post") {
      const parent = channelById.get(scope.channelId)
      const child = item.childChannelId ? channelById.get(item.childChannelId) : undefined
      if (
        !scope.serverId
        || parent?.type !== "forum"
        || child?.type !== "thread"
        || child.parentChannelId !== parent.id
        || child.parentMessageId !== message.id
        || message.channelId !== parent.id
        || message.seq !== item.openerSeq
        || item.readTarget?.channelId !== parent.id
      ) {
        ctx.addIssue({ code: "custom", message: `forum post references incomplete presentation owners: ${item.id}` })
      }
      continue
    }
    if (
      message.channelId !== scope.channelId
      || !item.actorUserId
      || !profileById.has(item.actorUserId)
    ) {
      ctx.addIssue({ code: "custom", message: `message attention references incomplete owners: ${item.id}` })
    }
  }
})

export type AttentionScope = z.infer<typeof AttentionScopeSchema>
export type AttentionItem = z.infer<typeof AttentionItemSchema>
export type AccountAttentionSnapshot = z.infer<typeof AccountAttentionSnapshotSchema>
