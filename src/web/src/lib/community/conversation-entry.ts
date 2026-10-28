import { COMMUNITY_RESOURCE_CONTRACT_VERSION } from "@alook/shared"
import { reconcileConversationLanding } from "@/hooks/community/community-ws/reconnect-messages"
import { channelHref } from "./community-route"
import { actionAttributes, currentPageObservation, navigationForHref } from "@/lib/observability/context"
import { emitTelemetry, isTelemetryEligible, telemetryGeneration } from "@/lib/observability/telemetry"
import { hashKey, notifyManager, queryOptions, type QueryClient, type QueryKey } from "@tanstack/react-query"
import { COMMUNITY_CONTRACT_HEADER, CommunityConversationEntryReadSchema, type CommunityConversationEntryRead, type CommunityReadStateResource } from "@alook/shared"
import { apiFetch, type ApiRequestOptions } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { communityRequestOptions } from "./account-cache-lifecycle"
import { isChannelMetadataTokenCurrent } from "./conversation-qualification"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { channelMembershipKey, type ReadStateRow } from "@/lib/community-db/schema"
import { ApiError, CommunityApiError } from "@/lib/errors"
import {
  assertCommunityLiveSnapshotTokenCurrent, captureCommunityLiveSnapshotToken,
  publishCommunityChannelMetadata, publishCommunityChannelMembersSnapshot, publishCommunityConversationReadState, confirmCommunityConversationPresence,
  publishCommunityMessages, getCanonicalCommunityMessageResources, validateCommunityMessagePublication, retireCommunityChannelReading, type CommunityFreshQueryProof,
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

export type ConversationWindowScope = Pick<ConversationEntryResource, "channelId" | "proof">
  & Partial<Pick<ConversationEntryResource, "windowKey" | "readStateAtEntry" | "selection">>

export function assessConversationScope(client: QueryClient, target: ConversationEntryTarget) {
  const registry = getCommunityDbRegistry(client)
  if (!registry?.accountId || registry.sessionViewer() !== registry.accountId || registry.runtime.ws.get().profileViewerId !== registry.accountId) return { reason: "account_unknown" as const }
  if (!registry.runtime.lifecycle.get().active) return { reason: "owner_retired" as const }
  const channel = registry.collections.channels.get(target.channelId)
  if (registry.runtime.ws.actions.isChannelAccessRevoked(target.channelId, target.serverId, channel?.parentChannelId ?? undefined)) return { reason: "revoked" as const }
  if (!channel) return { reason: "metadata_missing" as const }
  if (channel.pending) return { reason: "metadata_incomplete" as const }
  if (channel.archived) return { reason: "archived" as const }
  if (channel.serverId !== target.serverId || (target.serverId === null ? channel.type !== "dm" : channel.type === "dm")) return { reason: "scope_mismatch" as const }
  const parent = channel.parentChannelId
    ? registry.collections.channels.get(channel.parentChannelId) : undefined
  if (channel.type !== "thread" && channel.parentChannelId) return { reason: "scope_mismatch" as const }
  if (channel.type === "thread") {
    if (!parent || parent.pending) return { reason: "parent_missing" as const }
    if (parent.archived || parent.serverId !== target.serverId || parent.type !== "text" && parent.type !== "forum" || !channel.parentMessageId) return { reason: "parent_mismatch" as const }
  }
  const access = (id: string) => !!registry.collections.channelMemberships.get(channelMembershipKey(id, registry.accountId!, "access"))
  if (!access(channel.id) || parent && !access(parent.id)) return { reason: "access_missing" as const }
  const proof = { ...captureCommunityLiveSnapshotToken(client, channel.id), channelLineage: { parentChannelId: channel.parentChannelId } }
  if (!isChannelMetadataTokenCurrent(proof)) return { reason: "owner_retired" as const }
  return { reason: "qualified" as const, scope: { channelId: channel.id, proof } satisfies ConversationWindowScope }
}

export function getQualifiedConversationScope(client: QueryClient, target: ConversationEntryTarget): ConversationWindowScope | undefined {
  return assessConversationScope(client, target).scope
}

export function publishConversationEntry(
  client: QueryClient,
  target: ConversationEntryTarget,
  value: CommunityConversationEntryRead,
  proof: CommunityFreshQueryProof,
  source: "rsc" | "network" = "network",
): ConversationEntryResource {
  assertCommunityLiveSnapshotTokenCurrent(client, proof.token, proof.signal)
  const entry = CommunityConversationEntryReadSchema.parse(value)
  const channel = entry.channel
  if (entry.viewerId !== proof.token.viewerId || proof.token.channelId !== target.channelId || entry.channelId !== target.channelId || channel.serverId !== target.serverId
    || (target.serverId === null ? channel.type !== "dm" : channel.type === "dm")
    || target.anchorMessageId && (entry.selection.reason !== "explicit_anchor" || entry.selection.anchorMessageId !== target.anchorMessageId)) throw new Error("Conversation entry target mismatch")
  const registry = proof.token.registry!
  const parent = channel.parentChannelId
  if (parent && (registry.runtime.ws.get().channelAccessScopes.get(parent)?.generation ?? 0) !== (proof.token.channelScopes.get(parent)?.generation ?? 0)) throw new DOMException("Retired conversation parent", "AbortError")
  validateCommunityMessagePublication(registry, entry.messages, entry.profiles)
  if (entry.opener) validateCommunityMessagePublication(registry, [entry.opener], entry.profiles)
  if (entry.forumFeed) validateCommunityMessagePublication(registry, entry.forumFeed.included.messages, entry.forumFeed.included.profiles)
  const initialWindow: InitialMessageWindow = entry.selection.anchorMessageId ? { mode: "anchor", anchor: entry.selection.anchorMessageId } : { mode: "newest" }
  const windowKey = entry.forumFeed ? communityKeys.forumFeed(target.channelId, target.tag ?? null) : communityKeys.channelMessagesWindow(target.channelId, initialWindow, target.tag)
  const qualified = { ...proof.token, channelLineage: { parentChannelId: parent } }
  notifyManager.batch(() => {
    if (channel.serverId) registry.runtime.ws.actions.grantServerAccess(channel.serverId)
    registry.runtime.ws.actions.rememberChannelAccess(channel.serverId, channel.id, parent ?? undefined)
    publishCommunityChannelMetadata(client, { metadata: channel, proof })
    if (entry.parent) publishCommunityChannelMetadata(client, { metadata: entry.parent, proof })
    if (entry.peer) publishCommunityChannelMembersSnapshot(client, null, channel.id, "access", [entry.viewerId, entry.peer.id].map((userId) => ({
      channelId: channel.id, userId, relation: "access", source: "added", isCreator: channel.creatorId === userId, role: null, memberId: null,
    })), proof, [entry.peer])
    publishCommunityMessages(client, { channelId: channel.id, messages: entry.messages, profiles: entry.profiles, proof })
    if (entry.opener) {
      publishCommunityMessages(client, { channelId: entry.opener.channelId, messages: [entry.opener], profiles: entry.profiles, proof })
      client.setQueryData(communityKeys.message(entry.opener.id), entry.opener.id)
    }
    publishCommunityConversationReadState(client, entry.readState, entry.readStateRevision, proof)
    confirmCommunityConversationPresence(client, channel.id, proof)
    if (entry.forumFeed) {
      const page = normalizeThreadResources(channel.id, entry.forumFeed)
      publishCommunityForumFeed(client, channel.id, page, proof)
      if (!conversationDisplayWindows(client, target, { channelId: channel.id, proof: qualified, windowKey })?.some(window => hashKey(window.key) === hashKey(windowKey))) client.setQueryData(windowKey, { pages: [forumFeedWindow(page)], pageParams: [null] })
    }
    else {
      if (conversationDisplayWindows(client, target, { channelId: channel.id, proof: qualified, windowKey })?.some(window => hashKey(window.key) === hashKey(windowKey))) return
      const page = messageWindowPage({ ...entry.page, olderCursor: entry.page.olderCursor ?? undefined, newerCursor: entry.page.newerCursor ?? undefined, messages: entry.messages, profiles: entry.profiles })
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

function conversationDisplayWindows(client: QueryClient, target: ConversationEntryTarget, resource: ConversationWindowScope) {
  if (!isChannelMetadataTokenCurrent(resource.proof) || resource.channelId !== target.channelId) return
  const registry = resource.proof.registry!
  const channel = registry.collections.channels.get(target.channelId)
  if (!channel || channel.serverId !== target.serverId || channel.archived) return
  const messages = registry.collections.messages
  if (channel.type === "forum" && !target.anchorMessageId) {
    const key = communityKeys.forumFeed(channel.id, target.tag ?? null)
    const feed = client.getQueryData<{ pages: ForumFeedPage[]; pageParams: Array<string | null> }>(key)
    if (!Array.isArray(feed?.pages) || !feed.pages.length || !Array.isArray(feed.pageParams) || feed.pages.length !== feed.pageParams.length) return
    const byId = registry.collections.channels
    if (feed.pages.some(page => !Array.isArray(page?.threads) || page.threads.some(thread => {
      if (!thread || typeof thread.id !== "string" || !thread.id) return true
      const child = byId.get(thread.id)
      const opener = thread.openerMessageId ? messages.get(thread.openerMessageId) : undefined
      return !child || child.type !== "thread" || child.serverId !== channel.serverId || child.parentChannelId !== channel.id
        || !!thread.openerMessageId && (!opener || opener.channelId !== channel.id)
    }))) return
    const retained = feed.pages.flatMap(page => page.threads.flatMap(thread => {
      const child = byId.get(thread.id)
      return [thread.openerMessageId ? messages.get(thread.openerMessageId) : undefined, child?.firstMessageId ? messages.get(child.firstMessageId) : undefined].filter(message => message !== undefined)
    }))
    if (!getCanonicalCommunityMessageResources(client, retained)) return
    return [{ key, initial: { mode: "newest" as const }, tag: target.tag ?? null }]
  }
  const windows = client.getQueryCache().findAll({ queryKey: communityKeys.channelMessages(target.channelId) })
    .sort((left, right) => Number(hashKey(right.queryKey) === hashKey(resource.windowKey ?? [])) - Number(hashKey(left.queryKey) === hashKey(resource.windowKey ?? [])) || right.state.dataUpdatedAt - left.state.dataUpdatedAt)
  return windows.flatMap(window => {
    const identity = messageWindowIdentity(window.queryKey)
    if (!identity || identity.tag !== (target.tag ?? null) || identity.initial.mode === "since") return []
    const data = window.state.data as MessageWindowData | undefined
    if (!Array.isArray(data?.pages) || !Array.isArray(data.pageParams) || !data.pages.length || data.pageParams.length !== data.pages.length || data.pages.some((page) => !Array.isArray(page?.messages) || page.messages.some(message => typeof message?.id !== "string" || !message.id))) return []
    const ids = data.pages.flatMap((page) => page.messages.map((message) => message.id))
    if (ids.some(id => messages.get(id)?.channelId !== target.channelId)) return []
    if (!getCanonicalCommunityMessageResources(client, ids.map(id => messages.get(id)))) return []
    return [{ key: window.queryKey, initial: identity.initial, tag: identity.tag }]
  })
}

export function findConversationDisplayWindow(client: QueryClient, target: ConversationEntryTarget, scope: ConversationWindowScope) {
  return conversationDisplayWindows(client, target, scope)?.[0]
}

export function findConversationEntryWindow(client: QueryClient, target: ConversationEntryTarget, resource: ConversationWindowScope, pointer: CommunityReadStateResource | undefined) {
  if (!pointer && !target.anchorMessageId) return
  const anchor = target.anchorMessageId ?? (target.preferTail ? null : pointer?.lastReadMessageId)
  return conversationDisplayWindows(client, target, resource)?.find(window => {
    if (!messageWindowIdentity(window.key)) return true
    const data = client.getQueryData<MessageWindowData>(window.key)!
    const anchored = !!anchor && data.pages.some(page => page.messages.some(message => message.id === anchor))
    const missingPointer = !target.anchorMessageId && pointer?.lastReadMessageId === resource.readStateAtEntry?.lastReadMessageId && resource.selection?.reason === "read_pointer_missing"
      && hashKey(window.key) === hashKey(resource.windowKey ?? []) && window.initial.mode === "newest" && data.pages[0].hasMoreNewer === false
    return anchor ? anchored || missingPointer : data.pages[0].hasMoreNewer === false
  })
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
      const generation = telemetryGeneration()
      const observed = isTelemetryEligible()
      const record = (entry_stage: "start" | "validated" | "published" | "delivered" | "error" | "cancelled") => {
        if (observed && generation === telemetryGeneration()) emitTelemetry("conversation.entry", {
          ...actionAttributes(captured?.action ?? captured?.page), entry_stage, request_role: "entry",
          window_mode: target.anchorMessageId ? "anchor" : "newest",
        })
      }
      record("start")
      try {
        const entry = await withConversationReadDeadline(signal, (readSignal) => apiFetch<CommunityConversationEntryRead>(
          `/api/community/channels/${encodeURIComponent(target.channelId)}/messages?${search}`,
          { ...communityRequestOptions(client, token, readSignal, assert), headers: { [COMMUNITY_CONTRACT_HEADER]: String(COMMUNITY_RESOURCE_CONTRACT_VERSION) },
            observation: { ...captured, role: "entry", windowMode: target.anchorMessageId ? "anchor" : "newest" } },
        ))
        assert()
        const initial: InitialMessageWindow = entry.selection.anchorMessageId
          ? { mode: "anchor", anchor: entry.selection.anchorMessageId } : { mode: "newest" }
        const windowKey = communityKeys.channelMessagesWindow(target.channelId, initial, target.tag)
        const hadWindow = !!client.getQueryData<MessageWindowData>(windowKey)?.pages.length
        const resource = publishConversationEntry(client, target, entry, { token, signal })
        record("validated")
        record("published")
        if (hadWindow && !entry.forumFeed) {
          void reconcileConversationLanding(client, {
            kind: target.serverId === null ? "dm" : "channel", scopeId: target.channelId,
            serverId: target.serverId ?? undefined,
          }, resource.windowKey, { ...entry.page, olderCursor: entry.page.olderCursor ?? undefined, newerCursor: entry.page.newerCursor ?? undefined, messages: entry.messages, profiles: entry.profiles }, initial,
          { query: original!, signal, lifetime: "query", observation: captured }).catch(() => undefined)
        }
        record("delivered")
        return resource
      } catch (error) {
        const current = !signal.aborted && isChannelMetadataTokenCurrent(token)
          && !!original && client.getQueryCache().get(original.queryHash) === original
        record(!current || error instanceof Error && error.name === "AbortError" ? "cancelled" : "error")
        assert()
        if (error instanceof ApiError && (error.status === 403 || error.status === 404) && !isConversationAnchorMissingError(error)) retireCommunityChannelReading(token.registry!, target.channelId, { reason: "read-denied", serverId: target.serverId, preserveQuery: original,
          ...(error instanceof CommunityApiError ? { denialCode: error.code } : {}) })
        throw error
      }
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
