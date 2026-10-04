"use client"

import type { ReactNode } from "react"
import { useSelectedLayoutSegments, usePathname } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { useSelector } from "@tanstack/react-store"
import { useCurrentUser } from "@/contexts/community/current-user"
import { getCommunityRuntime } from "@/stores/community/runtime"
import { CommunityServerRouteContext, useCommunityRouteFrame } from "@/components/community/shell/community-route-context"
import { ChannelRoute } from "@/components/community/channels/channel-route"
import { resolveCommunityModulePlan } from "@/lib/community/community-route"
import { CommunityPendingFrame } from "@/components/community/shell/community-pending-frame"

export default function ServerLayout({ children }: { children: ReactNode }) {
  const segments = useSelectedLayoutSegments()
  const serverParam = segments[0]
  const pathname = usePathname()
  const queryClient = useQueryClient()
  const currentUser = useCurrentUser()
  const { ownerDeleteRouteScope } = useCommunityRouteFrame()
  const serverId = serverParam ? decodeURIComponent(serverParam) : ""
  const modulePlan = resolveCommunityModulePlan(`/c/channels/${segments.join("/")}`)
  const routeChannelId = modulePlan.main.kind === "server-conversation"
    ? modulePlan.main.leafId : null
  const protectedRoute = useSelector(getCommunityRuntime(queryClient).serverEject, (state) =>
    state.transactions.has(serverId) || Boolean(ownerDeleteRouteScope?.serverId === serverId
      && state.tombstones.get(ownerDeleteRouteScope.token) === serverId))
  const content = protectedRoute
    ? <CommunityPendingFrame href={pathname} />
    : routeChannelId
      ? <ChannelRoute key={`${currentUser.id}/${serverId}/${routeChannelId}`} serverParam={serverParam!} channelId={routeChannelId} />
      : children
  return <CommunityServerRouteContext value={{ serverId, serverParam: serverParam ?? "" }}>
    {content}
  </CommunityServerRouteContext>
}
