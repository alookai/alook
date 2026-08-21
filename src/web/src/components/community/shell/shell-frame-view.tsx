"use client"

import { useEffect, useRef, useState } from "react"
import { useDefaultLayout } from "react-resizable-panels"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { AppSurface } from "@/components/ui/app-surface"
import { ChannelLoadingFrame } from "@/components/community/channels/channel-loading-frame"
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
  if (breakpoint === "unknown") {
    return (
      <Shell onNavigationIntent={cancelPendingNavigation}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <ChannelLoadingFrame />
        </div>
      </Shell>
    )
  }

  return (
    <Shell onNavigationIntent={cancelPendingNavigation}>
      {!isMobileDetail && <ServerRail {...rail.railProps} bottomInset={60} />}
      <div
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col",
          !isMobileDetail && "pt-2",
        )}
      >
        <AppSurface
          className={cn(
            SHELL_SURFACE_CLASS,
            isMobileDetail && "rounded-none border-0 bg-background shadow-none ring-0",
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
                isDesktop && "pb-15",
              )}
            >
              <div ref={sidebarPanelRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
                {!isMobileDetail && (isDesktop ? sidebar() : sidebar({ noHeader: false }))}
                {isMobileList && (
                  <UserBar
                    user={user}
                    onOpenProfile={profile.openProfile}
                    onEditProfile={profile.openUserSettings}
                    inbox={inboxElement}
                    hasUnread={inbox.hasUnread}
                    inboxOpen={inbox.open}
                    onInboxOpenChange={inbox.onOpenChange}
                  />
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
              )}
            >
              {navigationPending && !isMobileList ? <ChannelLoadingFrame /> : children}
            </ResizablePanel>
          </ResizablePanelGroup>
        </AppSurface>

        {isDesktop && (
          <div
            className="absolute bottom-0 left-0 z-10"
            style={{
              width: desktopUserBarOverlayWidth(sidebarWidth),
              marginLeft: -COMMUNITY_RAIL_WIDTH,
            }}
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

        {isMobileList && navigationPending && (
          <div className="absolute inset-0 z-20 flex bg-background">
            <ChannelLoadingFrame />
          </div>
        )}
      </div>
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
    </Shell>
  )
}
