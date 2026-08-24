"use client"

import type { Msg } from "@/lib/community/models/message"
import { useTimelineReadObserver } from "./use-read-observer"

/* istanbul ignore next -- retained Chromium covers this React hook adapter */
export function useDmWatermark({
  dmId,
  messages,
  scrollRootEl,
  snapshotReady,
  confirmedSeq,
}: {
  dmId: string | null | undefined
  messages: Msg[]
  scrollRootEl: HTMLElement | null
  snapshotReady: boolean
  confirmedSeq: number
}) {
  useTimelineReadObserver({
    channelId: dmId,
    messages,
    scrollRootEl,
    snapshotReady,
    confirmedSeq,
  })
}
