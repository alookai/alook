"use client"

import { useChannelReadStateSnapshot } from "./use-channel-read-state"

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
): ReturnType<typeof useChannelReadStateSnapshot> {
  return useChannelReadStateSnapshot(dmId, canonicalSnapshot, "dm")
}
