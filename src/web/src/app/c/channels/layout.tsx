"use client"

import type { ReactNode } from "react"
import { useSelectedLayoutSegments, usePathname, useSearchParams } from "next/navigation"
import { CommunityServerRouteContext, useCommunityRouteFrame } from "@/components/community/shell/community-route-context"
import { ServerConversationRoute } from "@/components/community/channels/server-conversation-route"
import { normalizeCommunityHref, resolveCommunityModulePlan } from "@/lib/community/community-route"

export default function ServerLayout({ children }: { children: ReactNode }) {
  const segments = useSelectedLayoutSegments()
  const serverParam = segments[0]
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { navigation } = useCommunityRouteFrame()
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
  return <CommunityServerRouteContext value={{ serverId, serverParam: serverParam ?? "" }}>
    <ServerConversationRoute serverId={serverId} serverParam={serverParam ?? ""}
      channelId={routeChannelId} href={targetHref.href} routeCommitted={publishedHref.href === targetHref.href}>
      {children}
    </ServerConversationRoute>
  </CommunityServerRouteContext>
}
