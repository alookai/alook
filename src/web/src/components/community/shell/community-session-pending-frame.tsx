"use client"

import { ChannelSidebarSkeleton } from "@/components/community/channels/channel-sidebar"
import { DmSidebarSkeleton } from "@/components/community/channels/dm-sidebar"
import { AppSurface } from "@/components/ui/app-surface"
import { useBreakpoint } from "@/hooks/use-mobile"
import { resolveCommunityModulePlan } from "@/lib/community/community-route"
import { tid } from "@/lib/community/testids"
import { CommunityPendingFrame } from "./community-pending-frame"
import { CommunityShellLayout } from "./community-shell-layout"
import { ServerRailPending } from "./server-rail"
import { Shell } from "./shell"
import { UserBarSkeleton } from "./user-bar"

/** Stable, inert viewport shown before authenticated community providers exist. */
export function CommunitySessionPendingFrame({ pathname }: { pathname: string }) {
  const breakpoint = useBreakpoint()
  const plan = resolveCommunityModulePlan(pathname)
  const showCommunityShell = plan.rail === "community"
  if (!showCommunityShell) {
    return (
      <Shell
        data-testid={tid.initialFrame}
        data-community-route-kind={plan.route}
        aria-busy="true"
        aria-label="Loading community"
      >
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <AppSurface className="rounded-none border-0 bg-background">
            {plan.main.kind !== "none" && (
              <CommunityPendingFrame href={pathname} plan={plan} />
            )}
          </AppSurface>
        </div>
      </Shell>
    )
  }

  return (
    <CommunityShellLayout
      breakpoint={breakpoint}
      surface={plan.surface === "list" ? "list" : "detail"}
      rail={<ServerRailPending bottomInset={60} />}
      sidebar={plan.sidebar.kind === "server"
        ? <ChannelSidebarSkeleton targetServerId={plan.sidebar.serverId} />
        : <DmSidebarSkeleton />}
      main={<CommunityPendingFrame
        href={pathname}
        plan={plan}
        reserveBackSlot={plan.surface === "detail"}
      />}
      userBar={<UserBarSkeleton />}
      testId={tid.initialFrame}
      routeKind={plan.route}
      busy
      label="Loading community"
      preserveHiddenMobileModules
    />
  )
}
