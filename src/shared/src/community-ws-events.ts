import { z } from "zod"
import { CommunityMachineRuntimeSchema } from "./schemas"

const string = z.string()
const nullableString = string.nullable()
const channelTypeSchema = z.enum(["text", "forum"])
const mentionTypeSchema = z.literal("everyone")

const friendApprovalProfileSchema = z.strictObject({
  id: string,
  name: string,
  discriminator: string,
  image: nullableString,
})

export const FriendApprovalPayloadSchema = z.strictObject({
  friendshipId: string,
  status: z.enum(["pending", "approved", "denied", "superseded", "cancelled"]),
  waitingOn: z.enum(["you", "other-owner", "addressee"]).nullable(),
  otherProfile: friendApprovalProfileSchema,
  botProfile: friendApprovalProfileSchema,
  waitingOnProfile: friendApprovalProfileSchema.nullable().optional(),
})

const messageAttachmentSchema = z.strictObject({
  id: string,
  filename: string,
  url: string,
  thumbnailUrl: string.optional(),
  contentType: string.optional(),
  size: z.number().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
})

const messageSchema = z.strictObject({
  id: string,
  seq: z.number(),
  authorId: string,
  authorName: string,
  authorAvatar: string.optional(),
  content: string,
  type: z.enum(["chat", "system"]),
  systemKind: z.literal("thread").optional(),
  mentionType: mentionTypeSchema.nullable().optional(),
  replyToId: nullableString.optional(),
  replyTo: z.strictObject({
    id: string,
    authorName: string,
    text: string,
    deleted: z.boolean().optional(),
  }).optional(),
  embeds: z.array(z.unknown()).optional(),
  attachments: z.array(messageAttachmentSchema).optional(),
  createdAt: string,
  clientNonce: string.optional(),
  approval: FriendApprovalPayloadSchema.optional(),
})

const communityMessageCreateSchema = z.strictObject({
  type: z.literal("community:message.create"),
  channelId: string,
  serverId: string.optional(),
  parentChannelId: string.optional(),
  message: messageSchema,
})

const communityMessageUpdatedSchema = z.strictObject({
  type: z.literal("community:message.updated"),
  channelId: string,
  messageId: string,
  approval: FriendApprovalPayloadSchema,
})

const communityMessageEditedSchema = z.strictObject({
  type: z.literal("community:message.edited"),
  channelId: string,
  messageId: string,
  content: string,
  parentChannelId: string.optional(),
  serverId: string.optional(),
}).refine((event) => event.parentChannelId === undefined || event.serverId !== undefined)

const communityReactionAddSchema = z.strictObject({
  type: z.literal("community:reaction.add"),
  channelId: string,
  messageId: string,
  userId: string,
  emoji: string,
})

const communityReactionRemoveSchema = z.strictObject({
  type: z.literal("community:reaction.remove"),
  channelId: string,
  messageId: string,
  userId: string,
  emoji: string,
})

const communityPinAddSchema = z.strictObject({
  type: z.literal("community:pin.add"),
  channelId: string,
  messageId: string,
})

const communityPinRemoveSchema = z.strictObject({
  type: z.literal("community:pin.remove"),
  channelId: string,
  messageId: string,
})

const typingFields = {
  channelId: string,
  userId: string,
  name: string.optional(),
  discriminator: string.optional(),
}

const communityTypingStartSchema = z.strictObject({
  type: z.literal("community:typing.start"),
  ...typingFields,
})

const communityTypingStopSchema = z.strictObject({
  type: z.literal("community:typing.stop"),
  ...typingFields,
})

const communityChildChannelCreateSchema = z.strictObject({
  type: z.literal("community:channel.child_create"),
  parentChannelId: string,
  channel: z.strictObject({
    id: string,
    name: string,
    type: z.literal("thread"),
    creatorId: string.optional(),
    createdAt: string,
  }),
  parentMessageId: string.optional(),
})

const communityChildChannelUpdateSchema = z.strictObject({
  type: z.literal("community:channel.child_update"),
  parentChannelId: string,
  channelId: string,
  changes: z.strictObject({
    name: string.optional(),
    archived: z.boolean().optional(),
    tags: z.array(string).nullable().optional(),
    lastMessageAt: string.optional(),
    messageCount: z.number().optional(),
  }),
})

const communityServerUpdateSchema = z.strictObject({
  type: z.literal("community:server.update"),
  serverId: string,
  changes: z.strictObject({
    name: string.optional(),
    description: string.optional(),
    icon: nullableString.optional(),
  }),
})

const communityServerDeleteSchema = z.strictObject({
  type: z.literal("community:server.delete"),
  serverId: string,
})

const communityChannelCreateSchema = z.strictObject({
  type: z.literal("community:channel.create"),
  serverId: string,
  channel: z.strictObject({
    id: string,
    name: string,
    type: channelTypeSchema,
    categoryId: nullableString.optional(),
    topic: string.optional(),
    position: z.number(),
    createdAt: string,
  }),
})

const communityChannelUpdateSchema = z.strictObject({
  type: z.literal("community:channel.update"),
  serverId: string,
  channelId: string,
  changes: z.strictObject({
    name: string.optional(),
    topic: string.optional(),
    categoryId: nullableString.optional(),
    type: channelTypeSchema.optional(),
  }),
})

const communityChannelDeleteSchema = z.strictObject({
  type: z.literal("community:channel.delete"),
  serverId: string,
  channelId: string,
  parentChannelId: nullableString.optional(),
  parentMessageId: string.optional(),
}).refine(
  (event) => event.parentMessageId === undefined || (
    typeof event.parentChannelId === "string" && event.parentChannelId.length > 0
  ),
  { message: "parentMessageId requires parentChannelId" },
)

const positionedIdSchema = z.strictObject({ id: string, position: z.number() })

const communityChannelReorderSchema = z.strictObject({
  type: z.literal("community:channel.reorder"),
  serverId: string,
  channels: z.array(positionedIdSchema),
})

const communityChannelMemberAddSchema = z.strictObject({
  type: z.literal("community:channel.member_add"),
  serverId: string,
  channelId: string,
  userId: string,
})

const communityChannelMemberRemoveSchema = z.strictObject({
  type: z.literal("community:channel.member_remove"),
  serverId: string,
  channelId: string,
  userId: string,
})

const communityCategoryCreateSchema = z.strictObject({
  type: z.literal("community:category.create"),
  serverId: string,
  category: z.strictObject({
    id: string,
    name: string,
    position: z.number(),
    private: z.boolean(),
  }),
})

const communityCategoryUpdateSchema = z.strictObject({
  type: z.literal("community:category.update"),
  serverId: string,
  categoryId: string,
  changes: z.strictObject({
    name: string.optional(),
    position: z.number().optional(),
    private: z.boolean().optional(),
  }),
})

const communityCategoryDeleteSchema = z.strictObject({
  type: z.literal("community:category.delete"),
  serverId: string,
  categoryId: string,
})

const communityCategoryReorderSchema = z.strictObject({
  type: z.literal("community:category.reorder"),
  serverId: string,
  categories: z.array(positionedIdSchema),
})

const communityMemberJoinSchema = z.strictObject({
  type: z.literal("community:member.join"),
  serverId: string,
  member: z.strictObject({
    id: string,
    userId: string,
    name: string,
    discriminator: string,
    avatar: string.optional(),
    role: string,
    joinedAt: string,
  }),
})

const communityMemberLeaveSchema = z.strictObject({
  type: z.literal("community:member.leave"),
  serverId: string,
  userId: string,
})

const communityMemberUpdateSchema = z.strictObject({
  type: z.literal("community:member.update"),
  serverId: string,
  memberId: string,
  userId: string.optional(),
  changes: z.strictObject({
    role: string.optional(),
    nickname: nullableString.optional(),
  }),
})

const communityFriendRequestSchema = z.strictObject({
  type: z.literal("community:friend.request"),
  friendship: z.strictObject({
    id: string,
    requesterId: string,
    addresseeId: string,
    status: z.literal("pending"),
    createdAt: string,
  }),
})

const friendshipIdFields = { friendshipId: string }

const communityFriendAcceptSchema = z.strictObject({
  type: z.literal("community:friend.accept"),
  ...friendshipIdFields,
})

const communityFriendRejectSchema = z.strictObject({
  type: z.literal("community:friend.reject"),
  ...friendshipIdFields,
})

const communityFriendRemoveSchema = z.strictObject({
  type: z.literal("community:friend.remove"),
  ...friendshipIdFields,
})

const communityFriendBlockSchema = z.strictObject({
  type: z.literal("community:friend.block"),
  userId: string,
})

const communityInviteCreateSchema = z.strictObject({
  type: z.literal("community:invite.create"),
  serverId: string,
  invite: z.strictObject({
    id: string,
    token: string,
    maxUses: z.number().nullable().optional(),
    uses: z.number().nullable().optional(),
    expiresAt: nullableString.optional(),
    createdAt: string,
  }),
})

const communityMentionCreateSchema = z.strictObject({
  type: z.literal("community:mention.create"),
  userId: string,
  messageId: string,
  channelId: string.optional(),
  authorName: string,
})

const communityUnreadBumpSchema = z.strictObject({
  type: z.literal("community:unread.bump"),
  userId: string,
  channelId: string,
  serverId: string.optional(),
  railChannelId: string.optional(),
  isMention: z.boolean().optional(),
})

const readStateEnvelopeFields = {
  revision: z.number().int().positive(),
  // This is deliberately a bounded dirty hint rather than an account-sized
  // snapshot. The receiver fetches the authoritative replacement at (at
  // least) this revision, which preserves destructive regression/removal
  // semantics without ever exceeding the single-frame byte limit.
  inboxChanged: z.literal(true),
}

const communityReadStateAdvancedSchema = z.strictObject({
  type: z.literal("community:read_state.advanced"),
  ...readStateEnvelopeFields,
})

const communityInboxChangedSchema = z.strictObject({
  type: z.literal("community:inbox.changed"),
  ...readStateEnvelopeFields,
  reason: z.enum([
    "read_all",
    "forum_opener_read",
    "mention_read_all",
    "mention_dismiss",
    "notification_policy",
  ]),
})

const communityPresenceUpdateSchema = z.strictObject({
  type: z.literal("community:presence.update"),
  userId: string,
  online: z.boolean(),
})

const communityStatusUpdateSchema = z.strictObject({
  type: z.literal("community:status.update"),
  userId: string,
  statusEmoji: nullableString,
  statusText: nullableString,
})

const machineRuntimeSchema = CommunityMachineRuntimeSchema.strict()

export const CommunityMachineSummarySchema = z.strictObject({
  id: string,
  hostname: string,
  displayName: string,
  platform: string,
  arch: string,
  osRelease: string,
  daemonVersion: string,
  lastSeenAt: nullableString,
  status: z.enum(["online", "offline"]),
  availableRuntimes: z.array(machineRuntimeSchema),
  lastRuntimeError: z.strictObject({
    requested: string,
    available: z.array(string),
    at: string,
  }).optional(),
  createdAt: string,
  updatedAt: string,
})

const communityMachineCreatedSchema = z.strictObject({
  type: z.literal("community:machine.created"),
  machine: CommunityMachineSummarySchema,
  tokenId: string,
})

const communityMachineStatusSchema = z.strictObject({
  type: z.literal("community:machine.status"),
  machineId: string,
  status: z.enum(["online", "offline"]),
  lastSeenAt: string,
})

const communityMachineUpdatedSchema = z.strictObject({
  type: z.literal("community:machine.updated"),
  machine: CommunityMachineSummarySchema,
})

const communityMachineRemovedSchema = z.strictObject({
  type: z.literal("community:machine.removed"),
  machineId: string,
})

const communityBotAuditEventSchema = z.strictObject({
  type: z.literal("community:bot.audit_event"),
  botId: string,
  id: string,
  kind: z.enum(["cli_invocation", "tool_call", "thinking", "wake_trigger", "session_reset", "nap", "model_changed", "provider_changed", "error"]),
  payload: z.unknown(),
  sessionId: nullableString.optional(),
  launchId: nullableString.optional(),
  createdAt: string,
}).refine((event) => Object.prototype.hasOwnProperty.call(event, "payload"))

const CommunityWsEventDiscriminatedSchema = z.discriminatedUnion("type", [
  communityMessageCreateSchema,
  communityMessageUpdatedSchema,
  communityMessageEditedSchema,
  communityReactionAddSchema,
  communityReactionRemoveSchema,
  communityPinAddSchema,
  communityPinRemoveSchema,
  communityTypingStartSchema,
  communityTypingStopSchema,
  communityChildChannelCreateSchema,
  communityChildChannelUpdateSchema,
  communityServerUpdateSchema,
  communityServerDeleteSchema,
  communityChannelCreateSchema,
  communityChannelUpdateSchema,
  communityChannelDeleteSchema,
  communityChannelReorderSchema,
  communityChannelMemberAddSchema,
  communityChannelMemberRemoveSchema,
  communityCategoryCreateSchema,
  communityCategoryUpdateSchema,
  communityCategoryDeleteSchema,
  communityCategoryReorderSchema,
  communityMemberJoinSchema,
  communityMemberLeaveSchema,
  communityMemberUpdateSchema,
  communityFriendRequestSchema,
  communityFriendAcceptSchema,
  communityFriendRejectSchema,
  communityFriendRemoveSchema,
  communityFriendBlockSchema,
  communityInviteCreateSchema,
  communityMentionCreateSchema,
  communityUnreadBumpSchema,
  communityReadStateAdvancedSchema,
  communityInboxChangedSchema,
  communityPresenceUpdateSchema,
  communityStatusUpdateSchema,
  communityMachineCreatedSchema,
  communityMachineStatusSchema,
  communityMachineUpdatedSchema,
  communityMachineRemovedSchema,
  communityBotAuditEventSchema,
])

type InferredCommunityWsEvent = z.infer<typeof CommunityWsEventDiscriminatedSchema>
type InferredCommunityMessageEdited = Extract<
  InferredCommunityWsEvent,
  { type: "community:message.edited" }
>
type CommunityMessageEditedOutput = Omit<
  InferredCommunityMessageEdited,
  "parentChannelId" | "serverId"
> & (
  | { parentChannelId: string; serverId: string }
  | { parentChannelId?: never; serverId?: string }
)
type CommunityWsEventOutput =
  | Exclude<InferredCommunityWsEvent, InferredCommunityMessageEdited>
  | CommunityMessageEditedOutput

export const CommunityWsEventSchema = CommunityWsEventDiscriminatedSchema.transform(
  (event): CommunityWsEventOutput => event as CommunityWsEventOutput,
)

export type CommunityWsEvent = z.infer<typeof CommunityWsEventSchema>
export type CommunityMessageCreate = Extract<CommunityWsEvent, { type: "community:message.create" }>
export type CommunityMessageUpdated = Extract<CommunityWsEvent, { type: "community:message.updated" }>
export type CommunityMessageEdited = Extract<CommunityWsEvent, { type: "community:message.edited" }>
export type CommunityReactionAdd = Extract<CommunityWsEvent, { type: "community:reaction.add" }>
export type CommunityReactionRemove = Extract<CommunityWsEvent, { type: "community:reaction.remove" }>
export type CommunityPinAdd = Extract<CommunityWsEvent, { type: "community:pin.add" }>
export type CommunityPinRemove = Extract<CommunityWsEvent, { type: "community:pin.remove" }>
export type CommunityTypingStart = Extract<CommunityWsEvent, { type: "community:typing.start" }>
export type CommunityTypingStop = Extract<CommunityWsEvent, { type: "community:typing.stop" }>
export type CommunityChildChannelCreate = Extract<CommunityWsEvent, { type: "community:channel.child_create" }>
export type CommunityChildChannelUpdate = Extract<CommunityWsEvent, { type: "community:channel.child_update" }>
export type CommunityServerUpdate = Extract<CommunityWsEvent, { type: "community:server.update" }>
export type CommunityServerDelete = Extract<CommunityWsEvent, { type: "community:server.delete" }>
export type CommunityChannelCreate = Extract<CommunityWsEvent, { type: "community:channel.create" }>
export type CommunityChannelUpdate = Extract<CommunityWsEvent, { type: "community:channel.update" }>
export type CommunityChannelDelete = Extract<CommunityWsEvent, { type: "community:channel.delete" }>
export type CommunityChannelReorder = Extract<CommunityWsEvent, { type: "community:channel.reorder" }>
export type CommunityChannelMemberAdd = Extract<CommunityWsEvent, { type: "community:channel.member_add" }>
export type CommunityChannelMemberRemove = Extract<CommunityWsEvent, { type: "community:channel.member_remove" }>
export type CommunityCategoryCreate = Extract<CommunityWsEvent, { type: "community:category.create" }>
export type CommunityCategoryUpdate = Extract<CommunityWsEvent, { type: "community:category.update" }>
export type CommunityCategoryDelete = Extract<CommunityWsEvent, { type: "community:category.delete" }>
export type CommunityCategoryReorder = Extract<CommunityWsEvent, { type: "community:category.reorder" }>
export type CommunityMemberJoin = Extract<CommunityWsEvent, { type: "community:member.join" }>
export type CommunityMemberLeave = Extract<CommunityWsEvent, { type: "community:member.leave" }>
export type CommunityMemberUpdate = Extract<CommunityWsEvent, { type: "community:member.update" }>
export type CommunityFriendRequest = Extract<CommunityWsEvent, { type: "community:friend.request" }>
export type CommunityFriendAccept = Extract<CommunityWsEvent, { type: "community:friend.accept" }>
export type CommunityFriendReject = Extract<CommunityWsEvent, { type: "community:friend.reject" }>
export type CommunityFriendRemove = Extract<CommunityWsEvent, { type: "community:friend.remove" }>
export type CommunityFriendBlock = Extract<CommunityWsEvent, { type: "community:friend.block" }>
export type CommunityInviteCreate = Extract<CommunityWsEvent, { type: "community:invite.create" }>
export type CommunityMentionCreate = Extract<CommunityWsEvent, { type: "community:mention.create" }>
export type CommunityUnreadBump = Extract<CommunityWsEvent, { type: "community:unread.bump" }>
export type CommunityReadStateAdvanced = Extract<CommunityWsEvent, { type: "community:read_state.advanced" }>
export type CommunityInboxChanged = Extract<CommunityWsEvent, { type: "community:inbox.changed" }>
export type CommunityPresenceUpdate = Extract<CommunityWsEvent, { type: "community:presence.update" }>
export type CommunityStatusUpdate = Extract<CommunityWsEvent, { type: "community:status.update" }>
export type CommunityMachineCreated = Extract<CommunityWsEvent, { type: "community:machine.created" }>
export type CommunityMachineStatus = Extract<CommunityWsEvent, { type: "community:machine.status" }>
export type CommunityMachineUpdated = Extract<CommunityWsEvent, { type: "community:machine.updated" }>
export type CommunityMachineRemoved = Extract<CommunityWsEvent, { type: "community:machine.removed" }>
export type CommunityBotAuditEvent = Extract<CommunityWsEvent, { type: "community:bot.audit_event" }>
export type CommunityMachineSummary = z.infer<typeof CommunityMachineSummarySchema>
export type CommunityMachineRuntime = CommunityMachineSummary["availableRuntimes"][number]
export type FriendApprovalPayload = z.infer<typeof FriendApprovalPayloadSchema>
export type FriendApprovalProfile = FriendApprovalPayload["otherProfile"]

export type BotAddedFrame = {
  type: "bot:added"
  botId: string
  name: string
  discriminator: string
  description?: string
  ownerName: string
  ownerDiscriminator: string
}

export type BotUpdatedFrame = {
  type: "bot:updated"
  botId: string
  name: string
  discriminator: string
  description?: string
  ownerName: string
  ownerDiscriminator: string
}

export type BotRemovedFrame = { type: "bot:removed"; botId: string }
export type CommunityBotHostFrame = BotAddedFrame | BotUpdatedFrame | BotRemovedFrame

export const WS_EVENTS = {
  MESSAGE_CREATE: "community:message.create",
  MESSAGE_UPDATED: "community:message.updated",
  MESSAGE_EDITED: "community:message.edited",
  REACTION_ADD: "community:reaction.add",
  REACTION_REMOVE: "community:reaction.remove",
  PIN_ADD: "community:pin.add",
  PIN_REMOVE: "community:pin.remove",
  TYPING_START: "community:typing.start",
  TYPING_STOP: "community:typing.stop",
  CHILD_CHANNEL_CREATE: "community:channel.child_create",
  CHILD_CHANNEL_UPDATE: "community:channel.child_update",
  SERVER_UPDATE: "community:server.update",
  SERVER_DELETE: "community:server.delete",
  CHANNEL_CREATE: "community:channel.create",
  CHANNEL_UPDATE: "community:channel.update",
  CHANNEL_DELETE: "community:channel.delete",
  CHANNEL_REORDER: "community:channel.reorder",
  CHANNEL_MEMBER_ADD: "community:channel.member_add",
  CHANNEL_MEMBER_REMOVE: "community:channel.member_remove",
  CATEGORY_CREATE: "community:category.create",
  CATEGORY_UPDATE: "community:category.update",
  CATEGORY_DELETE: "community:category.delete",
  CATEGORY_REORDER: "community:category.reorder",
  MEMBER_JOIN: "community:member.join",
  MEMBER_LEAVE: "community:member.leave",
  MEMBER_UPDATE: "community:member.update",
  FRIEND_REQUEST: "community:friend.request",
  FRIEND_ACCEPT: "community:friend.accept",
  FRIEND_REJECT: "community:friend.reject",
  FRIEND_REMOVE: "community:friend.remove",
  FRIEND_BLOCK: "community:friend.block",
  INVITE_CREATE: "community:invite.create",
  MENTION_CREATE: "community:mention.create",
  UNREAD_BUMP: "community:unread.bump",
  READ_STATE_ADVANCED: "community:read_state.advanced",
  INBOX_CHANGED: "community:inbox.changed",
  PRESENCE_UPDATE: "community:presence.update",
  STATUS_UPDATE: "community:status.update",
  MACHINE_CREATED: "community:machine.created",
  MACHINE_STATUS: "community:machine.status",
  MACHINE_UPDATED: "community:machine.updated",
  MACHINE_REMOVED: "community:machine.removed",
  BOT_AUDIT_EVENT: "community:bot.audit_event",
} as const satisfies Record<string, CommunityWsEvent["type"]>

type DeclaredCommunityEventType = (typeof WS_EVENTS)[keyof typeof WS_EVENTS]
type MissingDeclaredEvent = Exclude<CommunityWsEvent["type"], DeclaredCommunityEventType>
type ExtraDeclaredEvent = Exclude<DeclaredCommunityEventType, CommunityWsEvent["type"]>
const exactCommunityEventTypes: MissingDeclaredEvent extends never
  ? ExtraDeclaredEvent extends never
    ? true
    : never
  : never = true
void exactCommunityEventTypes

const COMMUNITY_EVENT_TYPES: ReadonlySet<string> = new Set(Object.values(WS_EVENTS))

export const COMMUNITY_BROWSER_EVENT_MAX_BYTES = 65_536
export const COMMUNITY_USER_TARGET_MAX_BYTES = 128
export const COMMUNITY_USER_TARGET_PATH_PREFIX = "u:"
export const COMMUNITY_BULK_BODY_MAX_BYTES = 837_347

export type CommunityBrowserEventFailureReason =
  | "oversized"
  | "invalid-json"
  | "non-object"
  | "missing-type"
  | "wrong-family"
  | "unknown-community-type"
  | "invalid-payload"
  | "invalid-target"
  | "too-many-targets"
  | "pre-auth-frame"
  | "duplicate-auth-ok"

export type CommunityBrowserEventDecodeResult =
  | { ok: true; event: CommunityWsEvent }
  | {
      ok: false
      reason: CommunityBrowserEventFailureReason
      type: CommunityWsEvent["type"] | "unknown"
    }

export type CommunityBrowserEventEncodeResult =
  | {
      ok: true
      event: CommunityWsEvent
      body: string
      byteLength: number
    }
  | {
      ok: false
      reason: "invalid-payload" | "oversized"
      type: CommunityWsEvent["type"] | "unknown"
      byteLength?: number
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function isCommunityEventType(value: unknown): value is CommunityWsEvent["type"] {
  return typeof value === "string" && COMMUNITY_EVENT_TYPES.has(value)
}

export function isCommunityEventCandidate(value: unknown): value is Record<string, unknown> & { type: string } {
  return isRecord(value) && typeof value.type === "string" && value.type.startsWith("community:")
}

export function isCommunityEvent(msg: { type: string }): msg is CommunityWsEvent {
  return isCommunityEventType(msg.type)
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false
    }
  }
  return true
}

export function isValidCommunityUserTarget(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && isWellFormedUnicode(value)
    && utf8ByteLength(value) <= COMMUNITY_USER_TARGET_MAX_BYTES
}

export function encodeCommunityUserTargetPathSegment(target: string): string {
  return `${COMMUNITY_USER_TARGET_PATH_PREFIX}${encodeURIComponent(target)}`
}

export function decodeCommunityBrowserEvent(value: unknown): CommunityBrowserEventDecodeResult {
  if (!isRecord(value)) return { ok: false, reason: "non-object", type: "unknown" }
  if (typeof value.type !== "string" || value.type.length === 0) {
    return { ok: false, reason: "missing-type", type: "unknown" }
  }
  if (!value.type.startsWith("community:")) {
    return { ok: false, reason: "wrong-family", type: "unknown" }
  }
  if (!isCommunityEventType(value.type)) {
    return { ok: false, reason: "unknown-community-type", type: "unknown" }
  }

  const parsed = CommunityWsEventSchema.safeParse(value)
  if (!parsed.success) return { ok: false, reason: "invalid-payload", type: value.type }
  return { ok: true, event: parsed.data }
}

export function encodeCommunityBrowserEvent(value: unknown): CommunityBrowserEventEncodeResult {
  const parsed = CommunityWsEventSchema.safeParse(value)
  const type = isRecord(value) && isCommunityEventType(value.type) ? value.type : "unknown"
  if (!parsed.success) return { ok: false, reason: "invalid-payload", type }
  const event = parsed.data
  const body = JSON.stringify(event)
  const byteLength = utf8ByteLength(body)
  if (byteLength > COMMUNITY_BROWSER_EVENT_MAX_BYTES) {
    return { ok: false, reason: "oversized", type: parsed.data.type, byteLength }
  }
  return { ok: true, event, body, byteLength }
}
