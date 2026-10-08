"use client"

import type { useChannelWatermark } from "./use-channel-watermark"
import { useTimelineReadObserver } from "./use-read-observer"

type ChannelReadOptions = Parameters<typeof useChannelWatermark>[0]

export function useDmWatermark({ dmId, ...options }: Omit<ChannelReadOptions, "channelId"> & { dmId: ChannelReadOptions["channelId"] }) {
  useTimelineReadObserver({ ...options, channelId: dmId })
}
