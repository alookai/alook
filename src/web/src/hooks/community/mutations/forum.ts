"use client"

import {
  hashKey,
  useMutation,
  useQueryClient,
  type Query,
  type QueryKey,
} from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { UploadedAttachment } from "@/hooks/community/mutations/uploads"
import type { MentionType } from "@alook/shared"
import { FORUM_ARCHIVE_TAG } from "@alook/shared"
import {
  reconcileForumSidebarArchiveTag,
  restoreForumSidebarThreadInflight,
} from "@/hooks/community/use-forum-sidebar-threads"
import {
  applyForumPostUnitClientEffects,
  evictForumPostUnitQueryCaches,
  type ForumPostUnitIdentity,
} from "@/hooks/community/community-ws/channel-scope-projection"

export type CreateForumThreadArgs = {
  nonce: string
  channelId: string
  name: string
  content: string
  // Pre-uploaded pending attachments — the client uploads via `useUploadFile`
  // (creating pending rows) before firing this mutation and passes the
  // descriptors here; only their `id`s reach the server (reserve-by-id,
  // route/disc step 2b), which links them onto the post's first message.
  attachments?: UploadedAttachment[]
  // Propagated to the first message so `@everyone` audience broadcast
  // fires end-to-end.
  mentionType?: MentionType
}
export type CreateForumThreadResult = { threadId: string }

export function useCreateForumThread() {
  const queryClient = useQueryClient()
  return useMutation<CreateForumThreadResult, Error, CreateForumThreadArgs>({
    mutationFn: async ({ nonce, channelId, name, content, attachments, mentionType }) => {
      // Server receives only the attachment IDS (reserve-by-id); dimensions
      // already rode the upload, so they are not re-sent.
      const attachmentIds = attachments?.map((a) => a.id)
      const structure = await apiFetch<CreateForumThreadResult>(
        `/api/community/channels/${channelId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ content: name, attachments: attachmentIds, mentionType, nonce: `${nonce}:opener` }),
        },
      )
      await apiFetch(`/api/community/channels/${structure.threadId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content, attachments: attachmentIds, nonce: `${nonce}:reply` }),
      })
      return structure
    },
    onSuccess: (data, args) => {
      void data
      void queryClient.invalidateQueries({ queryKey: communityKeys.channelMessages(args.channelId) })
      void queryClient.invalidateQueries({ queryKey: communityKeys.threads(args.channelId) })
    },
  })
}

export type UpdatePostTagsArgs = {
  serverId: string
  // The parent forum channel — the cache key the post list lives under.
  forumChannelId: string
  // The post/thread card being patched in cache.
  threadId: string
  // Tags are a resource of the forum opener message, never of the child thread.
  openerMessageId: string
  previousTags: string[]
  tags: string[]
}

/**
 * Edit a single forum post's tags. PUTs the opener-message tag resource (author or manager
 * gated server-side), then patches the post's row in the forum's cached list so
 * the card + the derived tag filter bar update on success without a refetch.
 */
export function useUpdatePostTags() {
  const queryClient = useQueryClient()
  return useMutation<{ tags: string[] }, Error, UpdatePostTagsArgs>({
    mutationFn: async ({ openerMessageId, tags }) => {
      const normalized = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]
      const result = await apiFetch<{ tags: string[] }>(`/api/community/messages/${openerMessageId}/tags`, {
        method: "PUT",
        body: JSON.stringify({ tags: normalized }),
      })
      return {
        tags: [...new Set(result.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))],
      }
    },
    onSuccess: (data, args) => {
      const wasArchived = args.previousTags.includes(FORUM_ARCHIVE_TAG)
      const isArchived = data.tags.includes(FORUM_ARCHIVE_TAG)
      if (wasArchived !== isArchived) {
        void reconcileForumSidebarArchiveTag(
          queryClient,
          args.serverId,
          args.threadId,
          isArchived,
        )
      }
      // Prefix invalidation covers the unfiltered list and every tag variant.
      // This is required when the edited
      // post loses the currently-selected tag and must leave that result set.
      void queryClient.invalidateQueries({ queryKey: communityKeys.channelMessages(args.forumChannelId) })
      void queryClient.invalidateQueries({ queryKey: communityKeys.threads(args.forumChannelId) })
      void queryClient.invalidateQueries({ queryKey: communityKeys.forumTags(args.forumChannelId) })
    },
  })
}

export type DeleteForumThreadArgs = {
  serverId: string
  // The parent forum channel — the cache key the post list lives under.
  forumChannelId: string
  // The post channel being deleted.
  threadId: string
  // Canonical post identity addressed by the server DELETE route.
  openerMessageId: string
}

type DeleteForumThreadContext = {
  snapshot: Array<readonly [QueryKey, unknown]>
}

function toPostUnit(args: DeleteForumThreadArgs): ForumPostUnitIdentity {
  return {
    serverId: args.serverId,
    forumChannelId: args.forumChannelId,
    childChannelId: args.threadId,
    openerMessageId: args.openerMessageId,
  }
}

function startsWithQueryKey(queryKey: QueryKey, prefix: QueryKey) {
  return prefix.length <= queryKey.length
    && hashKey(queryKey.slice(0, prefix.length)) === hashKey(prefix)
}

function isForumPostUnitQuery(query: Query, unit: ForumPostUnitIdentity) {
  const key = query.queryKey
  const exactKeys: QueryKey[] = [
    communityKeys.server(unit.serverId),
    communityKeys.forumSidebarThreads(unit.serverId),
    communityKeys.forumSidebarUnreadFallbacks(unit.serverId),
    communityKeys.forumSidebarRetained(unit.serverId, unit.childChannelId),
    communityKeys.channelMeta(unit.serverId, unit.childChannelId),
    communityKeys.forumOpenerHint(unit.serverId, unit.openerMessageId),
    communityKeys.message(unit.openerMessageId),
  ]
  return exactKeys.some((candidate) => hashKey(candidate) === hashKey(key)) || [
    communityKeys.channelMessages(unit.forumChannelId),
    communityKeys.forumFeeds(unit.forumChannelId),
    communityKeys.channelMessages(unit.childChannelId),
    communityKeys.pins(unit.childChannelId),
    communityKeys.threads(unit.childChannelId),
  ].some((prefix) => startsWithQueryKey(key, prefix))
}

function snapshotForumPostUnit(queryClient: ReturnType<typeof useQueryClient>, unit: ForumPostUnitIdentity) {
  return queryClient.getQueryCache().findAll({
    predicate: (query) => isForumPostUnitQuery(query, unit),
  }).map((query) => [query.queryKey, query.state.data] as const)
}

function restoreForumPostUnit(
  queryClient: ReturnType<typeof useQueryClient>,
  unit: ForumPostUnitIdentity,
  snapshot: DeleteForumThreadContext["snapshot"],
) {
  queryClient.removeQueries({ predicate: (query) => isForumPostUnitQuery(query, unit) })
  for (const [queryKey, data] of snapshot) queryClient.setQueryData(queryKey, data)
  restoreForumSidebarThreadInflight(unit.serverId, unit.childChannelId)
}

/**
 * Delete a canonical forum post through its opener-message resource. Every
 * touched query family is snapshotted before synchronous post-unit eviction;
 * an HTTP failure restores those exact snapshots. The canonical WS event
 * applies the same eviction for other clients and active-route ejection.
 */
export function useDeleteForumThread() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, DeleteForumThreadArgs, DeleteForumThreadContext>({
    mutationFn: async ({ openerMessageId }) => {
      await apiFetch(`/api/community/messages/${openerMessageId}`, { method: "DELETE" })
    },
    onMutate: async (args) => {
      const unit = toPostUnit(args)
      await queryClient.cancelQueries({
        predicate: (query) => isForumPostUnitQuery(query, unit),
      })
      const snapshot = snapshotForumPostUnit(queryClient, unit)
      evictForumPostUnitQueryCaches(queryClient, unit)
      return { snapshot }
    },
    onError: (_error, args, context) => {
      if (context) restoreForumPostUnit(queryClient, toPostUnit(args), context.snapshot)
    },
    onSuccess: (_data, args) => {
      applyForumPostUnitClientEffects(queryClient, toPostUnit(args))
    },
    onSettled: (_data, _error, args) => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.channelMessages(args.forumChannelId) })
      void queryClient.invalidateQueries({ queryKey: communityKeys.threads(args.forumChannelId) })
      void queryClient.invalidateQueries({ queryKey: communityKeys.forumTags(args.forumChannelId) })
      void queryClient.invalidateQueries({ queryKey: communityKeys.server(args.serverId), exact: true })
    },
  })
}
