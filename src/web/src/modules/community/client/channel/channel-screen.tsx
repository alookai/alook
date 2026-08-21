"use client"

import { ChannelController } from "./internal/channel-controller"

export function ChannelScreen({ serverParam, channelId }: {
  serverParam: string
  channelId: string
}) {
  return <ChannelController serverParam={serverParam} channelId={channelId} />
}
