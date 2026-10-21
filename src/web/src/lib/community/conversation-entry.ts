import { reconcileConversationLanding } from "@/hooks/community/community-ws/reconnect-messages"
import { channelHref } from "./community-route"
import { currentPageObservation, navigationForHref } from "@/lib/observability/context"
import { hashKey, notifyManager, queryOptions, type QueryClient, type QueryKey } from "@tanstack/react-query"
import { COMMUNITY_CONTRACT_HEADER, CommunityConversationEntryReadSchema, type CommunityConversationEntryRead, type CommunityReadStateResource } from "@alook/shared"
import { apiFetch, type ApiRequestOptions } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { communityRequestOptions } from "./account-cache-lifecycle"
import { isChannelMetadataTokenCurrent } from "./conversation-qualification"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import type { ChannelRow, MessageRow, ReadStateRow } from "@/lib/community-db/schema"
import { ApiError } from "@/lib/errors"
import {
  assertCommunityLiveSnapshotTokenCurrent, captureCommunityLiveSnapshotToken,
  publishCommunityChannelMetadata, publishCommunityChannelMembersSnapshot, publishCommunityConversationReadState, confirmCommunityConversationPresence,
  publishCommunityMessages, retireCommunityChannelReading, type CommunityFreshQueryProof,
  publishCommunityForumFeed, getCanonicalCommunityAttentionScopes,
} from "@/lib/community-db/sync"
import { messageWindowPage, type MessagesPageParam } from "./models/message"
import { messageWindowIdentity, type InitialMessageWindow, type MessageWindowData } from "./message-window"
import { isConversationAnchorMissingError, retryConversationRead, withConversationReadDeadline } from "./conversation-read"
import { forumFeedWindow, normalizeThreadResources, type ForumFeedPage } from "@/hooks/community/forum-feed-window"

export type ConversationEntryTarget = {
  channelId: string
  serverId: string | null
  anchorMessageId?: string | null
  tag?: string | null
  preferTail?: boolean
}

export type ConversationEntryResource = {
  channelId: string
  source: "rsc" | "network"
  initialWindow: InitialMessageWindow
  windowKey: QueryKey
  readStateAtEntry: CommunityReadStateResource
  readStateRevision: number
  selection: CommunityConversationEntryRead["selection"]
  access: CommunityConversationEntryRead["access"]
  proof: ReturnType<typeof captureCommunityLiveSnapshotToken>
}

export function publishConversationEntry(
  client: QueryClient,
  target: ConversationEntryTarget,
  value: CommunityConversationEntryRead,
  proof: CommunityFreshQueryProof,
  source: "rsc" | "network" = "network",
): ConversationEntryResource {
  assertCommunityLiveSnapshotTokenCurrent(client, proof.token, proof.signal)
  const entry = CommunityConversationEntryReadSchema.parse({ ...value, messages: value.messages.map((message) => {
    const { resourceComplete: _complete, ...resource } = message as typeof message & { resourceComplete?: true }
    return resource
  }) })
  const channel = entry.channel
  if (entry.viewerId !== proof.token.viewerId || proof.token.channelId !== target.channelId || entry.channelId !== target.channelId || channel.serverId !== target.serverId
    || (target.serverId === null ? channel.type !== "dm" : channel.type === "dm")
    || target.anchorMessageId && (entry.selection.reason !== "explicit_anchor" || entry.selection.anchorMessageId !== target.anchorMessageId)) throw new Error("Conversation entry target mismatch")
  const registry = proof.token.registry!
  const parent = channel.parentChannelId
  if (parent && (registry.runtime.ws.get().channelAccessScopes.get(parent)?.generation ?? 0) !== (proof.token.channelScopes.get(parent)?.generation ?? 0)) throw new DOMException("Retired conversation parent", "AbortError")
  const initialWindow: InitialMessageWindow = entry.selection.anchorMessageId ? { mode: "anchor", anchor: entry.selection.anchorMessageId } : { mode: "newest" }
  const windowKey = entry.forumFeed ? communityKeys.forumFeed(target.channelId, target.tag ?? null) : communityKeys.channelMessagesWindow(target.channelId, initialWindow, target.tag)
  const qualified = { ...proof.token, channelLineage: { parentChannelId: parent ?? undefined } }
  notifyManager.batch(() => {
    if (channel.serverId) registry.runtime.ws.actions.grantServerAccess(channel.serverId)
    registry.runtime.ws.actions.rememberChannelAccess(channel.serverId, channel.id, parent ?? undefined)
    publishCommunityChannelMetadata(client, { metadata: { ...channel, resourceComplete: true }, proof })
    if (entry.parent) publishCommunityChannelMetadata(client, { metadata: { ...entry.parent, resourceComplete: true }, proof })
    if (entry.peer) publishCommunityChannelMembersSnapshot(client, null, channel.id, "access", [entry.viewerId, entry.peer.id].map((userId) => ({
      channelId: channel.id, userId, relation: "access", source: "added", isCreator: channel.creatorId === userId, role: null, memberId: null,
    })), proof, [entry.peer])
    publishCommunityMessages(client, { channelId: channel.id, messages: entry.messages.map((message) => ({ ...message, resourceComplete: true })), proof })
    if (entry.opener) {
      publishCommunityMessages(client, { channelId: entry.opener.channelId, messages: [{ ...entry.opener, resourceComplete: true }], proof })
      client.setQueryData(communityKeys.message(entry.opener.id), entry.opener.id)
    }
    publishCommunityConversationReadState(client, entry.readState, entry.readStateRevision, proof)
    confirmCommunityConversationPresence(client, channel.id, proof)
    if (entry.forumFeed) {
      const page = normalizeThreadResources(channel.id, entry.forumFeed)
      publishCommunityForumFeed(client, channel.id, page, proof)
      const cached = client.getQueryData<{ pages: ForumFeedPage[]; pageParams: Array<string | null> }>(windowKey)
      if (!Array.isArray(cached?.pages) || !cached.pages.length || !Array.isArray(cached.pageParams) || cached.pages.length !== cached.pageParams.length || cached.pages.some(page => !Array.isArray(page.threads))) client.setQueryData(windowKey, { pages: [forumFeedWindow(page)], pageParams: [null] })
    }
    else {
      const cached = client.getQueryData<MessageWindowData>(windowKey)
      if (Array.isArray(cached?.pages) && cached.pages.length && Array.isArray(cached.pageParams) && cached.pages.length === cached.pageParams.length && cached.pages.every(page => Array.isArray(page.messages))) return
      const page = messageWindowPage({ ...entry.page, olderCursor: entry.page.olderCursor ?? undefined, newerCursor: entry.page.newerCursor ?? undefined, messages: entry.messages })
      client.setQueryData<MessageWindowData>(windowKey, { pages: [page], pageParams: [initialWindow as MessagesPageParam] })
    }
  })
  return { channelId: channel.id, source, initialWindow, windowKey, readStateAtEntry: entry.readState, readStateRevision: entry.readStateRevision, selection: entry.selection, access: entry.access, proof: qualified }
}

export function getQualifiedConversationEntry(client: QueryClient, channelId: string) {
  return client.getQueryCache().findAll({ queryKey: communityKeys.conversationEntries(channelId) })
    .map(query => query.state.data as ConversationEntryResource | undefined)
    .find(resource => resource?.channelId === channelId && isChannelMetadataTokenCurrent(resource.proof))
}

export function currentConversationReadState(client: QueryClient, channelId: string) {
  const registry = getCommunityDbRegistry(client)
  const row = client.getQueryData<ReadStateRow[]>(communityKeys.communityDbCollection(registry?.scopeId ?? "anon", "readStates"))?.find((row) => row.channelId === channelId)
    ?? registry?.collections.readStates.get(channelId)
  if (row) return row
  const clock = client.getQueryData<Array<{ revision: number }>>(communityKeys.communityDbCollection(registry?.scopeId ?? "anon", "readStateClock"))?.[0]
    ?? registry?.collections.readStateClock.get("account")
  return clock ? { channelId, lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0, observedRevision: clock.revision } : undefined
}

export function findConversationEntryWindow(client: QueryClient, target: ConversationEntryTarget, resource: ConversationEntryResource, pointer: CommunityReadStateResource) {
  if (!isChannelMetadataTokenCurrent(resource.proof) || resource.channelId !== target.channelId) return
  const registry = resource.proof.registry!
  const channel = client.getQueryData<ChannelRow[]>(communityKeys.communityDbCollection(registry.scopeId, "channels"))?.find((row) => row.id === target.channelId)
    ?? registry.collections.channels.get(target.channelId)
  if (!channel || channel.serverId !== target.serverId || channel.archived) return
  const rows = client.getQueryData<MessageRow[]>(communityKeys.communityDbCollection(registry.scopeId, "messages"))
  const messages = rows ? new Map(rows.map((row) => [row.id, row])) : registry.collections.messages
  if (channel.type === "forum" && !target.anchorMessageId) {
    const key = communityKeys.forumFeed(channel.id, target.tag ?? null)
    const feed = client.getQueryData<{ pages: ForumFeedPage[]; pageParams: Array<string | null> }>(key)
    if (!feed?.pages.length || !Array.isArray(feed.pageParams) || feed.pages.length !== feed.pageParams.length) return
    const channels = client.getQueryData<ChannelRow[]>(communityKeys.communityDbCollection(registry.scopeId, "channels"))
    const byId = channels ? new Map(channels.map(row => [row.id, row])) : registry.collections.channels
    if (feed.pages.some(page => !Array.isArray(page.threads) || page.threads.some(thread => byId.get(thread.id)?.parentChannelId !== channel.id || !!thread.openerMessageId && messages.get(thread.openerMessageId)?.resourceComplete !== true))) return
    return { key, initial: { mode: "newest" as const }, tag: target.tag ?? null }
  }
  const anchor = target.anchorMessageId ?? (target.preferTail ? null : pointer.lastReadMessageId)
  const windows = client.getQueryCache().findAll({ queryKey: communityKeys.channelMessages(target.channelId) })
    .sort((left, right) => Number(hashKey(right.queryKey) === hashKey(resource.windowKey)) - Number(hashKey(left.queryKey) === hashKey(resource.windowKey)) || right.state.dataUpdatedAt - left.state.dataUpdatedAt)
  for (const window of windows) {
    const identity = messageWindowIdentity(window.queryKey)
    if (!identity || identity.tag !== (target.tag ?? null) || identity.initial.mode === "since") continue
    const data = window.state.data as MessageWindowData | undefined
    if (!Array.isArray(data?.pages) || !Array.isArray(data.pageParams) || !data.pages.length || data.pageParams.length !== data.pages.length || data.pages.some((page) => !Array.isArray(page.messages))) continue
    const ids = data.pages.flatMap((page) => page.messages.map((message) => message.id))
    if (ids.length && !ids.some((id) => messages.get(id)?.resourceComplete === true)) continue
    const anchored = !!anchor && ids.includes(anchor) && messages.get(anchor)?.resourceComplete === true
    const missingPointer = !target.anchorMessageId && pointer.lastReadMessageId === resource.readStateAtEntry.lastReadMessageId && resource.selection.reason === "read_pointer_missing"
      && hashKey(window.queryKey) === hashKey(resource.windowKey) && identity.initial.mode === "newest" && data.pages[0].hasMoreNewer === false
    if (anchor ? !anchored && !missingPointer : data.pages[0].hasMoreNewer !== false) continue
    return { key: window.queryKey, initial: identity.initial, tag: identity.tag }
  }
}

export function knownConversationLatestSeq(client: QueryClient, channelId: string) {
  return Math.max(0, ...getCanonicalCommunityAttentionScopes(client)
    .filter(scope => scope.channelId === channelId)
    .map(scope => Math.max(scope.lastUnreadSeq, scope.lastAttentionSeq ?? 0)))
}

export function conversationEntryOptions(client: QueryClient, target: ConversationEntryTarget, observation?: ApiRequestOptions["observation"]) {
  const qualification = captureCommunityLiveSnapshotToken(client, target.channelId)
  const queryKey = communityKeys.conversationEntry(target.channelId, target, {
    accountEpoch: qualification.accountEpoch, accessEpoch: qualification.accessEpoch,
    channelGeneration: qualification.channelScopes.get(target.channelId)?.generation ?? 0,
  })
  const cached = client.getQueryData<ConversationEntryResource>(queryKey)
  const knownPointer = cached && isChannelMetadataTokenCurrent(cached.proof) ? currentConversationReadState(client, target.channelId) : undefined
  return queryOptions<ConversationEntryResource>({
    queryKey,
    queryFn: async ({ signal }) => {
      const token = captureCommunityLiveSnapshotToken(client, target.channelId)
      const original = client.getQueryCache().find({ queryKey, exact: true })
      const assert = () => {
        assertCommunityLiveSnapshotTokenCurrent(client, token, signal)
        if (!original || client.getQueryCache().get(original.queryHash) !== original) throw new DOMException("Replaced conversation entry", "AbortError")
      }
      const search = new URLSearchParams({ entry: "1" })
      if (target.anchorMessageId) search.set("anchor", target.anchorMessageId)
      else if (target.preferTail) search.set("window", "tail")
      if (target.tag) search.set("tag", target.tag)
      const expectedPath = target.serverId === null ? `/c/me/${encodeURIComponent(target.channelId)}` : channelHref(target.serverId, target.channelId)
      const action = typeof window !== "undefined" && window.location.pathname === expectedPath ? navigationForHref(window.location.pathname + window.location.search) : undefined
      const captured = observation ?? (typeof window === "undefined" || window.location.pathname !== expectedPath ? { page: undefined, reason: "unknown" as const }
        : action && !action.done ? { action, reason: "foreground" as const } : { page: currentPageObservation(), reason: "background" as const })
      let entry: CommunityConversationEntryRead
      try {
        entry = await withConversationReadDeadline(signal, (readSignal) => apiFetch<CommunityConversationEntryRead>(
          `/api/community/channels/${encodeURIComponent(target.channelId)}/messages?${search}`,
          { ...communityRequestOptions(client, token, readSignal, assert), headers: { [COMMUNITY_CONTRACT_HEADER]: "3" }, observation: captured },
        ))
        assert()
      } catch (error) {
        assert()
        if (error instanceof ApiError && (error.status === 403 || error.status === 404) && !isConversationAnchorMissingError(error)) retireCommunityChannelReading(token.registry!, target.channelId, { reason: "read-denied", serverId: target.serverId, preserveQuery: original })
        throw error
      }
      assert()
      const initial: InitialMessageWindow = entry.selection.anchorMessageId
        ? { mode: "anchor", anchor: entry.selection.anchorMessageId } : { mode: "newest" }
      const windowKey = communityKeys.channelMessagesWindow(target.channelId, initial, target.tag)
      const hadWindow = !!client.getQueryData<MessageWindowData>(windowKey)?.pages.length
      const resource = publishConversationEntry(client, target, entry, { token, signal })
      if (hadWindow && !entry.forumFeed) {
        await reconcileConversationLanding(client, {
          kind: target.serverId === null ? "dm" : "channel", scopeId: target.channelId,
          serverId: target.serverId ?? undefined,
        }, resource.windowKey, { ...entry.page, olderCursor: entry.page.olderCursor ?? undefined, newerCursor: entry.page.newerCursor ?? undefined, messages: entry.messages }, initial)
        assert()
      }
      return resource
    },
    staleTime: (query) => {
      const resource = query.state.data
      if (!resource) return 0
      const pointer = knownPointer && resource.readStateRevision <= (knownPointer.observedRevision ?? -1) ? knownPointer : resource.readStateAtEntry
      const window = findConversationEntryWindow(client, target, resource, pointer)
      if (!window) return 0
      if (!target.anchorMessageId && !target.tag && messageWindowIdentity(window.key)) {
        const cachedWindow = client.getQueryData<MessageWindowData>(window.key)!
        const observedLatest = Math.max(0, ...cachedWindow.pages.map(page => page.latestSeq ?? 0))
        if (knownConversationLatestSeq(client, target.channelId) > observedLatest) return 0
      }
      return 5_000
    },
    gcTime: typeof window === "undefined" ? Infinity : 5 * 60 * 1000,
    retry: target.serverId === null ? false : retryConversationRead,
    retryOnMount: false,
    networkMode: "always",
  })
}
