"use client"

import type { ReactNode } from "react"
import { useSelectedLayoutSegments, usePathname, useSearchParams } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { useSelector } from "@tanstack/react-store"
import { useCurrentUser } from "@/contexts/community/current-user"
import { getCommunityRuntime } from "@/stores/community/runtime"
import { CommunityServerRouteContext, useCommunityRouteFrame } from "@/components/community/shell/community-route-context"
import { ChannelRoute } from "@/components/community/channels/channel-route"
import { normalizeCommunityHref, resolveCommunityModulePlan } from "@/lib/community/community-route"
import { CommunityPendingFrame } from "@/components/community/shell/community-pending-frame"

export default function ServerLayout({ children }: { children: ReactNode }) {
  const segments = useSelectedLayoutSegments()
  const serverParam = segments[0]
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()
  const currentUser = useCurrentUser()
  const { navigation, ownerDeleteRouteScope } = useCommunityRouteFrame()
  const serverId = serverParam ? decodeURIComponent(serverParam) : ""
  const publishedHref = normalizeCommunityHref(`${pathname}${searchParams.size ? `?${searchParams}` : ""}`)
  const framePathname = segments.length ? `/c/channels/${segments.join("/")}` : "/c/channels"
  const frameHref = normalizeCommunityHref(`${framePathname}${publishedHref.pathname === framePathname && publishedHref.search ? `?${publishedHref.search}` : ""}`)
  const pendingPlan = navigation.navigationPending && navigation.pendingHref
    ? resolveCommunityModulePlan(navigation.pendingHref) : null
  const targetHref = pendingPlan?.main.kind === "server-conversation"
    && pendingPlan.main.serverId === serverId
    ? normalizeCommunityHref(navigation.pendingHref!) : frameHref
  const modulePlan = resolveCommunityModulePlan(targetHref.href)
  const routeChannelId = modulePlan.main.kind === "server-conversation" && modulePlan.main.serverId === serverId
    ? modulePlan.main.leafId : null
  const protectedRoute = useSelector(getCommunityRuntime(queryClient).serverEject, (state) =>
    state.transactions.has(serverId) || Boolean(ownerDeleteRouteScope?.serverId === serverId
      && state.tombstones.get(ownerDeleteRouteScope.token) === serverId))
  const content = protectedRoute
    ? <CommunityPendingFrame href={pathname} />
    : routeChannelId
      ? <ChannelRoute key={JSON.stringify([currentUser.id, serverId])}
          serverParam={serverParam!} channelId={routeChannelId}
          targetHref={targetHref.href} routeCommitted={publishedHref.href === targetHref.href} />
      : children
  return <CommunityServerRouteContext value={{ serverId, serverParam: serverParam ?? "" }}>
    {content}
  </CommunityServerRouteContext>
}
