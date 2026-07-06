/**
 * TypeScript types for all community WebSocket events.
 *
 * Convention: every event type starts with "community:" prefix.
 * The server fans events to each recipient's per-user DO via POST /broadcast/user/<userId>.
 * The client filters events based on its focused subscription (channelId/threadId/dmConversationId).
 */

import type { ChannelType } from "./utils/community-roles"
import type { MentionType } from "./utils/community-mentions"

// ── Message events ────────────────────────────────────────────────────────────

export type CommunityMessageCreate = {
  type: "community:message.create"
  channelId?: string
  dmConversationId?: string
  threadId?: string
  message: {
    id: string
    authorId: string
    authorName: string
    authorAvatar?: string
    content: string
    type?: "default" | "system" | "thread_created"
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
  }
}

export type CommunityReactionAdd = {
  type: "community:reaction.add"
  channelId?: string
  dmConversationId?: string
  threadId?: string
  messageId: string
  userId: string
  emoji: string
}

export type CommunityReactionRemove = {
  type: "community:reaction.remove"
  channelId?: string
  dmConversationId?: string
  threadId?: string
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
  channelId?: string
  dmConversationId?: string
  threadId?: string
  userId: string
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
}

export type CommunityChannelReorder = {
  type: "community:channel.reorder"
  serverId: string
  channels: { id: string; position: number }[]
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

// ── DM events ─────────────────────────────────────────────────────────────────

export type CommunityDmNewMessage = {
  type: "community:dm.new_message"
  dmConversationId: string
  message: {
    id: string
    authorId: string
    authorName: string
    authorAvatar?: string
    content: string
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
  }
}

export type CommunityDmTyping = {
  type: "community:dm.typing"
  dmConversationId: string
  userId: string
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

// ── Presence events ───────────────────────────────────────────────────────────

export type CommunityPresenceUpdate = {
  type: "community:presence.update"
  userId: string
  online: boolean
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
   * subsequent `agent:start` frame to the daemon.
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

// ── Bot events ────────────────────────────────────────────────────────────────
//
// Server → daemon frames. Colon-namespaced to match the existing HostCommand
// convention (`agent:start` / `agent:stop` / `agent:deliver`). Delivered to
// the specific machine's daemon connection via the WS Durable Object.

export type BotAddedFrame = {
  type: "bot:added"
  botId: string
  name: string
  description?: string
}

export type BotUpdatedFrame = {
  type: "bot:updated"
  botId: string
  name: string
  description?: string
}

export type BotRemovedFrame = {
  type: "bot:removed"
  botId: string
}

export type CommunityBotHostFrame = BotAddedFrame | BotUpdatedFrame | BotRemovedFrame

// ── Union type ────────────────────────────────────────────────────────────────

export type CommunityWsEvent =
  | CommunityMessageCreate
  | CommunityReactionAdd
  | CommunityReactionRemove
  | CommunityPinAdd
  | CommunityPinRemove
  | CommunityTypingStart
  | CommunityChildChannelCreate
  | CommunityChildChannelUpdate
  | CommunityServerUpdate
  | CommunityServerDelete
  | CommunityChannelCreate
  | CommunityChannelUpdate
  | CommunityChannelDelete
  | CommunityChannelReorder
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
  | CommunityDmNewMessage
  | CommunityDmTyping
  | CommunityPresenceUpdate
  | CommunityMentionCreate
  | CommunityMachineCreated
  | CommunityMachineStatus
  | CommunityMachineUpdated
  | CommunityMachineRemoved

/** Type guard: is this a community WS event? */
export function isCommunityEvent(msg: { type: string }): msg is CommunityWsEvent {
  return msg.type.startsWith("community:")
}

/** Constant map of every community WS event type string. */
export const WS_EVENTS = {
  MESSAGE_CREATE: "community:message.create",
  REACTION_ADD: "community:reaction.add",
  REACTION_REMOVE: "community:reaction.remove",
  PIN_ADD: "community:pin.add",
  PIN_REMOVE: "community:pin.remove",
  TYPING_START: "community:typing.start",
  CHILD_CHANNEL_CREATE: "community:channel.child_create",
  CHILD_CHANNEL_UPDATE: "community:channel.child_update",
  SERVER_UPDATE: "community:server.update",
  SERVER_DELETE: "community:server.delete",
  CHANNEL_CREATE: "community:channel.create",
  CHANNEL_UPDATE: "community:channel.update",
  CHANNEL_DELETE: "community:channel.delete",
  CHANNEL_REORDER: "community:channel.reorder",
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
  DM_NEW_MESSAGE: "community:dm.new_message",
  DM_TYPING: "community:dm.typing",
  INVITE_CREATE: "community:invite.create",
  MENTION_CREATE: "community:mention.create",
  PRESENCE_UPDATE: "community:presence.update",
  MACHINE_CREATED: "community:machine.created",
  MACHINE_STATUS: "community:machine.status",
  MACHINE_UPDATED: "community:machine.updated",
  MACHINE_REMOVED: "community:machine.removed",
} as const
