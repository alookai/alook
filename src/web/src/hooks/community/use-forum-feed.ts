"use client"

import { deriveView, valueEvidence, viewEvidence } from "@/lib/observability/data-source"
import { useCallback, useEffect, useMemo } from "react"
import { createStore, useAtom, useCreateAtom } from "@tanstack/react-store"
import { useInfiniteQuery, useIsMutating, useQueryClient, type Query } from "@tanstack/react-query"
import { compareAsciiSqliteBinary, DEFAULT_MESSAGE_PAGE_SIZE, type CommunityThreadsRead } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { conversationReadRetryPolicy, withConversationReadDeadline } from "@/lib/community/conversation-read"
import { communityKeys } from "@/lib/query-keys"
import { avatarInitial } from "@/lib/community/avatar"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useCanonicalChannelsById, useCanonicalMessagesById, useCanonicalProfilesByUserId } from "@/lib/community-db/projections"
import { assertCommunityLiveSnapshotTokenCurrent, captureCommunityLiveSnapshotToken, publishCommunityForumFeed } from "@/lib/community-db/sync"
import { readForumTagSelection, validateForumTagSelection, writeForumTagSelection } from "@/lib/community/forum-tag-selection"
import type { ForumThread, Msg } from "@/lib/community/models/message"
import type { ChannelRow } from "@/lib/community-db/schema"
import { readCommunityProfile } from "@/lib/community/profile-read"
import { useForumTags } from "./use-channel-panels"
import { forumFeedMatchesTags, forumFeedWindow, normalizeThreadResources, projectThread, type ForumFeedPage, type ForumFeedTransportPage } from "./forum-feed-window"

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
    const transport = await apiFetch<ForumFeedTransportPage | CommunityThreadsRead>(`/api/community/channels/${channelId}/threads?${params}`, communityRequestOptions(queryClient, token, readSignal))
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, readSignal)
    const page = normalizeThreadResources(channelId, transport)
    const freshThreads = page.threads.filter((thread) => !protocol.get().publishedIds.has(thread.id))
    const ids = new Set(freshThreads.map((thread) => thread.id)), openerIds = new Set(freshThreads.map((thread) => thread.parentMessageId))
    const users = new Set(page.included.members.filter((member) => ids.has(member.channelId)).map((member) => member.userId))
    publishCommunityForumFeed(queryClient, channelId, { ...page, threads: freshThreads, included: {
      messages: page.included.messages.filter((message) => openerIds.has(message.id) || ids.has(message.channelId)),
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
    byId.set(thread.id, deriveView({
      ...projectThread(thread, opener, "forum"), authorId: opener.authorId ?? thread.creatorId ?? "",
      authorAvatar: opener.authorAvatar ?? avatarInitial(opener.authorName ?? ""), authorAvatarVersion: opener.authorAvatarVersion ?? 0,
      openerMessageId: opener.id, ...(opener.createdAt === undefined ? {} : { openerCreatedAt: opener.createdAt }), tags: thread.tags, preview: thread.preview ?? "",
      participants: window.participantIds.map((id) => { const profile = readCommunityProfile(profiles.get(id), id); return { id, name: profile.name, avatar: profile.avatar, avatarVersion: profile.avatarVersion } }), participantCount: thread.participantCount ?? 0,
    }, [viewEvidence(thread), viewEvidence(opener), ...window.participantIds.map(id => viewEvidence(profiles.get(id)))]))
  }
  return [...byId.values()].sort((a, b) => compareAsciiSqliteBinary(channels.get(b.id)?.createdAt ?? "", channels.get(a.id)?.createdAt ?? "") || compareAsciiSqliteBinary(b.id, a.id))
}

export function useForumFeed(serverId: string, channelId: string) {
  const queryClient = useQueryClient(), channels = useCanonicalChannelsById(), profiles = useCanonicalProfilesByUserId()
  const readTag = () => { try { return readForumTagSelection(window.localStorage, channelId) } catch { return "All" } }
  const [selection, setSelection] = useAtom(useCreateAtom({ channelId, tag: readTag() }))
  const tag = selection.channelId === channelId ? selection.tag : readTag()
  const selectTag = useCallback((next: string) => { setSelection({ channelId, tag: next }); try { writeForumTagSelection(window.localStorage, channelId, next) } catch {} }, [channelId, setSelection])
  const tagsQuery = useForumTags(channelId, true)
  const pendingTagCommands = useIsMutating({ mutationKey: ["community", "forum-tag-command"], exact: true, predicate: (mutation) => {
    const args = mutation.state.variables as { serverId?: string; forumChannelId?: string } | undefined
    return args?.serverId === serverId && args.forumChannelId === channelId
  } })
  useEffect(() => { if (!pendingTagCommands && tagsQuery.isSuccess && tag !== "All" && validateForumTagSelection(tag, tagsQuery.data.tags) === "All") selectTag("All") }, [pendingTagCommands, tag, tagsQuery.isSuccess, tagsQuery.data, selectTag])
  const selectedTag = tag === "All" ? null : tag
  const queryKey = communityKeys.forumFeed(channelId, selectedTag)
  const query = useInfiniteQuery({ queryKey, queryFn: forumFeedPageQueryFn(channelId, selectedTag, queryClient), initialPageParam: null as string | null, getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.nextCursor : undefined,
    retry: conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey }).retry), networkMode: "always" })
  const messageIds = useMemo(() => [...new Set(query.data?.pages.flatMap((page) => page.threads.flatMap((thread) => thread.openerMessageId ? [thread.openerMessageId] : [])) ?? [])], [query.data?.pages])
  const messages = useCanonicalMessagesById(messageIds)
  const posts = useMemo(() => mapForumFeedPages(query.data?.pages ?? [], messages ?? new Map(), channels, profiles, selectedTag), [query.data?.pages, messages, channels, profiles, selectedTag])
  deriveView(posts, [valueEvidence(queryClient, query.data), ...posts.map(viewEvidence)], posts.length)
  return { ...query, posts, tag, selectTag, availableTags: tagsQuery.data?.tags ?? [], hasMoreOlder: query.hasNextPage, isFetchingOlder: query.isFetchingNextPage, fetchOlder: () => { void query.fetchNextPage() } }
}
