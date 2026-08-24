"use client"

import type { Msg } from "@/lib/community/models/message"
import { useTimelineReadObserver } from "./use-read-observer"

/* istanbul ignore next -- retained Chromium covers this React hook adapter */
export function useChannelWatermark({
  channelId,
  messages,
  scrollRootEl,
  snapshotReady,
  confirmedSeq,
}: {
  channelId: string | null | undefined
  messages: Msg[]
  scrollRootEl: HTMLElement | null
  snapshotReady: boolean
  confirmedSeq: number
}) {
  useTimelineReadObserver({
    channelId,
    messages,
    scrollRootEl,
    snapshotReady,
    confirmedSeq,
  })
}
