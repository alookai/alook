"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { ForumPost } from "@/components/community/_types"
import type { ForumPostsResponse } from "@/hooks/community/use-channel-panels"
import type { UploadedAttachment } from "@/hooks/community/mutations/uploads"
import type { MentionType } from "@alook/shared"

export type CreateForumPostArgs = {
  channelId: string
  name: string
  content: string
  // Pre-uploaded R2 URLs (not raw files) — the client uploads via
  // `useUploadFile` before firing this mutation, and the server persists them
  // as `community_message_attachment` rows on the post's first message.
  attachments?: UploadedAttachment[]
  // Propagated to the first message so `@everyone`/`@here` audience broadcast
  // fires end-to-end.
  mentionType?: MentionType
}
export type CreateForumPostResult = { channel: ForumPost }

export function useCreateForumPost() {
  const queryClient = useQueryClient()
  return useMutation<CreateForumPostResult, Error, CreateForumPostArgs>({
    mutationFn: async ({ channelId, name, content, attachments, mentionType }) => {
      return apiFetch<CreateForumPostResult>(
        `/api/community/channels`,
        {
          method: "POST",
          body: JSON.stringify({ type: "post", parentChannelId: channelId, name, content, attachments, mentionType }),
        },
      )
    },
    onSuccess: (data, args) => {
      // Prepend the fresh post to the cached list — the server-side WS
      // `child_create` also invalidates, but here we win the same-tab race.
      queryClient.setQueryData<ForumPostsResponse | undefined>(
        communityKeys.forumPosts(args.channelId),
        (prev) =>
          prev
            ? { ...prev, children: [data.channel, ...prev.children] }
            : { children: [data.channel] },
      )
    },
  })
}

export type UpdatePostTagsArgs = {
  // The parent forum channel — the cache key the post list lives under.
  forumChannelId: string
  // The post channel whose tags are being edited.
  postId: string
  tags: string[]
}

/**
 * Edit a single forum post's tags. PATCHes the post channel (creator or manager
 * gated server-side), then patches the post's row in the forum's cached list so
 * the card + the derived tag filter bar update without a refetch.
 */
export function useUpdatePostTags() {
  const queryClient = useQueryClient()
  return useMutation<{ tags: string[] }, Error, UpdatePostTagsArgs>({
    mutationFn: async ({ postId, tags }) => {
      const normalized = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]
      await apiFetch(`/api/community/channels/${postId}`, {
        method: "PATCH",
        body: JSON.stringify({ forumTags: JSON.stringify(normalized) }),
      })
      return { tags: normalized }
    },
    onSuccess: (data, args) => {
      queryClient.setQueryData<ForumPostsResponse | undefined>(
        communityKeys.forumPosts(args.forumChannelId),
        (prev) =>
          prev
            ? {
                ...prev,
                children: prev.children.map((p) =>
                  p.id === args.postId ? { ...p, tags: data.tags } : p,
                ),
              }
            : prev,
      )
    },
  })
}

export type DeleteForumPostArgs = {
  // The parent forum channel — the cache key the post list lives under.
  forumChannelId: string
  // The post channel being deleted.
  postId: string
}

/**
 * Delete a single forum post. A post IS a `post` child channel, so this
 * DELETEs the channel (creator or manager gated server-side — see the DELETE
 * route's post carve-out). On success (204) the post is filtered out of
 * the forum's cached list so the card disappears without a refetch; the
 * server-side WS `channel.delete` also invalidates for other clients.
 */
export function useDeleteForumPost() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, DeleteForumPostArgs>({
    mutationFn: async ({ postId }) => {
      await apiFetch(`/api/community/channels/${postId}`, { method: "DELETE" })
    },
    onSuccess: (_data, args) => {
      queryClient.setQueryData<ForumPostsResponse | undefined>(
        communityKeys.forumPosts(args.forumChannelId),
        (prev) =>
          prev
            ? { ...prev, children: prev.children.filter((p) => p.id !== args.postId) }
            : prev,
      )
    },
  })
}
