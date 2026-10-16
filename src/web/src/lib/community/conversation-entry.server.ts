import { COMMUNITY_CONVERSATION_ANCHOR_MISSING, communityChannelResourceFromStorage, CommunityConversationEntryReadSchema, CommunityThreadsReadSchema, CommunityMessageResourceSchema, queries, withD1Retry, type CommunityConversationEntryRead, type Database } from "@alook/shared"
import { canonicalUserImage } from "./storage"
import { readCommunityMessageWindow } from "./message-window.server"
import { communityMessagesReadFromPage } from "./read-contract"
import type { DoorTarget } from "./message-door"
import type { parseCommunityMessageWindow } from "./messages"
import { readCommunityForumRows } from "./forum-feed.server"
import { readCommunityThreadsResource } from "./thread-read"
import { readCommunityMessageResource } from "./message-payload"

type ConversationEntryInput = {
  viewerId: string
  target: DoorTarget
  window: ReturnType<typeof parseCommunityMessageWindow>
  preferTail: boolean
  tag?: string
}

export async function readCommunityConversationEntry(db: Database, input: ConversationEntryInput): Promise<
  { ok: true; entry: CommunityConversationEntryRead } | { ok: false; status: 400 | 403 | 404; error: string; details?: string[] }
> {
  const { viewerId, target, window } = input
  if (window.cursor || window.since) return { ok: false, status: 400, error: "entry requires an initial message window" }
  const channel = communityChannelResourceFromStorage(target.access.channel)
  const channelId = target.target.channelId
  if (channel.id !== channelId) throw new Error("Conversation entry target mismatch")
  if (channel.archived) return { ok: false, status: 403, error: "channel is archived" }
  const [read, canSend, peer, opener, parent] = await Promise.all([
    readEntryWindow(db, input),
    target.access.surface === "dm"
      ? queries.communityFriendship.areFriends(db, viewerId, target.access.dm.otherUserId)
      : Promise.resolve(true),
    target.access.surface === "dm" ? readPeer(db, target.access.dm.otherUserId) : Promise.resolve(null),
    channel.parentChannelId && channel.parentMessageId ? readOpener(db, viewerId, channel.parentChannelId, channel.parentMessageId) : Promise.resolve(undefined),
    channel.parentChannelId ? readParent(db, viewerId, channel.parentChannelId) : Promise.resolve(undefined),
  ])
  if (!read.ok) return read
  return { ok: true, entry: CommunityConversationEntryReadSchema.parse({
    ...communityMessagesReadFromPage(channelId, read.page), viewerId, channel, peer,
    ...(opener ? { opener } : {}),
    ...(parent ? { parent } : {}),
    readState: read.readState, readStateRevision: read.revision, selection: read.selection,
    ...("forumFeed" in read ? { forumFeed: read.forumFeed } : {}),
    access: { channelId, canRead: true, canSend,
      canCreateDiscussion: !channel.parentChannelId && (channel.type === "text" || channel.type === "forum") },
  }) }
}

async function readEntryWindow(db: Database, { viewerId, target, window, preferTail, tag }: ConversationEntryInput) {
  const channelId = target.target.channelId
  const { readState: row, revision } = await withD1Retry(() => queries.communityReadState.getChannelReadStateSnapshot(db, { userId: viewerId, channelId }), {
    route: "community/messages:entry-read-state",
  })
  const readState = {
    channelId, lastReadMessageId: row?.lastReadMessageId ?? null,
    lastReadAt: row?.lastReadAt ?? null, lastReadSeq: row?.lastReadSeq ?? 0,
  }
  if (target.access.channel.type === "forum" && !window.anchorId) {
    const page = await readCommunityForumRows(db, channelId, { tag, pageSize: window.pageSize, includes: new Set(["parentMessage", "firstMessage", "tags", "participants"]) })
    const forumFeed = CommunityThreadsReadSchema.parse(await readCommunityThreadsResource(db, viewerId, target.access.channel, page.threads,
      { messages: [...page.parentMessages, ...page.firstMessages], tags: page.tags, participants: page.participants }, { hasMore: page.hasMore, nextCursor: page.nextCursor ?? null }, 3))
    return { ok: true as const, page: { messages: [], latestSeq: readState.lastReadSeq, hasMoreOlder: false, hasMoreNewer: false, surfaceReceipt: { channelId, surfaceKind: "forum" as const } },
      readState, revision, selection: { reason: "tail" as const, anchorMessageId: null }, forumFeed }
  }
  const anchorId = window.anchorId ?? (preferTail ? undefined : readState.lastReadMessageId ?? undefined)
  let selection: CommunityConversationEntryRead["selection"] = {
    reason: window.anchorId ? "explicit_anchor" : anchorId ? "read_pointer" : "tail", anchorMessageId: anchorId ?? null,
  }
  let result = await readCommunityMessageWindow(db, {
    viewerId, target, window: { ...window, anchorId }, contract: 3, tag,
  })
  if (!result.ok && !window.anchorId && anchorId) {
    selection = { reason: "read_pointer_missing", anchorMessageId: null }
    result = await readCommunityMessageWindow(db, {
      viewerId, target, window: { ...window, anchorId: undefined }, contract: 3, tag,
    })
  }
  if (!result.ok) return { ...result, ...(window.anchorId ? { details: [COMMUNITY_CONVERSATION_ANCHOR_MISSING] } : {}) }
  return { ok: true as const, page: result.page, readState, revision, selection }
}

async function readPeer(db: Database, peerId: string) {
  const peer = await withD1Retry(() => queries.user.getUserPublic(db, peerId), { route: "community/messages:entry-peer" })
  return { id: peerId, name: peer?.name ?? "Deleted user", discriminator: peer?.discriminator ?? null,
    avatar: peer ? canonicalUserImage(peerId, peer.image, peer.avatarVersion) : null, avatarVersion: peer?.avatarVersion ?? 0 }
}

async function readOpener(db: Database, viewerId: string, channelId: string, messageId: string) {
  const [message] = await withD1Retry(() => queries.communityMessage.getMessagesByIdsInScope(db, [messageId], { channelId }), { route: "community/messages:entry-opener" })
  return message ? CommunityMessageResourceSchema.parse(await readCommunityMessageResource(db, viewerId, message, 3)) : undefined
}

async function readParent(db: Database, viewerId: string, channelId: string) {
  const parent = await withD1Retry(() => queries.communityChannel.getChannelForMember(db, channelId, viewerId), { route: "community/messages:entry-parent" })
  return parent ? communityChannelResourceFromStorage(parent) : undefined
}
