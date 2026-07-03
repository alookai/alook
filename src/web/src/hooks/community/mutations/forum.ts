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
  tags: string[]
}
export type CreateForumPostResult = { post: ForumPost }

export function useCreateForumPost() {
  const queryClient = useQueryClient()
  return useMutation<CreateForumPostResult, Error, CreateForumPostArgs>({
    mutationFn: async ({ channelId, name, content, tags }) => {
      return apiFetch<CreateForumPostResult>(
        `/api/community/channels/${channelId}/posts`,
        {
          method: "POST",
          body: JSON.stringify({ name, content, tags }),
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
