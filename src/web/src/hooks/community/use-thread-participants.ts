"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import {
  grantForumSidebarChild,
  removeForumSidebarProjectionExact,
  removeForumSidebarUnreadChild,
} from "@/hooks/community/use-forum-sidebar-threads"
import { getActiveAccountUnreadProjection } from "@/hooks/community/account-unread-projection"

// The participant READ hook was retired: the post/thread member panel now reads
// the unified `/members` endpoint (via `useChannelMembers`), which returns the
// canonical `MappedMember` shape for the notify set. Only the add/remove WRITE
// hooks remain here — they mutate `/participants` and invalidate the
// channelMembers cache the panel now reads (NOT the old threadParticipants key).

/** Any participant adds a parent-channel member to the thread/post. */
export function useAddThreadParticipant(
  channelId: string,
  serverId?: string,
  viewerUserId?: string,
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch(`/api/community/channels/${encodeURIComponent(channelId)}/participants`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      }),
    onSuccess: (_data, userId) => {
      void qc.invalidateQueries({ queryKey: communityKeys.channelMembers(channelId) })
      if (serverId && userId === viewerUserId) {
        void grantForumSidebarChild(qc, serverId, channelId)
          .catch(() => undefined)
      }
    },
  })
}

/** Leave a thread/post (remove your own participation, or the creator removes someone). */
export function useRemoveThreadParticipant(
  channelId: string,
  serverId?: string,
  viewerUserId?: string,
  forumSidebar = !!serverId,
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch(
        `/api/community/channels/${encodeURIComponent(channelId)}/participants/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, userId) => {
      void qc.invalidateQueries({ queryKey: communityKeys.channelMembers(channelId) })
      if (serverId && userId === viewerUserId) {
        getActiveAccountUnreadProjection(qc).retireAccessScope({
          kind: "channel",
          channelId,
        })
        if (forumSidebar) {
          removeForumSidebarUnreadChild(qc, serverId, channelId)
          removeForumSidebarProjectionExact(qc, serverId, channelId)
        }
      }
    },
  })
}
