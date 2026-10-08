"use client"

import { useChannelReadStateSnapshot, type ChannelReadStateSnapshot } from "./use-channel-read-state"

export type DmReadStateSnapshot = ChannelReadStateSnapshot

export function useDmReadStateSnapshot(
  dmId: string | null | undefined,
  canonicalSnapshot?: DmReadStateSnapshot,
): ReturnType<typeof useChannelReadStateSnapshot> {
  return useChannelReadStateSnapshot(dmId, canonicalSnapshot, "dm")
}
