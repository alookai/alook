"use client"

import { useMeRouteMemory } from "@/hooks/community/use-me-route-memory"
import { lazy, Suspense } from "react"
import { CommunityModuleRouteContext } from "@/contexts/community/module-route"
import { normalizeCommunityHref, resolveCommunityModulePlan } from "@/lib/community/community-route"
import { CommunityPendingFrame } from "./community-pending-frame"

const ServerConversationRoute = lazy(() => import("../channels/server-conversation-route").then(module => ({ default: module.ServerConversationRoute })))
const FriendsRoute = lazy(() => import("../social/friends-route"))
const BotsRoute = lazy(() => import("../bots/me-bots-route"))
const MachinesRoute = lazy(() => import("../machines/me-machines-route"))

export function CommunityModuleRoute({ href, routeCommitted }: { href: string; routeCommitted: boolean }) {
  const target = normalizeCommunityHref(href)
  const plan = resolveCommunityModulePlan(target.href)
  useMeRouteMemory(target.pathname, routeCommitted)
  const content = plan.main.kind === "server-conversation" ? (
    <ServerConversationRoute serverId={plan.main.serverId} serverParam={encodeURIComponent(plan.main.serverId)}
      channelId={plan.main.leafId} href={target.href} routeCommitted={routeCommitted} />
  ) : plan.main.kind === "friends" ? <FriendsRoute />
    : plan.main.kind === "bots" ? <BotsRoute />
      : plan.main.kind === "machines" ? <MachinesRoute /> : null
  return <CommunityModuleRouteContext value={{ href: target.href, routeCommitted }}>
    <Suspense fallback={<CommunityPendingFrame href={target.href} reserveBackSlot={target.surface === "detail"} />}>
      {content}
    </Suspense>
  </CommunityModuleRouteContext>
}
