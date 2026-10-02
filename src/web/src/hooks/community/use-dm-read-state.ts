"use client"

import { useEffect, useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { captureChannelMetadataToken, isChannelMetadataTokenCurrent, type ChannelMetadata } from "./channel-metadata"

/**
 * The DM read-state snapshot returned by
 * `GET /api/community/channels/:id/read-state` (a DM is a channel row; the
 * whole DM surface reads through the one canonical door). Fields default to
 * `null` / `0`
 * when the viewer has never opened this DM.
 */
export type DmReadStateSnapshot = {
  lastReadMessageId: string | null
  lastReadAt: string | null
  // Numeric equivalent of `lastReadMessageId` — the seq of the row that
  // pointer refers to. Server returns `0` when the viewer has never read
  // this DM; consumers subtract from `latestSeq` for the unread-count pill
  // without walking loaded rows.
  lastReadSeq: number
}

/**
 * Once-per-mount snapshot of the viewer's read pointer for a DM. The
 * channel-side sibling is `useChannelReadStateSnapshot` — this hook mirrors
 * it exactly, because the invariants are shared: fix a bug on one side and
 * the same fix must reach the other, or the divider anchors diverge across
 * channels vs DMs and users lose their place.
 *
 * See `use-channel-read-state.ts` for the full doc — same freeze rule,
 * same `staleTime: Infinity` + `gcTime: 0` combo, same channelId → dmId
 * substitution.
 */
export function useDmReadStateSnapshot(
  dmId: string | null | undefined,
  canonicalSnapshot?: DmReadStateSnapshot,
): {
  snapshot: DmReadStateSnapshot | null
  isFetching: boolean
  error: Error | null
  retrying: boolean
  retry: () => void
} {
  const queryClient = useQueryClient()
  const query = useQuery<DmReadStateSnapshot>({
    queryKey: dmId
      ? communityKeys.dmReadStateSnapshot(dmId)
      : ["community", "dm", "__none__", "read-state-snapshot"],
    queryFn: async ({ signal }) => {
      const token = captureChannelMetadataToken(dmId!)
      const metadataKey = communityKeys.channelMeta(null, dmId!)
      const metadataQuery = queryClient.getQueryCache().find({ queryKey: metadataKey, exact: true })
      const current = () => !signal.aborted && isChannelMetadataTokenCurrent(token)
      try {
        const snapshot = await apiFetch<DmReadStateSnapshot>(`/api/community/channels/${dmId}/read-state`, { signal })
        if (!current()) throw new DOMException("Stale DM history access", "AbortError")
        if (metadataQuery && queryClient.getQueryCache().find({ queryKey: metadataKey, exact: true }) === metadataQuery) {
          queryClient.setQueryData<ChannelMetadata>(metadataKey, (metadata) => metadata
            ? { ...metadata, historyVerification: token } : metadata)
        }
        return snapshot
      } catch (error) {
        if (!current()) throw new DOMException("Stale DM history access", "AbortError")
        if (typeof error === "object" && error !== null && "status" in error && (error.status === 403 || error.status === 404)
          && metadataQuery && queryClient.getQueryCache().find({ queryKey: metadataKey, exact: true }) === metadataQuery) {
          queryClient.setQueryData<ChannelMetadata>(metadataKey, (metadata) => metadata
            ? { ...metadata, historyVerification: undefined } : metadata)
        }
        throw error
      }
    },
    enabled: !!dmId,
    staleTime: Infinity,
    // Match the channel hook exactly. A zero GC time normally removes the
    // prior mount's snapshot, while the forced mount refetch below also
    // covers a retained entry whose eviction timer has not run yet.
    gcTime: 0,
    // A retained cache value is not the new mount's snapshot. The latch below
    // waits for this forced fetch to settle before accepting query data.
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: (failureCount, error) => error.name !== "AbortError"
      && !("status" in error && [403, 404].includes(Number(error.status))) && failureCount < 1,
  })

  const snapshotRef = useRef<DmReadStateSnapshot | null>(null)
  const lastDmIdRef = useRef<string | null | undefined>(dmId)
  /* eslint-disable react-hooks/refs -- sync dm switch reset; see channel hook tests */
  if (lastDmIdRef.current !== dmId) {
    snapshotRef.current = null
    lastDmIdRef.current = dmId
  }
  if (snapshotRef.current === null && canonicalSnapshot) {
    snapshotRef.current = canonicalSnapshot
  }
  /* eslint-enable react-hooks/refs */
  useEffect(() => {
    if (snapshotRef.current !== null) return
    if (query.isFetching) return
    if (query.data) snapshotRef.current = query.data
  }, [query.data, query.isFetching])

  /* eslint-disable react-hooks/refs -- latched snapshot read; see channel hook tests */
  return {
    snapshot: snapshotRef.current ?? (!query.isFetching ? (query.data ?? null) : null),
    isFetching: snapshotRef.current === null && query.isFetching,
    error: query.error,
    retrying: query.isFetching,
    retry: () => { void query.refetch({ cancelRefetch: false }) },
  }
  /* eslint-enable react-hooks/refs */
}
