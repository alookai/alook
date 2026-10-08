"use client"

import type { Msg } from "@/lib/community/models/message"
import { useTimelineReadObserver } from "./use-read-observer"

export function useChannelWatermark(options: Omit<Parameters<typeof useTimelineReadObserver>[0], "messages"> & { messages: Msg[] }) {
  useTimelineReadObserver(options)
}
