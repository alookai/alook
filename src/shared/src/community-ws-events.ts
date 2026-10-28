import { PiiResultSchema } from "./pii-contract"
import { z } from "zod"
import { COMMUNITY_CONTRACT_VERSION } from "./community-contract"
import { serverSchema } from "./community-cache"
import { CommunityMachineSummarySchema, RuntimeModelDiscoveryResultSchema } from "./schemas"
import { FriendApprovalPayloadSchema } from "./community-friend-approval"
import { BotCreationPayloadSchema } from "./community-bot-creation"
import { CommunityCategoryResourceSchema, CommunityChannelResourceSchema, CommunityMessageResourceSchema, CommunityMemberRelationSchema, CommunityResourceProfileSchema } from "./community-resources"

export { FriendApprovalPayloadSchema } from "./community-friend-approval"
export type { FriendApprovalPayload, FriendApprovalProfile } from "./community-friend-approval"

const string = z.string()
const nullableString = string.nullable()
const channelTypeSchema = CommunityChannelResourceSchema.shape.type.extract(["text", "forum"])

const communityMessageCreateSchema = z.strictObject({
  type: z.literal("community:message.create"),
  channelId: string,
  serverId: string.optional(),
  parentChannelId: string.optional(),
  message: CommunityMessageResourceSchema.required({ authorName: true, authorAvatarVersion: true }),
}).refine(event => event.message.channelId === event.channelId)

const communityMessageUpdatedSchema = z.strictObject({
  type: z.literal("community:message.updated"),
  channelId: string,
  messageId: string,
  approval: FriendApprovalPayloadSchema.optional(),
  botCreation: BotCreationPayloadSchema.optional(),
}).refine((event) => event.approval !== undefined || event.botCreation !== undefined)

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
  type: z.literal("community:channel.child_create"), parentChannelId: string,
  channel: CommunityChannelResourceSchema.extend({ type: z.literal("thread") }), parentMessageId: string.optional(),
}).refine(event => event.channel.parentChannelId === event.parentChannelId && (event.parentMessageId === undefined || event.parentMessageId === event.channel.parentMessageId))

const communityChildChannelUpdateSchema = z.strictObject({
  type: z.literal("community:channel.child_update"), parentChannelId: string, channelId: string,
  changes: CommunityChannelResourceSchema.pick({ name: true, archived: true, lastMessageAt: true, messageCount: true }).partial().extend({ tags: z.array(string).nullable().optional() }),
})

const communityServerUpdateSchema = z.strictObject({
  type: z.literal("community:server.update"), serverId: string,
  changes: serverSchema.pick({ name: true, description: true, icon: true }).partial(),
})

const communityServerRailChangedSchema = z.strictObject({
  type: z.literal("community:server_rail.changed"),
})

const communityServerDeleteSchema = z.strictObject({
  type: z.literal("community:server.delete"),
  serverId: string,
})

const communityChannelCreateSchema = z.strictObject({
  type: z.literal("community:channel.create"), serverId: string,
  channel: CommunityChannelResourceSchema.extend({ type: channelTypeSchema }),
}).refine(event => event.channel.serverId === event.serverId)

const communityChannelUpdateSchema = z.strictObject({
  type: z.literal("community:channel.update"), serverId: string, channelId: string,
  changes: CommunityChannelResourceSchema.pick({ name: true, topic: true, categoryId: true, type: true }).partial().extend({ type: channelTypeSchema.optional() }),
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

const communityChannelMembershipChangeSchema = z.strictObject({
  type: z.literal("community:channel.membership.change"),
  channelId: string,
  serverId: string.nullable(),
  userId: string,
  relation: CommunityMemberRelationSchema.shape.relation,
  present: z.boolean(),
})

const communityCategoryCreateSchema = z.strictObject({
  type: z.literal("community:category.create"),
  serverId: string,
  category: CommunityCategoryResourceSchema,
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
  member: CommunityResourceProfileSchema.pick({ name: true, discriminator: true, avatar: true, avatarVersion: true }).extend({
    id: string, userId: string, role: string, joinedAt: string,
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
  blockedByViewer: z.boolean().optional(),
})

export const CommunityInviteCreateSchema = z.strictObject({
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

const communityIdentityUpdateSchema = CommunityResourceProfileSchema.pick({ avatar: true, avatarVersion: true }).extend({
  type: z.literal("community:identity.update"), userId: string,
  avatarVersion: CommunityResourceProfileSchema.shape.avatarVersion.refine(version => version > 0),
})

const communityProfileUpdateSchema = CommunityResourceProfileSchema.pick({ name: true, discriminator: true, aboutMe: true, bannerColor: true, kind: true, ownerUserId: true }).required().extend({
  type: z.literal("community:profile.update"), userId: string,
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
  kind: z.enum(["cli_invocation", "tool_call", "thinking", "text", "turn_interrupt", "wake_trigger", "session_reset", "nap", "model_changed", "provider_changed", "error"]),
  payload: z.unknown(),
  sessionId: nullableString.optional(),
  launchId: nullableString.optional(),
  createdAt: string,
}).refine((event) => Object.prototype.hasOwnProperty.call(event, "payload"))

const communityRuntimeModelsSchema = z.strictObject({
  type: z.literal("community:runtime.models"),
  machineId: z.string().min(1),
  requestId: z.string().min(1).max(128),
  runtimeId: z.string().min(1).max(64),
  result: RuntimeModelDiscoveryResultSchema,
})

const communityBotPiiSchema = z.strictObject({
  type: z.literal("community:bot.pii"),
  machineId: z.string().min(1),
  botId: z.string().min(1),
  requestId: z.string().min(1).max(128),
  result: PiiResultSchema,
})

const commonCommunityEventSchemas = [
  communityBotPiiSchema,
  communityMessageUpdatedSchema,
  communityReactionAddSchema,
  communityReactionRemoveSchema,
  communityPinAddSchema,
  communityPinRemoveSchema,
  communityTypingStartSchema,
  communityTypingStopSchema,
  communityServerUpdateSchema,
  communityServerRailChangedSchema,
  communityServerDeleteSchema,
  communityChannelDeleteSchema,
  communityChannelReorderSchema,
  communityChannelMembershipChangeSchema,
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
  CommunityInviteCreateSchema,
  communityMentionCreateSchema,
  communityUnreadBumpSchema,
  communityReadStateAdvancedSchema,
  communityInboxChangedSchema,
  communityPresenceUpdateSchema,
  communityStatusUpdateSchema,
  communityMachineCreatedSchema,
  communityMachineStatusSchema,
  communityMachineUpdatedSchema,
  communityRuntimeModelsSchema,
  communityMachineRemovedSchema,
  communityBotAuditEventSchema,
] as const

export const CommunityWsEventSchema = z.discriminatedUnion("type", [
  ...commonCommunityEventSchemas, communityMessageCreateSchema, communityChildChannelCreateSchema,
  communityChannelCreateSchema, communityChildChannelUpdateSchema, communityChannelUpdateSchema,
  communityIdentityUpdateSchema, communityProfileUpdateSchema,
])
export const CommunityResourceWsEventSchema = CommunityWsEventSchema

export function communityWsEventSchemaForContract(contract: number = COMMUNITY_CONTRACT_VERSION) {
  if (contract !== COMMUNITY_CONTRACT_VERSION) throw new Error("Community event protocol mismatch")
  return CommunityWsEventSchema
}

export type CommunityWsEvent = z.infer<typeof CommunityWsEventSchema>
export type CommunityResourceWsEvent = CommunityWsEvent
export type CommunityMessageCreate = Extract<CommunityWsEvent, { type: "community:message.create" }>
export type CommunityMessageUpdated = Extract<CommunityWsEvent, { type: "community:message.updated" }>
export type CommunityReactionAdd = Extract<CommunityWsEvent, { type: "community:reaction.add" }>
export type CommunityReactionRemove = Extract<CommunityWsEvent, { type: "community:reaction.remove" }>
export type CommunityPinAdd = Extract<CommunityWsEvent, { type: "community:pin.add" }>
export type CommunityPinRemove = Extract<CommunityWsEvent, { type: "community:pin.remove" }>
export type CommunityTypingStart = Extract<CommunityWsEvent, { type: "community:typing.start" }>
export type CommunityTypingStop = Extract<CommunityWsEvent, { type: "community:typing.stop" }>
export type CommunityChildChannelCreate = Extract<CommunityWsEvent, { type: "community:channel.child_create" }>
export type CommunityChildChannelUpdate = Extract<CommunityWsEvent, { type: "community:channel.child_update" }>
export type CommunityServerRailChanged = Extract<CommunityWsEvent, { type: "community:server_rail.changed" }>
export type CommunityServerUpdate = Extract<CommunityWsEvent, { type: "community:server.update" }>
export type CommunityServerDelete = Extract<CommunityWsEvent, { type: "community:server.delete" }>
export type CommunityChannelCreate = Extract<CommunityWsEvent, { type: "community:channel.create" }>
export type CommunityChannelUpdate = Extract<CommunityWsEvent, { type: "community:channel.update" }>
export type CommunityChannelDelete = Extract<CommunityWsEvent, { type: "community:channel.delete" }>
export type CommunityChannelReorder = Extract<CommunityWsEvent, { type: "community:channel.reorder" }>
export type CommunityChannelMembershipChange = Extract<CommunityWsEvent, { type: "community:channel.membership.change" }>
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
export type CommunityIdentityUpdate = Extract<CommunityWsEvent, { type: "community:identity.update" }>
export type CommunityProfileUpdate = Extract<CommunityWsEvent, { type: "community:profile.update" }>
export type CommunityMachineCreated = Extract<CommunityWsEvent, { type: "community:machine.created" }>
export type CommunityMachineStatus = Extract<CommunityWsEvent, { type: "community:machine.status" }>
export type CommunityRuntimeModels = Extract<CommunityWsEvent, { type: "community:runtime.models" }>
export type CommunityMachineUpdated = Extract<CommunityWsEvent, { type: "community:machine.updated" }>
export type CommunityMachineRemoved = Extract<CommunityWsEvent, { type: "community:machine.removed" }>
export type CommunityBotAuditEvent = Extract<CommunityWsEvent, { type: "community:bot.audit_event" }>

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
  REACTION_ADD: "community:reaction.add",
  REACTION_REMOVE: "community:reaction.remove",
  PIN_ADD: "community:pin.add",
  PIN_REMOVE: "community:pin.remove",
  TYPING_START: "community:typing.start",
  TYPING_STOP: "community:typing.stop",
  CHILD_CHANNEL_CREATE: "community:channel.child_create",
  CHILD_CHANNEL_UPDATE: "community:channel.child_update",
  SERVER_UPDATE: "community:server.update",
  SERVER_RAIL_CHANGED: "community:server_rail.changed",
  SERVER_DELETE: "community:server.delete",
  CHANNEL_CREATE: "community:channel.create",
  CHANNEL_UPDATE: "community:channel.update",
  CHANNEL_DELETE: "community:channel.delete",
  CHANNEL_REORDER: "community:channel.reorder",
  CHANNEL_MEMBERSHIP_CHANGE: "community:channel.membership.change",
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
  IDENTITY_UPDATE: "community:identity.update",
  PROFILE_UPDATE: "community:profile.update",
  MACHINE_CREATED: "community:machine.created",
  MACHINE_STATUS: "community:machine.status",
  MACHINE_UPDATED: "community:machine.updated",
  RUNTIME_MODELS: "community:runtime.models",
  BOT_PII: "community:bot.pii",
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

export type CommunityBrowserEventDecodeResult<Event = CommunityWsEvent> =
  | { ok: true; event: Event }
  | {
      ok: false
      reason: CommunityBrowserEventFailureReason
      type: CommunityWsEvent["type"] | "unknown"
    }

export type CommunityBrowserEventEnvelope = CommunityWsEvent & { schemaVersion: typeof COMMUNITY_CONTRACT_VERSION }

export type CommunityBrowserEventEncodeResult<Event = CommunityWsEvent> =
  | {
      ok: true
      event: Event
      envelope: Event & { schemaVersion: typeof COMMUNITY_CONTRACT_VERSION }
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

export function isCommunityEventCandidate(value: unknown): value is Record<string, unknown> & { type: `community:${string}` } {
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

export function validateCommunityWsEvent(value: unknown, contract: number = COMMUNITY_CONTRACT_VERSION): CommunityBrowserEventDecodeResult {
  if (contract !== COMMUNITY_CONTRACT_VERSION) return { ok: false, reason: "invalid-payload", type: "unknown" }
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

  const parsed = communityWsEventSchemaForContract(contract).safeParse(value)
  if (!parsed.success) return { ok: false, reason: "invalid-payload", type: value.type }
  return { ok: true, event: parsed.data }
}

export function decodeCommunityBrowserEvent(value: unknown, contract: number = COMMUNITY_CONTRACT_VERSION): CommunityBrowserEventDecodeResult {
  if (contract !== COMMUNITY_CONTRACT_VERSION || !isRecord(value) || value.schemaVersion !== COMMUNITY_CONTRACT_VERSION) return { ok: false, reason: "invalid-payload", type: "unknown" }
  const { schemaVersion: _schemaVersion, ...event } = value
  return validateCommunityWsEvent(event, contract)
}

export function encodeCommunityBrowserEvent(value: unknown, contract: number = COMMUNITY_CONTRACT_VERSION): CommunityBrowserEventEncodeResult {
  if (contract !== COMMUNITY_CONTRACT_VERSION) return { ok: false, reason: "invalid-payload", type: "unknown" }
  const parsed = communityWsEventSchemaForContract(contract).safeParse(value)
  const type = isRecord(value) && isCommunityEventType(value.type) ? value.type : "unknown"
  if (!parsed.success) return { ok: false, reason: "invalid-payload", type }
  const event = parsed.data
  const envelope = { ...event, schemaVersion: COMMUNITY_CONTRACT_VERSION }
  const body = JSON.stringify(envelope)
  const byteLength = utf8ByteLength(body)
  if (byteLength > COMMUNITY_BROWSER_EVENT_MAX_BYTES) {
    return { ok: false, reason: "oversized", type: parsed.data.type, byteLength }
  }
  return { ok: true, event, envelope, body, byteLength }
}
