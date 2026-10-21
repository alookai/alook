"use client"

import type { ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useSelector } from "@tanstack/react-store"
import { useCurrentUser } from "@/contexts/community/current-user"
import { getCommunityRuntime } from "@/stores/community/runtime"
import { useCommunityRouteFrame } from "@/components/community/shell/community-route-context"
import { CommunityPendingFrame } from "@/components/community/shell/community-pending-frame"
import { ChannelRoute } from "./channel-route"

export function ServerConversationRoute({ serverId, serverParam, channelId, href, routeCommitted, children }: {
  serverId: string
  serverParam: string
  channelId: string | null
  href: string
  routeCommitted: boolean
  children?: ReactNode
}) {
  const client = useQueryClient()
  const viewer = useCurrentUser()
  const { ownerDeleteRouteScope } = useCommunityRouteFrame()
  const protectedRoute = useSelector(getCommunityRuntime(client).serverEject, state =>
    state.transactions.has(serverId) || Boolean(ownerDeleteRouteScope?.serverId === serverId
      && state.tombstones.get(ownerDeleteRouteScope.token) === serverId))
  if (protectedRoute) return <CommunityPendingFrame href={href} />
  return channelId ? <ChannelRoute key={JSON.stringify([viewer.id, serverId])}
    serverParam={serverParam} channelId={channelId} targetHref={href} routeCommitted={routeCommitted} /> : children
}
