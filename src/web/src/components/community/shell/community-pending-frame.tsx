"use client"

import type { ReactNode } from "react"
import { BotListSkeleton } from "@/components/community/bots/bot-list-view"
import { ConversationResolutionPendingFrame } from "@/components/community/channels/conversation-resolution-pending-frame"
import { DmLoadingFrame } from "@/components/community/channels/dm-loading-frame"
import { MachineListSkeleton } from "@/components/community/machines/machine-list"
import { FriendsPage } from "@/components/community/social/friends-page"
import { ServerLandingPendingFrame } from "./server-landing-pending-frame"
import { UnresolvedMainSkeleton } from "./unresolved-main-skeleton"
import {
  resolveCommunityModulePlan,
  type CommunityModulePlan,
} from "@/lib/community/community-route"
import { tid } from "@/lib/community/testids"

function MeRootPendingFrame() {
  return (
    <main aria-busy="true" aria-label="Loading your space" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <UnresolvedMainSkeleton />
    </main>
  )
}

function RouteResolutionPendingFrame() {
  return (
    <main
      aria-busy="true"
      aria-label="Resolving community route"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <UnresolvedMainSkeleton />
    </main>
  )
}

export function CommunityPendingFrame({
  href,
  reserveBackSlot = false,
  plan: suppliedPlan,
}: {
  href: string
  reserveBackSlot?: boolean
  plan?: CommunityModulePlan
}) {
  const plan = suppliedPlan ?? resolveCommunityModulePlan(href)
  const reserveMeBackSlot = reserveBackSlot || (
    plan.surface === "detail" && plan.sidebar.kind === "me"
  )
  let content: ReactNode
  switch (plan.main.kind) {
    case "me-root":
      content = <MeRootPendingFrame />
      break
    case "machines":
      content = <MachineListSkeleton reserveBackSlot={reserveMeBackSlot} />
      break
    case "bots":
      content = <BotListSkeleton reserveBackSlot={reserveMeBackSlot} />
      break
    case "friends":
      content = (
        <FriendsPage
          friends={[]}
          pending={[]}
          blocked={[]}
          loading
          reserveBackSlot={reserveMeBackSlot}
        />
      )
      break
    case "dm":
      content = <DmLoadingFrame reserveBackSlot={reserveMeBackSlot} />
      break
    case "server-landing":
      content = <ServerLandingPendingFrame />
      break
    case "server-conversation":
      content = <ConversationResolutionPendingFrame />
      break
    case "route-resolution":
      content = <RouteResolutionPendingFrame />
      break
    case "none":
      return null
  }
  return (
    <div
      data-testid={tid.pendingMain(plan.main.kind)}
      data-community-main-kind={plan.main.kind}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {content}
    </div>
  )
}
