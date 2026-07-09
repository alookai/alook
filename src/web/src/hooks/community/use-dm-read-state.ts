"use client"

import { useEffect, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"

/**
 * The DM read-state snapshot returned by
 * `GET /api/community/dm/:id/read-state`. Fields default to `null` / `0`
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
export function useDmReadStateSnapshot(dmId: string | null | undefined): {
  snapshot: DmReadStateSnapshot | null
  isFetching: boolean
} {
  const query = useQuery<DmReadStateSnapshot>({
    queryKey: dmId
      ? communityKeys.dmReadStateSnapshot(dmId)
      : ["community", "dm", "__none__", "read-state-snapshot"],
    queryFn: async () => {
      return apiFetch<DmReadStateSnapshot>(
        `/api/community/dm/${dmId}/read-state`,
      )
    },
    enabled: !!dmId,
    staleTime: Infinity,
    // Match the channel hook exactly — see its docstring for why `gcTime: 0`
    // is the only reliable way to force a real refetch on remount when
    // `staleTime: Infinity` treats the cached anchor as fresh forever.
    gcTime: 0,
    // Belt-and-braces alongside `gcTime: 0` — see channel sibling for the
    // rationale. The `snapshotRef` freeze semantics still hold because the
    // ref latches only the first non-null resolution.
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  })

  const snapshotRef = useRef<DmReadStateSnapshot | null>(null)
  const lastDmIdRef = useRef<string | null | undefined>(dmId)
  /* eslint-disable react-hooks/refs -- sync dm switch reset; see channel hook tests */
  if (lastDmIdRef.current !== dmId) {
    snapshotRef.current = null
    lastDmIdRef.current = dmId
  }
  /* eslint-enable react-hooks/refs */
  useEffect(() => {
    if (snapshotRef.current !== null) return
    if (query.data) snapshotRef.current = query.data
  }, [query.data])

  /* eslint-disable react-hooks/refs -- latched snapshot read; see channel hook tests */
  return {
    snapshot: snapshotRef.current ?? (query.data ?? null),
    isFetching: query.isFetching,
  }
  /* eslint-enable react-hooks/refs */
}
