"use client"

import { useMeRouteMemory } from "@/hooks/community/use-me-route-memory"
import { Suspense, useEffect, useMemo } from "react"
import { CommunityModuleRouteContext, useCommunityRouter } from "@/contexts/community/module-route"
import { normalizeCommunityHref, resolveCommunityModulePlan } from "@/lib/community/community-route"
import { CommunityPendingFrame } from "./community-pending-frame"
import { ServerConversationRoute } from "../channels/server-conversation-route"

import FriendsRoute from "../social/friends-route"
import PrivacyRoute from "../bots/me-privacy-route"
import ScheduleRoute from "../schedule/me-schedule-route"
import BotsRoute from "../bots/me-bots-route"
import MachinesRoute from "../machines/me-machines-route"
import CommunityRootRoute from "./community-root-route"
import MeRootRoute from "./me-root-route"
import ServerLandingRoute from "./server-landing-route"
import ServerSettingsRoute from "./server-settings-route"
import { CommunityServerRouteContext } from "@/contexts/community/route-frame"
import { MessageRoute } from "../messages/message-route"

export function CommunityModuleRoute({ href, routeCommitted }: { href: string; routeCommitted: boolean }) {
  const target = normalizeCommunityHref(href)
  const plan = resolveCommunityModulePlan(target.href)
  useMeRouteMemory(target.pathname, routeCommitted)
  const landingServerId = plan.main.kind === "server-landing" ? plan.main.serverId : null
  const serverRouteContextValue = useMemo(
    () => landingServerId ? { serverId: landingServerId, serverParam: encodeURIComponent(landingServerId) } : null,
    [landingServerId],
  )
  const moduleRouteContextValue = useMemo(
    () => ({ href: target.href, routeCommitted }),
    [routeCommitted, target.href],
  )
  const content = plan.route === "community-root-redirect" ? <CommunityRootRoute />
    : plan.route === "onboarding-preview" ? <CommunityRouteRedirect href={plan.canonicalHref!} />
    : plan.main.kind === "server-conversation" ? (
    <ServerConversationRoute serverId={plan.main.serverId} serverParam={encodeURIComponent(plan.main.serverId)}
      channelId={plan.main.leafId} href={target.href} routeCommitted={routeCommitted} />
  ) : plan.main.kind === "friends" ? <FriendsRoute />
    : plan.main.kind === "privacy" ? <PrivacyRoute />
    : plan.main.kind === "schedule" ? <ScheduleRoute />
    : plan.main.kind === "bots" ? <BotsRoute />
      : plan.main.kind === "machines" ? <MachinesRoute />
        : plan.main.kind === "me-root" ? <MeRootRoute />
          : plan.main.kind === "server-landing" ? (
            <CommunityServerRouteContext value={serverRouteContextValue!}>
              <ServerConversationRoute serverId={plan.main.serverId} serverParam={encodeURIComponent(plan.main.serverId)}
                channelId={null} href={target.href} routeCommitted={routeCommitted}>
                {plan.route === "server-settings-redirect" ? <ServerSettingsRoute /> : <ServerLandingRoute />}
              </ServerConversationRoute>
            </CommunityServerRouteContext>
          ) : plan.route === "message-resolution" ? <MessageRoute messageId={decodeURIComponent(target.pathname.split("/")[3]!)} /> : null
  return <CommunityModuleRouteContext value={moduleRouteContextValue}>
    <Suspense fallback={<CommunityPendingFrame href={target.href} reserveBackSlot={target.surface === "detail"} />}>
      {content}
    </Suspense>
  </CommunityModuleRouteContext>
}

function CommunityRouteRedirect({ href }: { href: string }) {
  const router = useCommunityRouter()
  useEffect(() => { router.replace(href) }, [href, router])
  return <CommunityPendingFrame href={href} />
}
