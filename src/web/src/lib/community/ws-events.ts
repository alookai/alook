/**
 * TypeScript types for all community WebSocket events.
 *
 * Convention: every event type starts with "community:" prefix.
 * The server fans events to each recipient's per-user DO via POST /broadcast/user/<userId>.
 * The client filters events based on its focused subscription (channelId/threadId/dmConversationId).
 */

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
    mentionType?: "everyone" | "here" | null
    replyToId?: string | null
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

// ── Thread events ─────────────────────────────────────────────────────────────

export type CommunityThreadCreate = {
  type: "community:thread.create"
  channelId: string
  thread: {
    id: string
    name: string
    kind: "thread" | "forum_post"
    creatorId?: string
    createdAt: string
  }
  parentMessageId?: string
}

export type CommunityThreadUpdate = {
  type: "community:thread.update"
  channelId: string
  threadId: string
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
    type: "text" | "forum"
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
    type?: "text" | "forum"
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

// ── Presence events ───────────────────────────────────────────────────────────

export type CommunityPresenceUpdate = {
  type: "community:presence.update"
  userId: string
  online: boolean
}

// ── Union type ────────────────────────────────────────────────────────────────

export type CommunityWsEvent =
  | CommunityMessageCreate
  | CommunityReactionAdd
  | CommunityReactionRemove
  | CommunityPinAdd
  | CommunityPinRemove
  | CommunityTypingStart
  | CommunityThreadCreate
  | CommunityThreadUpdate
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

/** Type guard: is this a community WS event? */
export function isCommunityEvent(msg: { type: string }): msg is CommunityWsEvent {
  return msg.type.startsWith("community:")
}
