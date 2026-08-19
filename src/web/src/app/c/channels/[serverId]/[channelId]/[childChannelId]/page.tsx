"use client"

import { useParams } from "next/navigation"
import { ChannelRoute } from "@/components/community/channels/channel-route"

export default function ChildChannelPage() {
  const params = useParams<{
    serverId: string
    channelId: string
    childChannelId: string
  }>()
  const key = `${params.serverId}/${params.channelId}/${params.childChannelId}`
  return (
    <ChannelRoute
      key={key}
      serverParam={params.serverId}
      parentChannelId={params.channelId}
      channelId={params.childChannelId}
    />
  )
}
