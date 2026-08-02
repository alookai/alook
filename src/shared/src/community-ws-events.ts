/**
 * TypeScript types for all community WebSocket events.
 *
 * Convention: every event type starts with "community:" prefix.
 * The server fans events to each recipient's per-user DO via POST /broadcast/user/<userId>.
 * The client filters events based on its focused subscription (channelId).
 */

import type { ChannelType } from "./utils/community-roles"
import type { MentionType } from "./utils/community-mentions"

// ── Message events ────────────────────────────────────────────────────────────

export type CommunityMessageCreate = {
  type: "community:message.create"
  channelId: string
  message: {
    id: string
    authorId: string
    authorName: string
    authorAvatar?: string
    content: string
    type: "chat" | "system"
    // Only ever set alongside `type: "system"` — distinguishes a
    // thread-creation system message from a bare/other-origin system row
    // (`systemKind` omitted). See `mapMessageForWs`'s `splitType`.
    systemKind?: "thread"
    mentionType?: MentionType | null
    replyToId?: string | null
    replyTo?: { id: string; authorName: string; text: string; deleted?: boolean }
    embeds?: unknown[]
    attachments?: {
      id: string
      filename: string
      url: string
      contentType?: string
      size?: number
      width?: number | null
      height?: number | null
    }[]
    createdAt: string
    /**
     * The sender's CLIENT-PROVIDED idempotency nonce, echoed back so the
     * sender's client can match this broadcast against its optimistic row and
     * update it in place (tempId→id) instead of inserting a duplicate — the
     * optimistic row and the echo otherwise share no key (the echo carries the
     * server id; the optimistic row a `temp_` id). Present ONLY when the client
     * supplied a nonce (i.e. only when there is an optimistic row to match).
     * The server-side `srv:`-prefixed fallback nonce is deliberately NEVER put
     * here: it is a content fingerprint (existence/content-correlation leak on
     * the broadcast wire) AND a fallback send has no client optimistic row to
     * match, so it is structurally unneeded. Absent = no client nonce (nothing
     * to reconcile) — a plain random opaque token when present, safe to fan out.
     */
    clientNonce?: string
    /** Present only on a friend-approval card (DM channels). Client renders the card when set. */
    approval?: FriendApprovalPayload
  }
}

/**
 * A message's friend-approval card changed state (approve / deny / supersede /
 * accept). Fanned to every DM-channel peer whose channel contains a message
 * with the friendship's id so first-hop and second-hop cards (J3), and a
 * superseded card and its replacement, rehydrate without a refetch. Folded from
 * the old `community:dm.message_updated` — now keyed by `channelId` (the DM's
 * channel id). `approval` is the fresh per-recipient projection.
 */
export type CommunityMessageUpdated = {
  type: "community:message.updated"
  channelId: string
  messageId: string
  approval: FriendApprovalPayload
}

export type CommunityReactionAdd = {
  type: "community:reaction.add"
  channelId: string
  messageId: string
  userId: string
  emoji: string
}

export type CommunityReactionRemove = {
  type: "community:reaction.remove"
  channelId: string
  messageId: string
  userId: string
  emoji: string
}

export type CommunityPinAdd = {
  type: "community:pin.add"
  channelId: string
  messageId: string
}

export type CommunityPinRemove = {
  type: "community:pin.remove"
  channelId: string
  messageId: string
}

export type CommunityTypingStart = {
  type: "community:typing.start"
  channelId: string
  userId: string
  // Sender's display name + discriminator, stamped server-side at fan-out from
  // already-known identity (connection state for humans, bot binding for bots)
  // — never a per-event DB lookup. Optional so an older client ignores it and
  // falls back to roster resolution; present, it lets the client render the
  // name without depending on whether the typer is in the loaded roster page
  // (the "Unknown member is typing" bug when they aren't).
  name?: string
  discriminator?: string
}

/**
 * Explicit "stop typing" event. Fired by the daemon's bot-typing pipeline
 * when a bot's turn ends, so the pill disappears immediately instead of
 * dangling until the client's 8s auto-expire. Keyed by `channelId` (a DM is
 * a channel now).
 */
export type CommunityTypingStop = {
  type: "community:typing.stop"
  channelId: string
  userId: string
  name?: string
  discriminator?: string
}

// ── Child channel events (threads + forum posts) ─────────────────────────────

export type CommunityChildChannelCreate = {
  type: "community:channel.child_create"
  parentChannelId: string
  channel: {
    id: string
    name: string
    type: "thread" | "forum_post"
    creatorId?: string
    createdAt: string
  }
  parentMessageId?: string
}

export type CommunityChildChannelUpdate = {
  type: "community:channel.child_update"
  parentChannelId: string
  channelId: string
  changes: {
    name?: string
    archived?: boolean
    tags?: string[] | null
    lastMessageAt?: string
    messageCount?: number
  }
}

// ── Server events ─────────────────────────────────────────────────────────────

export type CommunityServerUpdate = {
  type: "community:server.update"
  serverId: string
  changes: {
    name?: string
    description?: string
    icon?: string | null
  }
}

export type CommunityServerDelete = {
  type: "community:server.delete"
  serverId: string
}

// ── Channel events ────────────────────────────────────────────────────────────

export type CommunityChannelCreate = {
  type: "community:channel.create"
  serverId: string
  channel: {
    id: string
    name: string
    type: ChannelType
    categoryId?: string | null
    topic?: string
    position: number
    createdAt: string
  }
}

export type CommunityChannelUpdate = {
  type: "community:channel.update"
  serverId: string
  channelId: string
  changes: {
    name?: string
    topic?: string
    categoryId?: string | null
    type?: ChannelType
    forumTags?: string | null
  }
}

export type CommunityChannelDelete = {
  type: "community:channel.delete"
  serverId: string
  channelId: string
  // The parent forum/thread channel, when the deleted channel is a child
  // (forum_post / thread). Lets clients invalidate the parent's post/thread
  // list so the deleted card disappears from the feed. Optional and additive —
  // older events without it still work (the handler simply skips the parent
  // invalidate).
  parentChannelId?: string | null
}

export type CommunityChannelReorder = {
  type: "community:channel.reorder"
  serverId: string
  channels: { id: string; position: number }[]
}

// ── Channel-member events (private-category channels) ─────────────────────────
//
// Sent to the affected user (so their sidebar gains/loses the channel) and to
// the existing channel members. The client invalidates the server-detail tree
// on receipt; the removed user additionally evicts that channel's caches.

export type CommunityChannelMemberAdd = {
  type: "community:channel.member_add"
  serverId: string
  channelId: string
  userId: string
}

export type CommunityChannelMemberRemove = {
  type: "community:channel.member_remove"
  serverId: string
  channelId: string
  userId: string
}

// ── Category events ───────────────────────────────────────────────────────────

export type CommunityCategoryCreate = {
  type: "community:category.create"
  serverId: string
  category: {
    id: string
    name: string
    position: number
    private: boolean
  }
}

export type CommunityCategoryUpdate = {
  type: "community:category.update"
  serverId: string
  categoryId: string
  changes: {
    name?: string
    position?: number
    private?: boolean
  }
}

export type CommunityCategoryDelete = {
  type: "community:category.delete"
  serverId: string
  categoryId: string
}

export type CommunityCategoryReorder = {
  type: "community:category.reorder"
  serverId: string
  categories: { id: string; position: number }[]
}

// ── Member events ─────────────────────────────────────────────────────────────

export type CommunityMemberJoin = {
  type: "community:member.join"
  serverId: string
  member: {
    id: string
    userId: string
    name: string
    // 4-digit discriminator (`"0042"`) — required. NOT NULL column; the row
    // becomes a roster `Member` via `applyJoinEvent`, which feeds the mention
    // popup, so the tag must always be present.
    discriminator: string
    avatar?: string
    role: string
    joinedAt: string
  }
}

export type CommunityMemberLeave = {
  type: "community:member.leave"
  serverId: string
  userId: string
}

export type CommunityMemberUpdate = {
  type: "community:member.update"
  serverId: string
  memberId: string
  // Present alongside `changes.nickname` on a self-rename broadcast — lets
  // clients patch `authorId`-keyed message caches (which don't have
  // `memberId`, a server-scoped id) by the renamed user's actual userId.
  // Absent on a role-only change, which never touches cached message rows.
  userId?: string
  changes: {
    role?: string
    nickname?: string | null
  }
}

// ── Friend events ─────────────────────────────────────────────────────────────

export type CommunityFriendRequest = {
  type: "community:friend.request"
  friendship: {
    id: string
    requesterId: string
    addresseeId: string
    status: "pending"
    createdAt: string
  }
}

export type CommunityFriendAccept = {
  type: "community:friend.accept"
  friendshipId: string
}

export type CommunityFriendReject = {
  type: "community:friend.reject"
  friendshipId: string
}

export type CommunityFriendRemove = {
  type: "community:friend.remove"
  friendshipId: string
}

export type CommunityFriendBlock = {
  type: "community:friend.block"
  userId: string
}

// ── Friend-approval card payload ───────────────────────────────────────────────
//
// Projected per-viewer for a friend-approval DM card (see
// plans/agent-friendship-approval-gate.md §DM card payload). Presence of this
// object on a DM message is the client-side discriminator for rendering the
// card — the message `type` stays "default". No `isBot` on any profile: the
// projections go through `getUserPublic`, and `botProfile` is the reader's own
// bot. No `kind` discriminator — `join_server` cards are a follow-up.

export type FriendApprovalProfile = {
  id: string
  name: string
  discriminator: string
  image: string | null
}

export type FriendApprovalPayload = {
  friendshipId: string
  // 'cancelled' — the requester withdrew a still-pending request (distinct from
  // 'superseded', which is a newer request replacing this one).
  status: "pending" | "approved" | "denied" | "superseded" | "cancelled"
  // Per-viewer projection. 'you' while this viewer's owner-approval is pending;
  // 'other-owner' after this viewer approved but a downstream owner is next
  // (J3); 'addressee' after this viewer approved and the human addressee must
  // still accept (J2); null for terminal states.
  waitingOn: "you" | "other-owner" | "addressee" | null
  // The other party — never the DM owner's own bot.
  otherProfile: FriendApprovalProfile
  // The DM owner's bot (also the DM peer). Leak-safe (reader's own bot).
  botProfile: FriendApprovalProfile
  // The person the card is currently waiting on, when waitingOn is
  // 'other-owner' or 'addressee'; null for 'you' and terminal states.
  waitingOnProfile?: FriendApprovalProfile | null
}

// ── Invite events ────────────────────────────────────────────────────────────

export type CommunityInviteCreate = {
  type: "community:invite.create"
  serverId: string
  invite: {
    id: string
    token: string
    maxUses?: number | null
    uses?: number | null
    expiresAt?: string | null
    createdAt: string
  }
}

// ── Mention events ───────────────────────────────────────────────────────────

export type CommunityMentionCreate = {
  type: "community:mention.create"
  userId: string
  messageId: string
  channelId?: string
  authorName: string
}

// Per-user unread/badge signal. Unlike MESSAGE_CREATE (a single broadcast to
// every recipient), the badge is per-recipient — user A may be muted while user
// B is not for the same message — so it rides a per-user event, gated by the
// recipient's effective notification level in the notify pipeline. The client's
// MESSAGE_CREATE handler no longer bumps the badge itself (it only appends
// content); the badge is bumped only on this event.
export type CommunityUnreadBump = {
  type: "community:unread.bump"
  userId: string
  /** The channel the message actually landed in (a thread bump = the thread's
   * id). Use `railChannelId` to locate the sidebar row; this is the true scope. */
  channelId: string
  /**
   * The server whose tree/rail badge to patch (inbox-dot-ws-driven plan). Lets
   * the client patch the RIGHT server — without it the client only patched the
   * currently-open server, so an other-server message's dot never lit. Absent
   * on a DM bump or an older server frame → client falls back to the
   * current-server behavior (backward-compatible).
   */
  serverId?: string
  /**
   * The sidebar-locatable channel row = `parentChannelId ?? channelId`, computed
   * server-side. A thread/forum-post message has no independent sidebar row, so
   * its dot must light the PARENT channel's row; a plain channel is its own row.
   * Absent → client falls back to `channelId`.
   */
  railChannelId?: string
  /**
   * Whether this recipient was mentioned by the message — decides +mention vs
   * +unread on the rail badge and which inbox feed the count lands in.
   * Per-recipient; known at emit time from the mention set. */
  isMention?: boolean
}

// ── Presence events ───────────────────────────────────────────────────────────

export type CommunityPresenceUpdate = {
  type: "community:presence.update"
  userId: string
  online: boolean
}

export type CommunityStatusUpdate = {
  type: "community:status.update"
  userId: string
  statusEmoji: string | null
  statusText: string | null
}

// ── Machine events ────────────────────────────────────────────────────────────

/**
 * One CLI runtime detected on a community-paired machine.
 * Canonical schema + type live in `./schemas.ts`; re-exported here for
 * historical import paths.
 */
export type { CommunityMachineRuntime } from "./schemas"
import type { CommunityMachineRuntime } from "./schemas"

export type CommunityMachineSummary = {
  id: string
  hostname: string
  displayName: string
  platform: string
  arch: string
  osRelease: string
  daemonVersion: string
  lastSeenAt: string | null
  status: "online" | "offline"
  /** Agent CLIs detected on the host — always present, possibly empty. */
  availableRuntimes: CommunityMachineRuntime[]
  /**
   * Last runtime error reported by the daemon. Optional overlay; undefined
   * means "no known error." Optimistically cleared when the DO forwards a
   * subsequent `agent:wake` frame to the daemon.
   */
  lastRuntimeError?: {
    requested: string
    available: string[]
    at: string
  }
  createdAt: string
  updatedAt: string
}

export type CommunityMachineCreated = {
  type: "community:machine.created"
  machine: CommunityMachineSummary
  tokenId: string
}

export type CommunityMachineStatus = {
  type: "community:machine.status"
  machineId: string
  status: "online" | "offline"
  lastSeenAt: string
}

export type CommunityMachineUpdated = {
  type: "community:machine.updated"
  machine: CommunityMachineSummary
}

export type CommunityMachineRemoved = {
  type: "community:machine.removed"
  machineId: string
}

// ── Bot audit-log events ─────────────────────────────────────────────────────
//
// Owner-only fan-out. When a daemon reports a bot activity event
// (cli_invocation | tool_call | thinking), ws-do inserts it into
// community_bot_activity_event and delivers a single frame to the bot owner's
// per-user DO. Non-owners never see these frames.

export type CommunityBotAuditEvent = {
  type: "community:bot.audit_event"
  botId: string
  id: string
  kind: "cli_invocation" | "tool_call" | "thinking" | "wake_trigger" | "session_reset" | "model_changed" | "error"
  payload: unknown
  sessionId?: string | null
  launchId?: string | null
  createdAt: string
}

// ── Bot events ────────────────────────────────────────────────────────────────
//
// Server → daemon frames. Colon-namespaced to match the existing HostCommand
// convention (`agent:wake` / `agent:stop`). Delivered to the specific
// machine's daemon connection via the WS Durable Object.

export type BotAddedFrame = {
  type: "bot:added"
  botId: string
  name: string
  /** 4-digit tag (`computeDiscriminator`) — pairs with `name` for the bot's global handle. */
  discriminator: string
  description?: string
  /** The owning user's name + discriminator — pairs into the owner's global handle. */
  ownerName: string
  ownerDiscriminator: string
}

export type BotUpdatedFrame = {
  type: "bot:updated"
  botId: string
  name: string
  /** 4-digit tag (`computeDiscriminator`) — pairs with `name` for the bot's global handle. */
  discriminator: string
  description?: string
  /** The owning user's name + discriminator — pairs into the owner's global handle. */
  ownerName: string
  ownerDiscriminator: string
}

export type BotRemovedFrame = {
  type: "bot:removed"
  botId: string
}

export type CommunityBotHostFrame = BotAddedFrame | BotUpdatedFrame | BotRemovedFrame

// ── Union type ────────────────────────────────────────────────────────────────

export type CommunityWsEvent =
  | CommunityMessageCreate
  | CommunityMessageUpdated
  | CommunityReactionAdd
  | CommunityReactionRemove
  | CommunityPinAdd
  | CommunityPinRemove
  | CommunityTypingStart
  | CommunityTypingStop
  | CommunityChildChannelCreate
  | CommunityChildChannelUpdate
  | CommunityServerUpdate
  | CommunityServerDelete
  | CommunityChannelCreate
  | CommunityChannelUpdate
  | CommunityChannelDelete
  | CommunityChannelReorder
  | CommunityChannelMemberAdd
  | CommunityChannelMemberRemove
  | CommunityCategoryCreate
  | CommunityCategoryUpdate
  | CommunityCategoryDelete
  | CommunityCategoryReorder
  | CommunityInviteCreate
  | CommunityMemberJoin
  | CommunityMemberLeave
  | CommunityMemberUpdate
  | CommunityFriendRequest
  | CommunityFriendAccept
  | CommunityFriendReject
  | CommunityFriendRemove
  | CommunityFriendBlock
  | CommunityPresenceUpdate
  | CommunityStatusUpdate
  | CommunityMentionCreate
  | CommunityUnreadBump
  | CommunityMachineCreated
  | CommunityMachineStatus
  | CommunityMachineUpdated
  | CommunityMachineRemoved
  | CommunityBotAuditEvent

/** Type guard: is this a community WS event? */
export function isCommunityEvent(msg: { type: string }): msg is CommunityWsEvent {
  return msg.type.startsWith("community:")
}

/** Constant map of every community WS event type string. */
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
  PRESENCE_UPDATE: "community:presence.update",
  STATUS_UPDATE: "community:status.update",
  MACHINE_CREATED: "community:machine.created",
  MACHINE_STATUS: "community:machine.status",
  MACHINE_UPDATED: "community:machine.updated",
  MACHINE_REMOVED: "community:machine.removed",
  BOT_AUDIT_EVENT: "community:bot.audit_event",
} as const
