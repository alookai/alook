"use client"

import { useParams } from "next/navigation"
import { ChannelRoute } from "@/components/community/channel-route"

export default function ChannelPage() {
  const params = useParams<{ serverId: string; channelId: string }>()
  const key = `${params.serverId}/${params.channelId}`
  return <ChannelRoute key={key} serverParam={params.serverId} channelId={params.channelId} />
}
