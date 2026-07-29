"use client"

import { useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { ServersResponse } from "@/hooks/community/use-servers"

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
 * `isChildChannel` picks the endpoint — threads/forum-posts read through
 * `/threads/:id/read`, top-level channels through `/channels/:id/read`. Both
 * accept an empty body as mass mark-read and both batch the mention clear.
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
    if (!channelId) return
    if (!snapshotReady) return
    if (firedForRef.current === channelId) return
    firedForRef.current = channelId

    const endpoint = isChildChannel
      ? `/api/community/threads/${channelId}/read`
      : `/api/community/channels/${channelId}/read`
    void apiFetch(endpoint, { method: "PUT" })
      .then(() => {
        // Always refresh the inbox feeds — the mass mark-read cleared them.
        void queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })

        // The rail mention badge (`server.mentions`) only needs refreshing when
        // this server actually carries mentions the PUT may have cleared. Read
        // it from the `servers()` cache and gate on it: the common case (no
        // mentions anywhere in the server) skips the invalidate entirely, so a
        // plain channel switch no longer cascade-refetches every server-level
        // query. When there ARE mentions, refresh only `server(serverId)` — the
        // one query that feeds the badge — not the whole `servers()` prefix.
        if (!serverId) return
        const servers = queryClient.getQueryData<ServersResponse>(
          communityKeys.servers(),
        )
        const hasMentions = servers?.servers.some(
          (s) => s.id === serverId && s.mentions > 0,
        )
        if (hasMentions) {
          void queryClient.invalidateQueries({
            queryKey: communityKeys.server(serverId),
          })
        }
      })
      .catch(() => {
        // Silent — the watermark / WS invalidate reconciles the inbox anyway.
      })
  }, [channelId, serverId, isChildChannel, snapshotReady, queryClient])
}
