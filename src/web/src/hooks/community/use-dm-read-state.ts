"use client"

import { useChannelReadStateSnapshot, type ChannelReadStateSnapshot } from "./use-channel-read-state"

export type DmReadStateSnapshot = ChannelReadStateSnapshot

export function useDmReadStateSnapshot(
  dmId: string | null | undefined,
): ReturnType<typeof useChannelReadStateSnapshot> {
  return useChannelReadStateSnapshot(dmId, "dm")
}
