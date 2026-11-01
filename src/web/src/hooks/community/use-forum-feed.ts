"use client"

import { useConversationPresentation } from "@/contexts/community/conversation-activity"
import { useCallback, useEffect, useMemo, useState } from "react"
import { createStore, useAtom, useCreateAtom } from "@tanstack/react-store"
import { useInfiniteQuery, useIsMutating, useQueryClient, type Query } from "@tanstack/react-query"
import { compareAsciiSqliteBinary, DEFAULT_MESSAGE_PAGE_SIZE, type CommunityThreadsRead } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { ConversationReadTimeoutError, conversationReadRetryPolicy, withConversationReadDeadline } from "@/lib/community/conversation-read"
import { conversationListScopeKey } from "@/lib/community/conversation-qualification"
import { communityKeys } from "@/lib/query-keys"
import { avatarInitial } from "@/lib/community/avatar"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useCanonicalChannelsById, useCanonicalMessagesById, useCanonicalProfilesByUserId } from "@/lib/community-db/projections"
import { assertCommunityLiveSnapshotTokenCurrent, captureCommunityLiveSnapshotToken, publishCommunityForumFeed } from "@/lib/community-db/sync"
import { forumTagFromUrl, validateForumTagSelection, writeForumTagSelection } from "@/lib/community/forum-tag-selection"
import { messageProfileIds, type ForumThread, type Msg } from "@/lib/community/models/message"
import type { ChannelRow } from "@/lib/community-db/schema"
import { readCommunityProfile } from "@/lib/community/profile-read"
import { channelHref } from "@/lib/community/community-route"
import { currentPageObservation, navigationForHref } from "@/lib/observability/context"
import { useForumTags } from "./use-channel-panels"
import { useStoredForumTag } from "./use-stored-forum-tag"
import { useConversationResource } from "./use-conversation-entry"
import { forumFeedMatchesTags, forumFeedWindow, normalizeThreadResources, projectThread, type ForumFeedPage } from "./forum-feed-window"

export { removeForumPostFromFeed } from "./forum-feed-window"
export type { ForumFeedPage } from "./forum-feed-window"

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
    const channel = registry!.collections.channels.get(channelId)
    const path = channel?.serverId ? channelHref(channel.serverId, channelId) : undefined
    const action = typeof window !== "undefined" && window.location.pathname === path ? navigationForHref(window.location.pathname + window.location.search) : undefined
    const observation = request.observation ?? (action && !action.done ? { action, reason: "foreground" as const }
      : typeof window !== "undefined" && window.location.pathname === path ? { page: currentPageObservation(), reason: "background" as const }
      : { page: undefined, reason: "unknown" as const })
    const transport = await apiFetch<CommunityThreadsRead>(`/api/community/channels/${channelId}/threads?${params}`, {
      ...request, observation: { ...observation, ...(pageParam ? { reason: "pagination" as const } : {}), role: pageParam ? "pagination" : "window", windowMode: pageParam ? "older" : "newest" },
    })
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, readSignal)
    const page = normalizeThreadResources(channelId, transport)
    const freshThreads = page.threads.filter((thread) => !protocol.get().publishedIds.has(thread.id))
    const ids = new Set(freshThreads.map((thread) => thread.id)), openerIds = new Set(freshThreads.map((thread) => thread.parentMessageId))
    const messages = page.included.messages.filter((message) => openerIds.has(message.id) || ids.has(message.channelId))
    const users = new Set([...page.included.members.filter((member) => ids.has(member.channelId)).map((member) => member.userId), ...messages.flatMap(messageProfileIds)])
    publishCommunityForumFeed(queryClient, channelId, { ...page, threads: freshThreads, included: {
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

export function mapForumFeedPages(pages: ForumFeedPage[], messages: ReadonlyMap<string, Msg>, channels: ReadonlyMap<string, ChannelRow>, profiles: ReturnType<typeof useCanonicalProfilesByUserId>, filter: string | null = null): ForumThread[] {
  const byId = new Map<string, ForumThread>()
  for (const page of pages) for (const window of page.threads) {
    if (byId.has(window.id)) continue
    const thread = channels.get(window.id), opener = window.openerMessageId ? messages.get(window.openerMessageId) : undefined
    if (!thread || !opener || thread.parentMessageId !== opener.id || !forumFeedMatchesTags(filter, thread.tags)) continue
    byId.set(thread.id, {
      ...projectThread(thread, opener, "forum"), authorId: opener.authorId ?? thread.creatorId ?? "",
      authorAvatar: opener.authorAvatar ?? avatarInitial(opener.authorName ?? ""), authorAvatarVersion: opener.authorAvatarVersion ?? 0,
      openerMessageId: opener.id, ...(opener.createdAt === undefined ? {} : { openerCreatedAt: opener.createdAt }), tags: thread.tags, preview: thread.preview ?? "",
      participants: window.participantIds.map((id) => { const profile = readCommunityProfile(profiles.get(id), id); return { id, name: profile.name, avatar: profile.avatar, avatarVersion: profile.avatarVersion } }), participantCount: thread.participantCount ?? 0,
    })
  }
  return [...byId.values()].sort((a, b) => compareAsciiSqliteBinary(channels.get(b.id)?.createdAt ?? "", channels.get(a.id)?.createdAt ?? "") || compareAsciiSqliteBinary(b.id, a.id))
}

export function useForumFeed(serverId: string, channelId: string, options?: { routeTag?: string | null; onSelectTag?: (tag: string) => void }) {
  const presented = useConversationPresentation()
  const queryClient = useQueryClient(), channels = useCanonicalChannelsById(), profiles = useCanonicalProfilesByUserId()
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
  const pendingTagCommands = useIsMutating({ mutationKey: ["community", "forum-tag-command"], exact: true, predicate: (mutation) => {
    const args = mutation.state.variables as { serverId?: string; forumChannelId?: string } | undefined
    return args?.serverId === serverId && args.forumChannelId === channelId
  } })
  useEffect(() => { if (selectionReady && !pendingTagCommands && tagsQuery.isSuccess && tag !== "All" && validateForumTagSelection(tag, tagsQuery.data.tags) === "All") selectTag("All") }, [selectionReady, pendingTagCommands, tag, tagsQuery.isSuccess, tagsQuery.data, selectTag])
  const selectedTag = tag === "All" ? null : tag
  const entry = useConversationResource(selectionReady ? { channelId, serverId, tag: selectedTag } : null, null, false, "forum")
  const queryKey = communityKeys.forumFeed(entry.canRead ? channelId : "__none__", selectedTag)
  const query = useInfiniteQuery({ queryKey, queryFn: forumFeedPageQueryFn(channelId, selectedTag, queryClient), initialPageParam: null as string | null, getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.nextCursor : undefined,
    enabled: presented && selectionReady && entry.canRead && !entry.verificationFetching && (!entry.verificationFailed || entry.displayWindow !== undefined), subscribed: selectionReady && entry.canRead, staleTime: 5_000,
    retry: conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey }).retry), networkMode: "always" })
  const displayCandidate = selectionReady && entry.canRead && entry.displayWindow !== undefined
  const messageIds = useMemo(() => [...new Set(displayCandidate ? query.data?.pages.flatMap((page) => page.threads.flatMap((thread) => thread.openerMessageId ? [thread.openerMessageId] : [])) ?? [] : [])], [displayCandidate, query.data?.pages])
  const messages = useCanonicalMessagesById(messageIds)
  const displayReady = displayCandidate && query.data !== undefined && messageIds.every(id => messages?.has(id))
    && query.data.pages.every(page => page.threads.every(thread => channels.has(thread.id) && thread.participantIds.every(id => profiles.has(id))))
  const posts = useMemo(() => displayReady ? mapForumFeedPages(query.data?.pages ?? [], messages ?? new Map(), channels, profiles, selectedTag) : [], [displayReady, query.data?.pages, messages, channels, profiles, selectedTag])
  const projectionScope = JSON.stringify([queryKey, entry.scope ? conversationListScopeKey({ proof: entry.scope.proof, tag: selectedTag }) : null])
  const hasWindowData = query.data !== undefined
  const [retryAttempt, setRetryAttempt] = useState(0)
  const [projectionFailure, setProjectionFailure] = useState<{ scope: string; attempt: number; error: Error } | null>(null)
  useEffect(() => {
    if (!presented || !entry.canRead || !hasWindowData || displayReady) return
    const controller = new AbortController()
    void withConversationReadDeadline(controller.signal, () => new Promise<never>(() => {})).catch(error => {
      if (!controller.signal.aborted && error instanceof ConversationReadTimeoutError) setProjectionFailure({ scope: projectionScope, attempt: retryAttempt, error })
    })
    return () => controller.abort()
  }, [presented, entry.canRead, hasWindowData, projectionScope, retryAttempt, displayReady])
  const initialLoadError = !displayReady && projectionFailure?.scope === projectionScope && projectionFailure?.attempt === retryAttempt
    ? projectionFailure.error : null
  const pending = !displayReady && !initialLoadError && !query.isError && !entry.verificationFailed && !entry.denied
  const refetchQuery = query.refetch
  const refetch = useCallback((...args: Parameters<typeof refetchQuery>) => {
    setRetryAttempt(attempt => attempt + 1)
    return refetchQuery(...args)
  }, [refetchQuery])
  const fetchNextPage = query.fetchNextPage
  const fetchOlder = useCallback(() => { if (presented && displayReady && entry.windowReady) void fetchNextPage({ cancelRefetch: false }) }, [fetchNextPage, presented, displayReady, entry.windowReady])
  return { ...query, refetch, isPending: pending, isLoading: pending, displayReady, initialLoadError,
    observation: { snapshot_source: entry.resource?.source ?? "unknown" as const, target_coverage: displayReady ? "covered" as const : "uncovered" as const, wait_reason: !entry.canRead ? "entry" as const : displayReady ? "none" as const : "window" as const }, posts, tag, selectionReady, selectTag, tagsKnown: tagsQuery.data !== undefined, tagsError: tagsQuery.isError, retryTags: tagsQuery.refetch, availableTags: tagsQuery.data?.tags ?? [], hasMoreOlder: displayReady && entry.windowReady && query.hasNextPage, isFetchingOlder: query.isFetchingNextPage, fetchOlder }
}
