"use client"

import { useEffect, useRef, useState, type CSSProperties } from "react"
import { useDefaultLayout } from "react-resizable-panels"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { AppSurface } from "@/components/ui/app-surface"
import { ChannelSidebarSkeleton } from "@/components/community/channels/channel-sidebar"
import { DmSidebarSkeleton } from "@/components/community/channels/dm-sidebar"
import { CommunityPendingFrame } from "./community-pending-frame"
import { Shell } from "./shell"
import { ServerRail } from "./server-rail"
import { UserBar } from "./user-bar"
import { InboxPopover } from "./community-inbox-popover"
import { ShellFrameOverlays } from "./shell-frame-overlays"
import { cn } from "@/lib/utils"
import {
  COMMUNITY_RAIL_WIDTH,
  desktopUserBarOverlayWidth,
} from "./shell-frame-geometry"
import type { Breakpoint } from "@/hooks/use-mobile"
import type { CommunityCheckpointPlan } from "@/lib/community/community-route"
import type { ShellFrameProps } from "./shell-frame-types"
import type { useShellRailController } from "./use-shell-rail-controller"
import type { useShellProfileController } from "./use-shell-profile-controller"
import type { useShellInboxController } from "./use-shell-inbox-controller"

type Props = Pick<ShellFrameProps, "sidebar" | "children" | "extraDialogs"> & {
  breakpoint: Breakpoint
  checkpoint: CommunityCheckpointPlan
  cancelPendingNavigation: () => void
  rail: ReturnType<typeof useShellRailController>
  profile: ReturnType<typeof useShellProfileController>
  inbox: ReturnType<typeof useShellInboxController>
}

const SHELL_SURFACE_CLASS = "rounded-tl-xl rounded-tr-none rounded-br-none rounded-bl-none ring-0 border-l border-t border-border/40 shadow-none"
const MOBILE_SURFACE_TRANSITION_MS = 180

export function ShellFrameView({
  breakpoint,
  checkpoint,
  sidebar,
  children,
  extraDialogs,
  cancelPendingNavigation,
  rail,
  profile,
  inbox,
}: Props) {
  const { surface } = checkpoint
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "community-shell",
    onlySaveAfterUserInteractions: true,
  })
  const sidebarPanelRef = useRef<HTMLDivElement>(null)
  const mainPanelRef = useRef<HTMLDivElement>(null)
  const previousCommittedHrefRef = useRef<string | null>(null)
  const mobileSurfaceAnimationRef = useRef<Animation | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(240)
  useEffect(() => {
    if (breakpoint !== "desktop") return
    const element = sidebarPanelRef.current
    if (!element) return
    setSidebarWidth(element.offsetWidth)
    const observer = new ResizeObserver(([entry]) => setSidebarWidth(entry!.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [breakpoint])

  const inboxElement = (
    <InboxPopover
      {...inbox.popoverProps}
      surface={breakpoint === "mobile" ? "mobile" : "desktop"}
    />
  )
  const user = {
    id: profile.currentUser.id,
    name: profile.currentUser.name,
    avatar: profile.currentUser.avatar,
  }

  const isDesktop = breakpoint === "desktop"
  const isMobileList = breakpoint === "mobile" && surface === "list"
  const isMobileDetail = breakpoint === "mobile" && surface === "detail"
  const isInitial = breakpoint === "unknown"
  const isInitialDetail = isInitial && surface === "detail"
  const showUserBar = isDesktop || isMobileList || isInitial
  useEffect(() => {
    if (checkpoint.mode !== "committed") return
    const previousHref = previousCommittedHrefRef.current
    previousCommittedHrefRef.current = checkpoint.targetHref
    if (
      breakpoint !== "mobile"
      || !previousHref
      || previousHref === checkpoint.targetHref
      || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) return

    const element = surface === "list" ? sidebarPanelRef.current : mainPanelRef.current
    if (!element?.animate) return
    mobileSurfaceAnimationRef.current?.cancel()
    mobileSurfaceAnimationRef.current = element.animate([
      {
        opacity: 0.92,
        transform: `translate3d(${surface === "list" ? -8 : 8}px, 0, 0)`,
      },
      { opacity: 1, transform: "translate3d(0, 0, 0)" },
    ], {
      duration: MOBILE_SURFACE_TRANSITION_MS,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    })
  }, [breakpoint, checkpoint.mode, checkpoint.targetHref, surface])
  useEffect(() => () => mobileSurfaceAnimationRef.current?.cancel(), [])
  const initialUserBarStyle = {
    "--community-desktop-user-bar-width": `${desktopUserBarOverlayWidth(sidebarWidth)}px`,
    marginLeft: -COMMUNITY_RAIL_WIDTH,
  } as CSSProperties

  return (
    <Shell onNavigationIntent={cancelPendingNavigation}>
      {!isMobileDetail && (
        <div className={cn("flex min-h-0", isInitialDetail && "hidden sm:contents")}>
          <ServerRail {...rail.railProps} bottomInset={60} />
        </div>
      )}
      <div
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col",
          !isMobileDetail && !isInitialDetail && "pt-2",
          isInitialDetail && "pt-0 sm:pt-2",
        )}
      >
        <AppSurface
          className={cn(
            SHELL_SURFACE_CLASS,
            isMobileDetail && "rounded-none border-0 bg-background shadow-none ring-0",
            isInitialDetail && "max-sm:rounded-none max-sm:border-0 max-sm:bg-background max-sm:shadow-none max-sm:ring-0",
          )}
        >
          <ResizablePanelGroup
            id="community-shell"
            orientation="horizontal"
            disabled={!isDesktop}
            className={cn(
              "min-h-0 flex-1",
              !isDesktop && "*:data-[mobile-active=true]:flex-1!",
            )}
            defaultLayout={defaultLayout}
            onLayoutChanged={onLayoutChanged}
          >
            <ResizablePanel
              id="sidebar"
              defaultSize="24%"
              minSize={160}
              maxSize={360}
              hidden={isMobileDetail}
              data-mobile-active={isMobileList || undefined}
              className={cn(
                "flex flex-col bg-sidebar",
                (isDesktop || isMobileList || isInitial) && "pb-[calc(3.75rem+var(--app-safe-area-bottom))] sm:pb-15",
                isInitial && surface === "list" && "max-sm:flex-1!",
                isInitialDetail && "max-sm:hidden",
              )}
            >
              <div
                ref={sidebarPanelRef}
                data-community-mobile-surface={isMobileList ? "list" : undefined}
                className="flex min-h-0 min-w-0 flex-1 flex-col"
              >
                {!isMobileDetail && (
                  checkpoint.sidebar.kind === "server-skeleton"
                    ? <ChannelSidebarSkeleton targetServerId={checkpoint.sidebar.serverId} />
                    : checkpoint.sidebar.kind === "me-skeleton"
                      ? <DmSidebarSkeleton />
                      : isDesktop ? sidebar() : sidebar({ noHeader: false })
                )}
              </div>
            </ResizablePanel>
            <ResizableHandle className={cn("bg-transparent", !isDesktop && "hidden")} />
            <ResizablePanel
              id="main"
              defaultSize="76%"
              hidden={isMobileList}
              data-mobile-active={isMobileDetail || undefined}
              className={cn(
                "flex min-w-0 flex-col bg-background",
                isInitial && surface === "list" && "max-sm:hidden",
                isInitialDetail && "max-sm:flex-1!",
              )}
            >
              <div
                ref={mainPanelRef}
                data-community-mobile-surface={isMobileDetail ? "detail" : undefined}
                className="flex min-h-0 flex-1 flex-col"
              >
                {checkpoint.main.kind === "target-skeleton" || isInitial ? (
                  <CommunityPendingFrame
                    href={checkpoint.targetHref}
                    reserveBackSlot={surface === "detail"}
                  />
                ) : children}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </AppSurface>

        {showUserBar && (
          <div
            data-slot="community-user-bar-overlay"
            className={cn(
              "absolute bottom-0 left-0 z-10",
              isInitial && "w-[calc(100%+3.5rem)] sm:w-(--community-desktop-user-bar-width)",
              isInitialDetail && "max-sm:hidden",
            )}
            style={isDesktop
              ? {
                  width: desktopUserBarOverlayWidth(sidebarWidth),
                  marginLeft: -COMMUNITY_RAIL_WIDTH,
                }
              : isMobileList ? {
                  width: `calc(100% + ${COMMUNITY_RAIL_WIDTH}px)`,
                  marginLeft: -COMMUNITY_RAIL_WIDTH,
                }
              : initialUserBarStyle}
          >
            <UserBar
              breakpoint={breakpoint}
              user={user}
              onOpenProfile={profile.openProfile}
              onEditProfile={profile.openUserSettings}
              inbox={inboxElement}
              hasUnread={inbox.hasUnread}
              inboxOpen={inbox.open}
              onInboxOpenChange={inbox.onOpenChange}
            />
          </div>
        )}

      </div>
      {!isInitial && (
        <ShellFrameOverlays
          controller={profile}
          breakpoint={breakpoint}
          extraDialogs={extraDialogs}
        />
      )}
    </Shell>
  )
}
