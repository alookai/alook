import type { CSSProperties } from "react"
import { ChannelSidebarSkeleton } from "@/components/community/channels/channel-sidebar"
import { DmSidebarSkeleton } from "@/components/community/channels/dm-sidebar"
import { AppBackground, AppSurface } from "@/components/ui/app-surface"
import { Skeleton } from "@/components/ui/skeleton"
import { resolveCommunityModulePlan } from "@/lib/community/community-route"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { CommunityPendingFrame } from "./community-pending-frame"
import {
  COMMUNITY_RAIL_WIDTH,
  desktopUserBarOverlayWidth,
} from "./shell-frame-geometry"
import { ServerRailSkeleton } from "./server-rail"
import { UserBarSkeleton } from "./user-bar"

const SESSION_SIDEBAR_WIDTH = 240
const SESSION_USER_BAR_WIDTH = desktopUserBarOverlayWidth(SESSION_SIDEBAR_WIDTH)

function SessionRail() {
  return (
    <nav
      aria-hidden
      className="flex h-full w-14 shrink-0 flex-col items-center gap-2 pb-2 pt-1"
    >
      <Skeleton className="size-10 shrink-0 rounded-xl" />
      <div className="h-px w-8 shrink-0 bg-border/60" />
      <div className="min-h-0 w-full flex-1 overflow-hidden px-2">
        <ServerRailSkeleton />
      </div>
      <Skeleton className="mt-auto size-10 shrink-0 rounded-[20px]" />
    </nav>
  )
}

/** Stable, inert viewport shown before authenticated community providers exist. */
export function CommunitySessionPendingFrame({ pathname }: { pathname: string }) {
  const plan = resolveCommunityModulePlan(pathname)
  const showCommunityShell = plan.rail === "community"
  const showSidebar = plan.sidebar.kind !== "none"
  const showMain = plan.main.kind !== "none"
  const isList = plan.surface === "list"
  const isDetail = plan.surface === "detail"

  return (
    <div
      data-testid={tid.initialFrame}
      data-community-route-kind={plan.route}
      aria-busy="true"
      aria-label="Loading community"
      className="fixed inset-0 flex overflow-hidden font-sans text-sm text-foreground"
    >
      <AppBackground />
      {showCommunityShell && (
        <div className={cn("flex min-h-0", isDetail && "max-sm:hidden")}>
          <SessionRail />
        </div>
      )}
      <div
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col",
          showCommunityShell && isList && "pt-2",
          showCommunityShell && isDetail && "pt-0 sm:pt-2",
        )}
      >
        <AppSurface
          className={cn(
            "rounded-bl-none rounded-br-none rounded-tl-xl rounded-tr-none border-l border-t border-border/40 shadow-none ring-0",
            isDetail && "max-sm:rounded-none max-sm:border-0 max-sm:bg-background",
            !showCommunityShell && "rounded-none border-0 bg-background",
          )}
        >
          <div className="flex min-h-0 min-w-0 flex-1">
            {showSidebar && (
              <div
                data-community-sidebar-kind={plan.sidebar.kind}
                className={cn(
                  "min-h-0 shrink-0 flex-col border-r border-border/40 bg-sidebar pb-15 sm:flex",
                  isList ? "flex w-full sm:w-60" : "hidden w-60 sm:flex",
                )}
              >
                {plan.sidebar.kind === "server"
                  ? <ChannelSidebarSkeleton targetServerId={plan.sidebar.serverId} />
                  : <DmSidebarSkeleton />}
              </div>
            )}
            {showMain && (
              <div
                className={cn(
                  "min-h-0 min-w-0 flex-1 flex-col bg-background sm:flex",
                  isList ? "hidden" : "flex",
                )}
              >
                <CommunityPendingFrame
                  href={pathname}
                  plan={plan}
                  reserveBackSlot={isDetail}
                />
              </div>
            )}
          </div>
        </AppSurface>

        {showCommunityShell && (
          <div
            data-slot="community-user-bar-overlay"
            className={cn(
              "absolute bottom-0 left-0 z-10 w-[calc(100%+3.5rem)] sm:w-(--community-session-user-bar-width)",
              isDetail && "max-sm:hidden",
            )}
            style={{
              "--community-session-user-bar-width": `${SESSION_USER_BAR_WIDTH}px`,
              marginLeft: -COMMUNITY_RAIL_WIDTH,
            } as CSSProperties}
          >
            <UserBarSkeleton />
          </div>
        )}
      </div>
    </div>
  )
}
