"use client"

import { useEffect, useRef, useState, type CSSProperties } from "react"
import { useDefaultLayout } from "react-resizable-panels"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { AppSurface } from "@/components/ui/app-surface"
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
import type { CommunitySurface } from "@/lib/community/community-route"
import type { ShellFrameProps } from "./shell-frame-types"
import type { useShellRailController } from "./use-shell-rail-controller"
import type { useShellProfileController } from "./use-shell-profile-controller"
import type { useShellInboxController } from "./use-shell-inbox-controller"

type Props = Pick<ShellFrameProps, "sidebar" | "children" | "extraDialogs"> & {
  breakpoint: Breakpoint
  surface: CommunitySurface
  loadingHref: string
  cancelPendingNavigation: () => void
  navigationPending: boolean
  rail: ReturnType<typeof useShellRailController>
  profile: ReturnType<typeof useShellProfileController>
  inbox: ReturnType<typeof useShellInboxController>
}

const SHELL_SURFACE_CLASS = "rounded-tl-xl rounded-tr-none rounded-br-none rounded-bl-none ring-0 border-l border-t border-border/40 shadow-none"

export function ShellFrameView({
  breakpoint,
  surface,
  loadingHref,
  sidebar,
  children,
  extraDialogs,
  cancelPendingNavigation,
  navigationPending,
  rail,
  profile,
  inbox,
}: Props) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "community-shell",
    onlySaveAfterUserInteractions: true,
  })
  const sidebarPanelRef = useRef<HTMLDivElement>(null)
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

  const inboxElement = <InboxPopover {...inbox.popoverProps} />
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
  const initialUserBarStyle = {
    "--community-desktop-user-bar-width": `${desktopUserBarOverlayWidth(sidebarWidth)}px`,
    marginLeft: -COMMUNITY_RAIL_WIDTH,
  } as CSSProperties

  return (
    <Shell onNavigationIntent={cancelPendingNavigation}>
      {!isMobileDetail && (
        <div className={cn(isInitialDetail && "hidden sm:contents")}>
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
                (isDesktop || isMobileList || isInitial) && "pb-15",
                isInitial && surface === "list" && "max-sm:flex-1!",
                isInitialDetail && "max-sm:hidden",
              )}
            >
              <div ref={sidebarPanelRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
                {!isMobileDetail && (isDesktop ? sidebar() : sidebar({ noHeader: false }))}
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
              {navigationPending || isInitial ? (
                isInitialDetail ? (
                  <>
                    <div className="flex min-h-0 flex-1 sm:hidden">
                      <CommunityPendingFrame href={loadingHref} reserveBackSlot />
                    </div>
                    <div className="hidden min-h-0 flex-1 sm:flex">
                      <CommunityPendingFrame href={loadingHref} />
                    </div>
                  </>
                ) : (
                  <CommunityPendingFrame
                    href={loadingHref}
                    reserveBackSlot={isMobileDetail}
                  />
                )
              ) : children}
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
          {...(isDesktop && profile.profile ? {
            profileStatusSeeds: {
              initialStatusEmoji: profile.profile.initialStatusEmoji,
              initialStatusText: profile.profile.initialStatusText,
            },
          } : {})}
          extraDialogs={extraDialogs}
        />
      )}
    </Shell>
  )
}
