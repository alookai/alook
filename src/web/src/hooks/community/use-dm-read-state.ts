"use client"

import { useChannelReadStateSnapshot } from "./use-channel-read-state"

export function useDmReadStateSnapshot(
  dmId: string | null | undefined,
): ReturnType<typeof useChannelReadStateSnapshot> {
  return useChannelReadStateSnapshot(dmId, "dm")
}
