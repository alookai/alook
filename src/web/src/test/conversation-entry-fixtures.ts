import { normalizeCommunityChannelResource, type CommunityChannelIdentity } from "@alook/shared"
import type { CommunityConversationEntryRead } from "@alook/shared"

export function conversationEntryFixture(): CommunityConversationEntryRead {
  const at = "2026-10-01T00:00:01.000Z"
  return {
    contractVersion: 3, channelId: "c1", viewerId: "viewer", peer: null,
    channel: { id: "c1", type: "text", serverId: "s1", categoryId: null, name: "Channel", topic: "", parentChannelId: null, parentMessageId: null, creatorId: "viewer", position: 0, archived: false, createdAt: at, lastMessageAt: at, messageCount: 1 },
    access: { channelId: "c1", canRead: true, canSend: true, canCreateDiscussion: true },
    readState: { channelId: "c1", lastReadMessageId: "m1", lastReadAt: at, lastReadSeq: 1 }, readStateRevision: 4,
    selection: { reason: "read_pointer", anchorMessageId: "m1" },
    surfaceReceipt: { channelId: "c1", surfaceKind: "channel" },
    messages: [{ id: "m1", channelId: "c1", seq: 1, authorId: "peer", createdAt: at, type: "chat", content: "Body", replyToId: null, clientNonce: null, attachments: [] }],
    page: { olderCursor: "older", newerCursor: null, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 1 },
  }
}
export const conversationEntryTarget = { channelId: "c1", serverId: "s1" }

export function forumConversationEntryFixture(channelId = "c1", serverId = "s1", empty = false): CommunityConversationEntryRead {
  const base = conversationEntryFixture()
  const channel = { ...base.channel, id: channelId, serverId, type: "forum" as const, name: "Forum" }
  return { ...base, channelId, channel, messages: [],
    access: { ...base.access, channelId }, readState: { ...base.readState, channelId },
    selection: { reason: "tail", anchorMessageId: null }, surfaceReceipt: { channelId, surfaceKind: "forum" },
    page: { ...base.page, hasMoreOlder: false, olderCursor: null },
    forumFeed: { contractVersion: 3, channelId, channel,
      threads: empty ? [] : [{ ...channel, id: "t1", type: "thread", parentChannelId: channelId, parentMessageId: "m1", name: "Post" }],
      included: { messages: empty ? [] : [{ ...base.messages[0], channelId }], members: [], profiles: [], tags: [], participantCounts: [] },
      page: { hasMore: false, nextCursor: null },
    },
  }
}

export function dmConversationEntryFixture(): CommunityConversationEntryRead {
  const entry = conversationEntryFixture()
  return { ...entry, channel: { ...entry.channel, type: "dm", serverId: null, name: null },
    peer: { id: "peer", name: "Peer", discriminator: "0042", avatar: null, avatarVersion: 5 },
    access: { ...entry.access, canCreateDiscussion: false }, surfaceReceipt: { channelId: entry.channelId, surfaceKind: "dm" } }
}

export function conversationEntryFromChannel(value: CommunityChannelIdentity, viewerId = "viewer"): CommunityConversationEntryRead {
  const channel = normalizeCommunityChannelResource(value)
  return { contractVersion: 3, channelId: channel.id, viewerId, channel,
    peer: channel.type === "dm" ? { id: "peer", name: "Peer", discriminator: "0042", avatar: null, avatarVersion: 0 } : null,
    access: { channelId: channel.id, canRead: true, canSend: true, canCreateDiscussion: channel.type === "text" || channel.type === "forum" },
    readState: { channelId: channel.id, lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 }, readStateRevision: 0,
    selection: { reason: "tail", anchorMessageId: null }, surfaceReceipt: { channelId: channel.id, surfaceKind: channel.type === "text" ? "channel" : channel.type },
    messages: [], page: { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 0 } }
}

export async function seedConversationEntry(client: import("@tanstack/react-query").QueryClient, entry: CommunityConversationEntryRead, target: import("@/lib/community/conversation-entry").ConversationEntryTarget = { channelId: entry.channelId, serverId: entry.channel.serverId }) {
  const { publishConversationEntry, conversationEntryOptions } = await import("@/lib/community/conversation-entry")
  const { captureCommunityLiveSnapshotToken } = await import("@/lib/community-db/sync")
  const options = conversationEntryOptions(client, target)
  const resource = publishConversationEntry(client, target, entry, { token: captureCommunityLiveSnapshotToken(client, target.channelId), signal: undefined })
  client.setQueryData(options.queryKey, resource)
  return { ...options, resource }
}
