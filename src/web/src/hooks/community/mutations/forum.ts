"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { UploadedAttachment } from "@/hooks/community/mutations/uploads"
import type { MentionType } from "@alook/shared"

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
  // The parent forum channel — the cache key the post list lives under.
  forumChannelId: string
  // The post/thread card being patched in cache.
  threadId: string
  // Tags are a resource of the forum opener message, never of the child thread.
  openerMessageId: string
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
      await apiFetch(`/api/community/messages/${openerMessageId}/tags`, {
        method: "PUT",
        body: JSON.stringify({ tags: normalized }),
      })
      return { tags: normalized }
    },
    onSuccess: (data, args) => {
      void data
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
  // The parent forum channel — the cache key the post list lives under.
  forumChannelId: string
  // The post channel being deleted.
  threadId: string
}

/**
 * Delete a single forum thread through the canonical child-channel resource.
 * On success (204) the post is filtered out of
 * the forum's cached list so the card disappears without a refetch; the
 * server-side WS `channel.delete` also invalidates for other clients.
 */
export function useDeleteForumThread() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, DeleteForumThreadArgs>({
    mutationFn: async ({ threadId }) => {
      await apiFetch(`/api/community/channels/${threadId}`, { method: "DELETE" })
    },
    onSuccess: (_data, args) => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.channelMessages(args.forumChannelId) })
      void queryClient.invalidateQueries({ queryKey: communityKeys.threads(args.forumChannelId) })
    },
  })
}
