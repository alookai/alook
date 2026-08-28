"use client"

import type { ReactNode } from "react"
import { BotListSkeleton } from "@/components/community/bots/bot-list-view"
import { ChannelLoadingFrame } from "@/components/community/channels/channel-loading-frame"
import { DmLoadingFrame } from "@/components/community/channels/dm-loading-frame"
import { MachineListSkeleton } from "@/components/community/machines/machine-list"
import { FriendsPage } from "@/components/community/social/friends-page"
import { Skeleton } from "@/components/ui/skeleton"
import {
  resolveCommunityModulePlan,
  type CommunityModulePlan,
} from "@/lib/community/community-route"
import { tid } from "@/lib/community/testids"

function MeRootPendingFrame() {
  return (
    <main aria-busy="true" aria-label="Loading your space" className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-5/6" />
    </main>
  )
}

function ServerLandingPendingFrame() {
  return (
    <main aria-busy="true" aria-label="Loading server" className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-3">
        <Skeleton className="size-6 rounded-md" />
        <Skeleton className="h-4 w-32 rounded" />
      </header>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4">
        <Skeleton className="size-12 rounded-xl" />
        <Skeleton className="h-4 w-36 rounded" />
        <Skeleton className="h-3 w-52 max-w-full rounded" />
      </div>
    </main>
  )
}

function RouteResolutionPendingFrame() {
  return (
    <main
      aria-busy="true"
      aria-label="Resolving community route"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-background p-4"
    >
      <Skeleton className="size-10 rounded-xl" />
      <Skeleton className="h-4 w-40 rounded" />
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
      content = <ChannelLoadingFrame />
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
