"use client"

import { useConversationPresentation } from "@/contexts/view-activity"
import { useCallback, useEffect, useMemo, useState } from "react"
import { createStore, useAtom, useCreateAtom } from "@tanstack/react-store"
import { useInfiniteQuery, useIsMutating, useQueryClient, type Query } from "@tanstack/react-query"
import { compareAsciiSqliteBinary, DEFAULT_MESSAGE_PAGE_SIZE, type CommunityThreadsRead } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { ConversationReadTimeoutError, conversationReadRetryPolicy, withConversationReadDeadline } from "@/lib/community/conversation-read"
import { conversationListScopeKey } from "@/lib/community/conversation-qualification"
import { communityKeys } from "@/lib/query-keys"
import { isAbortError } from "@/lib/errors"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useCanonicalIdentitiesByUserId, useCanonicalMessagesById, useChildChannelsByParentId } from "@/lib/community-db/projections"
import { assertCommunityLiveSnapshotTokenCurrent, captureCommunityLiveSnapshotToken, publishCommunityForumFeed } from "@/lib/community-db/sync"
import { forumTagFromUrl, validateForumTagSelection, writeForumTagSelection } from "@/lib/community/forum-tag-selection"
import { messageProfileIds, type ForumThread, type Msg } from "@/lib/community/models/message"
import type { ChannelRow } from "@/lib/community-db/schema"
import { readCommunityProfile } from "@/lib/community/profile-read"
import { useForumTags } from "./use-channel-panels"
import { useStoredForumTag } from "./use-stored-forum-tag"
import { createSharedConversationResource, useConversationResource } from "./use-conversation-entry"
import { forumFeedMatchesTags, forumFeedWindow, normalizeThreadResources, projectForumThread, type ForumFeedPage } from "@/lib/community/forum-feed-window"

const MAX_FORUM_FEED_PAGES = 6

export { removeForumPostFromFeed } from "@/lib/community/forum-feed-window"
export type { ForumFeedPage } from "@/lib/community/forum-feed-window"

type ForumReadProtocol = {
  operation: Promise<unknown> | undefined
  token: ReturnType<typeof captureCommunityLiveSnapshotToken>
  publishedIds: ReadonlySet<string>
}
const forumReads = new WeakMap<Query, ReturnType<typeof createStore<ForumReadProtocol>>>()

function beginForumRead(queryClient: ReturnType<typeof useQueryClient>, channelId: string, tag: string | null) {
  const resource = queryClient.getQueryCache().find({ queryKey: communityKeys.forumFeed(channelId, tag), exact: true })
  const existing = resource ? forumReads.get(resource) : undefined
  if (existing && existing.get().operation === resource!.promise) return existing
  const cached = resource?.state.data as { pages: ForumFeedPage[] } | undefined
  const protocol = createStore<ForumReadProtocol>({ operation: resource?.promise, token: captureCommunityLiveSnapshotToken(queryClient, channelId), publishedIds: new Set(resource?.state.fetchMeta?.fetchMore ? cached?.pages.flatMap((page) => page.threads.map((thread) => thread.id)) : []) })
  if (resource) forumReads.set(resource, protocol)
  return protocol
}

export function forumFeedPageQueryFn(channelId: string, tag: string | null, queryClient: ReturnType<typeof useQueryClient>) {
  return ({ pageParam, signal }: { pageParam: string | null; signal?: AbortSignal }) => withConversationReadDeadline(signal, async (readSignal) => {
    const protocol = beginForumRead(queryClient, channelId, tag)
    const token = protocol.get().token, registry = getCommunityDbRegistry(queryClient)
    await registry?.ready
    const resource = queryClient.getQueryCache().find({ queryKey: communityKeys.forumFeed(channelId, tag), exact: true })
    if (resource && forumReads.get(resource) === protocol && protocol.get().operation === undefined) protocol.setState((state) => ({ ...state, operation: resource.promise }))
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, readSignal)
    await Promise.all([registry!.collections.channels.preload(), registry!.collections.messages.preload(), registry!.collections.channelMemberships.preload(), registry!.collections.profiles.preload()])
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, readSignal)
    const params = new URLSearchParams({ order: "createdAt", limit: String(DEFAULT_MESSAGE_PAGE_SIZE), include: "parentMessage,firstMessage,tags,participants" })
    if (tag) params.set("tag", tag)
    if (pageParam) params.set("cursor", pageParam)
    const request = communityRequestOptions(queryClient, token, readSignal)
    const transport = await apiFetch<CommunityThreadsRead>(`/api/community/channels/${channelId}/threads?${params}`, request)
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, readSignal)
    const page = normalizeThreadResources(channelId, transport)
    const freshThreads = page.threads.filter((thread) => !protocol.get().publishedIds.has(thread.id))
    const ids = new Set(freshThreads.map((thread) => thread.id)), openerIds = new Set(freshThreads.map((thread) => thread.parentMessageId))
    const rootSet = new Set<typeof page.included.messages[number]>()
    const replyChannelsById = new Map<string, Set<string>>()
    for (const message of page.included.messages) {
      if (openerIds.has(message.id) || ids.has(message.channelId)) {
        rootSet.add(message)
        if (message.replyToId) {
          let channels = replyChannelsById.get(message.replyToId)
          if (!channels) { channels = new Set(); replyChannelsById.set(message.replyToId, channels) }
          channels.add(message.channelId)
        }
      }
    }
    const messages = page.included.messages.filter((message) => rootSet.has(message) || replyChannelsById.get(message.id)?.has(message.channelId) === true)
    const users = new Set([...page.included.members.filter((member) => ids.has(member.channelId)).map((member) => member.userId), ...messages.flatMap(messageProfileIds)])
    await publishCommunityForumFeed(queryClient, channelId, { ...page, threads: freshThreads, included: {
      messages,
      previews: page.included.previews.filter((message) => ids.has(message.channelId)),
      tags: page.included.tags.filter((row) => openerIds.has(row.messageId)),
      members: page.included.members.filter((row) => ids.has(row.channelId)),
      profiles: page.included.profiles.filter((profile) => users.has(profile.id)),
      participantCounts: page.included.participantCounts.filter((row) => ids.has(row.channelId)),
    } }, { token, signal: readSignal })
    protocol.setState((state) => ({ ...state, publishedIds: new Set([...state.publishedIds, ...ids]) }))
    return forumFeedWindow(page)
  })
}

export function mapForumFeedPages(pages: ForumFeedPage[], messages: ReadonlyMap<string, Msg>, channels: ReadonlyMap<string, ChannelRow>, profiles: ReturnType<typeof useCanonicalIdentitiesByUserId>, filter: string | null = null): ForumThread[] {
  const byId = new Map<string, ForumThread>()
  for (const page of pages) for (const window of page.threads) {
    if (byId.has(window.id)) continue
    const thread = channels.get(window.id), opener = window.openerMessageId ? messages.get(window.openerMessageId) : undefined
    if (!thread || !opener || thread.parentMessageId !== opener.id || !forumFeedMatchesTags(filter, thread.tags)) continue
    const first = thread.firstMessageId ? messages.get(thread.firstMessageId) : undefined
    const participants = window.participantIds.map((id) => {
      const profile = readCommunityProfile(profiles.get(id), id)
      return { id, name: profile.name, avatar: profile.avatar, avatarVersion: profile.avatarVersion }
    })
    byId.set(thread.id, projectForumThread(thread, opener, first, participants))
  }
  return [...byId.values()].sort((a, b) => compareAsciiSqliteBinary(channels.get(b.id)?.createdAt ?? "", channels.get(a.id)?.createdAt ?? "") || compareAsciiSqliteBinary(b.id, a.id))
}

export function useForumFeed(serverId: string, channelId: string, options?: { routeTag?: string | null; onSelectTag?: (tag: string) => void }) {
  const presented = useConversationPresentation()
  const queryClient = useQueryClient()
  const persistedTag = useStoredForumTag(channelId)
  const routeTag = forumTagFromUrl(options?.routeTag)
  const [fallbackSelection, setFallbackSelection] = useAtom(useCreateAtom<{ channelId: string | null; tag: string }>({ channelId: null, tag: "All" }))
  const resolvedTag = routeTag ?? (fallbackSelection.channelId === channelId ? fallbackSelection.tag : persistedTag)
  const selectionReady = resolvedTag !== null
  const tag = resolvedTag ?? "All"
  const onSelectTag = options?.onSelectTag
  const selectTag = useCallback((next: string) => {
    try {
      writeForumTagSelection(window.localStorage, channelId, next)
      setFallbackSelection({ channelId: null, tag: "All" })
    } catch { setFallbackSelection({ channelId, tag: next }) }
    onSelectTag?.(next)
  }, [channelId, onSelectTag, setFallbackSelection])
  const tagsQuery = useForumTags(channelId, presented)
  const tagsError = tagsQuery.isEnabled && tagsQuery.isLoadingError && tagsQuery.fetchStatus === "idle" && !isAbortError(tagsQuery.error)
  const pendingTagCommands = useIsMutating({ mutationKey: ["community", "forum-tag-command"], exact: true, predicate: (mutation) => {
    const args = mutation.state.variables as { serverId?: string; forumChannelId?: string } | undefined
    return args?.serverId === serverId && args.forumChannelId === channelId
  } })
  useEffect(() => { if (selectionReady && !pendingTagCommands && tagsQuery.isSuccess && !tagsQuery.isFetching && tagsQuery.data.observed === true && tag !== "All" && validateForumTagSelection(tag, tagsQuery.data.tags) === "All") selectTag("All") }, [selectionReady, pendingTagCommands, tag, tagsQuery.isSuccess, tagsQuery.isFetching, tagsQuery.data, selectTag])
  const selectedTag = tag === "All" ? null : tag
  const entryTarget = useMemo(
    () => (selectionReady ? { channelId, serverId, tag: selectedTag } : null),
    [channelId, selectedTag, selectionReady, serverId],
  )
  const entry = useConversationResource(entryTarget, null, "forum")
  const sharedResource = useMemo(
    () => createSharedConversationResource(entryTarget, null, true, entry),
    [entry, entryTarget],
  )
  const canRead = entry.canRead
  const queryKey = communityKeys.forumFeed(canRead ? channelId : "__none__", selectedTag)
  const query = useInfiniteQuery({ queryKey, queryFn: forumFeedPageQueryFn(channelId, selectedTag, queryClient), initialPageParam: null as string | null, maxPages: MAX_FORUM_FEED_PAGES, getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.nextCursor : undefined,
    enabled: presented && selectionReady && canRead && !entry?.verificationFetching && (!entry?.verificationFailed || entry?.displayWindow !== undefined), subscribed: selectionReady && canRead, staleTime: 5_000,
    retry: conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey }).retry), networkMode: "always" })
  const displayCandidate = selectionReady && canRead && entry?.displayWindow !== undefined
  const channels = useChildChannelsByParentId(channelId, displayCandidate)
  const participantIds = useMemo(() => [...new Set(displayCandidate ? query.data?.pages.flatMap((page) => page.threads.flatMap((thread) => thread.participantIds)) ?? [] : [])], [displayCandidate, query.data?.pages])
  const profiles = useCanonicalIdentitiesByUserId(participantIds, displayCandidate && participantIds.length > 0)
  const messageIds = useMemo(() => [...new Set(displayCandidate ? query.data?.pages.flatMap((page) => page.threads.flatMap((thread) => [...(thread.openerMessageId ? [thread.openerMessageId] : []), ...(channels.get(thread.id)?.firstMessageId ? [channels.get(thread.id)!.firstMessageId!] : [])])) ?? [] : [])], [displayCandidate, query.data?.pages, channels])
  const messages = useCanonicalMessagesById(messageIds)
  const displayReady = displayCandidate && query.data !== undefined && messageIds.every(id => messages?.has(id))
    && query.data.pages.every(page => page.threads.every(thread => channels.has(thread.id) && thread.participantIds.every(id => profiles.has(id))))
  const posts = useMemo(() => displayReady ? mapForumFeedPages(query.data?.pages ?? [], messages ?? new Map(), channels, profiles, selectedTag) : [], [displayReady, query.data?.pages, messages, channels, profiles, selectedTag])
  const projectionScope = JSON.stringify([queryKey, entry?.scope ? conversationListScopeKey({ proof: entry.scope.proof, tag: selectedTag }) : null])
  const hasWindowData = query.data !== undefined
  const [retryAttempt, setRetryAttempt] = useState(0)
  const [projectionFailure, setProjectionFailure] = useState<{ scope: string; attempt: number; error: Error } | null>(null)
  useEffect(() => {
    if (!presented || !canRead || !hasWindowData || displayReady) return
    const controller = new AbortController()
    void withConversationReadDeadline(controller.signal, () => new Promise<never>(() => {})).catch(error => {
      if (!controller.signal.aborted && error instanceof ConversationReadTimeoutError) setProjectionFailure({ scope: projectionScope, attempt: retryAttempt, error })
    })
    return () => controller.abort()
  }, [presented, canRead, hasWindowData, projectionScope, retryAttempt, displayReady])
  const initialLoadError = !displayReady && projectionFailure?.scope === projectionScope && projectionFailure?.attempt === retryAttempt
    ? projectionFailure.error : null
  const pending = !displayReady && !initialLoadError && !query.isError && !entry?.verificationFailed && !entry?.denied
  const refetchQuery = query.refetch
  const refetch = useCallback((...args: Parameters<typeof refetchQuery>) => {
    setRetryAttempt(attempt => attempt + 1)
    return refetchQuery(...args)
  }, [refetchQuery])
  const fetchNextPage = query.fetchNextPage
  const entryWindowReady = entry?.windowReady ?? false
  const fetchOlder = useCallback(() => { if (presented && displayReady && entryWindowReady) void fetchNextPage({ cancelRefetch: false }) }, [fetchNextPage, presented, displayReady, entryWindowReady])
  return { ...query, refetch, isPending: pending, isLoading: pending, displayReady, initialLoadError,
    posts, tag, selectionReady, selectTag, tagsKnown: tagsQuery.data !== undefined, tagsError, retryTags: tagsQuery.refetch, availableTags: tagsQuery.data?.tags ?? [], hasMoreOlder: displayReady && entryWindowReady && query.hasNextPage, isFetchingOlder: query.isFetchingNextPage, fetchOlder, sharedResource }
}
