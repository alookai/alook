"use client"

import { useParams } from "next/navigation"
import { ChannelScreen } from "@/modules/community/client"

export default function ChannelPage() {
  const params = useParams<{ serverId: string; channelId: string }>()
  const key = `${params.serverId}/${params.channelId}`
  return <ChannelScreen key={key} serverParam={params.serverId} channelId={params.channelId} />
}
