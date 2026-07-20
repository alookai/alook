"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { ForumPost } from "@/components/community/_types"
import type { ForumPostsResponse } from "@/hooks/community/use-channel-panels"

export type CreateForumPostArgs = {
  channelId: string
  name: string
  content: string
}
export type CreateForumPostResult = { post: ForumPost }

export function useCreateForumPost() {
  const queryClient = useQueryClient()
  return useMutation<CreateForumPostResult, Error, CreateForumPostArgs>({
    mutationFn: async ({ channelId, name, content }) => {
      return apiFetch<CreateForumPostResult>(
        `/api/community/channels/${channelId}/posts`,
        {
          method: "POST",
          body: JSON.stringify({ name, content }),
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
            ? { ...prev, posts: [data.post, ...prev.posts] }
            : { posts: [data.post] },
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
                posts: prev.posts.map((p) =>
                  p.id === args.postId ? { ...p, tags: data.tags } : p,
                ),
              }
            : prev,
      )
    },
  })
}
