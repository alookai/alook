"use client"

import { useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { ServersResponse } from "@/hooks/community/use-servers"
import {
  patchForumSidebarUnreadExact,
  removeForumSidebarUnreadChild,
  setForumSidebarParentUnreadBase,
} from "@/hooks/community/use-forum-sidebar-threads"

/**
 * Eager "mark this channel/thread read on open."
 *
 * Being *inside* a channel should consume its unread — the inbox must not keep
 * showing a channel the viewer is actively looking at. This fires ONE mass
 * mark-read PUT (empty body → the server marks to the latest message) per
 * mount, as soon as the read-state snapshot has latched.
 *
 * Ordering matters (NEW-divider preservation): the divider anchors to
 * `useChannelReadStateSnapshot`, a once-per-mount frozen pointer. We gate this
 * PUT on `snapshotReady` so the snapshot latches the PRE-open pointer first;
 * the eager PUT then advances the server pointer without moving the divider.
 *
 * Race avoidance: we deliberately do NOT route through `scheduleMarkRead` (the
 * debounced watermark path keyed on `channelId`). The IntersectionObserver
 * watermark can schedule an advance to an OLDER (divider-area) message at
 * mount; a shared debounce would collapse to whichever fires last and could
 * under-advance. A direct PUT-to-latest, guarded server-side by the monotonic
 * `lastReadAt < message.createdAt` rule, can never be regressed by a later
 * older watermark PUT.
 *
 * All channel kinds (top-level and child thread) mark read through the one
 * `/channels/:id/read` trunk — a thread IS a channel, and the unified handler
 * dispatches by surface (DM ids run the block gate). The old per-type
 * `/threads/:id/read` split is retired. Empty body = mass mark-read + batched
 * mention clear.
 *
 * Note: `lastReadSeq` (the numeric bot-wake cursor) is intentionally NOT
 * touched here — human read routes don't bump it; that divergence is a
 * separate concern.
 */
export function useEagerChannelRead({
  channelId,
  serverId,
  isChildChannel,
  snapshotReady,
}: {
  channelId: string | null | undefined
  serverId: string | null | undefined
  isChildChannel: boolean
  snapshotReady: boolean
}) {
  const queryClient = useQueryClient()
  // One eager PUT per (channel mount). Reset when the channel changes.
  const firedForRef = useRef<string | null>(null)

  useEffect(() => {
    const attemptRead = () => {
      if (!channelId) return
      if (!snapshotReady) return
      if (
        typeof document !== "undefined"
        && document.visibilityState !== "visible"
      ) return
      if (firedForRef.current === channelId) return
      firedForRef.current = channelId

      void apiFetch(`/api/community/channels/${channelId}/read`, { method: "PUT" })
        .then(() => {
          // Always refresh the inbox feeds — the mass mark-read cleared them.
          void queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })

          // Keep the local canonical attribution in step with the successful
          // read even on a direct/deep-link mount (where no sidebar click ran).
          // Otherwise a loaded child that later expires from the projection
          // could incorrectly re-light its parent from stale local ownership.
          if (serverId && isChildChannel) {
            removeForumSidebarUnreadChild(queryClient, serverId, channelId)
            patchForumSidebarUnreadExact(queryClient, serverId, channelId, false)
          } else if (serverId) {
            setForumSidebarParentUnreadBase(queryClient, serverId, channelId, false)
          }

          // The rail mention badge (`server.mentions`) only needs refreshing when
          // this server actually carries mentions the PUT may have cleared. Read
          // it from the `servers()` cache and gate on it: the common case (no
          // mentions anywhere in the server) skips the invalidate entirely.
          //
          // The badge count lives in the `servers()` LIST query — NOT in
          // `server(serverId)` (that's the detail: categories/channels, no
          // count). So refresh `servers()` and, critically, with `exact: true`:
          // members/presence/invites/server(id) are all nested under
          // `servers()` in the key hierarchy, and a non-exact invalidate
          // prefix-matches and force-refetches that whole subtree (overriding
          // their staleTime: Infinity). `exact` refreshes only the badge list.
          if (!serverId) return
          const servers = queryClient.getQueryData<ServersResponse>(
            communityKeys.servers(),
          )
          const hasMentions = servers?.servers.some(
            (s) => s.id === serverId && s.mentions > 0,
          )
          if (hasMentions) {
            void queryClient.invalidateQueries({
              queryKey: communityKeys.servers(),
              exact: true,
            })
          }
        })
        .catch(() => {
          // Silent — the watermark / WS invalidate reconciles the inbox anyway.
        })
    }

    attemptRead()
    if (typeof document === "undefined") return
    document.addEventListener("visibilitychange", attemptRead)
    return () => document.removeEventListener("visibilitychange", attemptRead)
  }, [channelId, serverId, isChildChannel, snapshotReady, queryClient])
}
