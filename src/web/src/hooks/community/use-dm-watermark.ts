"use client"

import type { Msg } from "@/lib/community/models/message"
import { useTimelineReadObserver } from "./use-read-observer"

/* istanbul ignore next -- retained Chromium covers this React hook adapter */
export function useDmWatermark({
  dmId,
  messages,
  scrollRootEl,
  snapshotStatus,
  feedStatus,
  tailAttached,
  confirmedSeq,
  catchUp,
}: {
  dmId: string | null | undefined
  messages: Msg[]
  scrollRootEl: HTMLElement | null
  snapshotStatus: "pending" | "ready" | "error"
  feedStatus: "pending" | "ready" | "error"
  tailAttached: boolean
  confirmedSeq: number
  catchUp: () => Promise<unknown>
}) {
  useTimelineReadObserver({
    channelId: dmId,
    messages,
    scrollRootEl,
    snapshotStatus,
    feedStatus,
    tailAttached,
    confirmedSeq,
    catchUp,
  })
}
