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
import {
  COMMUNITY_RAIL_WIDTH,
  desktopUserBarOverlayWidth,
} from "./shell-frame-geometry"
import type { Breakpoint } from "@/hooks/use-mobile"
import type { MobileZone } from "./mobile-zone"
import type { ShellFrameProps } from "./shell-frame-types"
import type { useShellRailController } from "./use-shell-rail-controller"
import type { useShellProfileController } from "./use-shell-profile-controller"
import type { useShellInboxController } from "./use-shell-inbox-controller"

type Props = Pick<ShellFrameProps, "sidebar" | "children" | "extraDialogs"> & {
  breakpoint: Breakpoint
  mobileZone: MobileZone
  cancelPendingNavigation: () => void
  navigationPending: boolean
  rail: ReturnType<typeof useShellRailController>
  profile: ReturnType<typeof useShellProfileController>
  inbox: ReturnType<typeof useShellInboxController>
}

const SHELL_SURFACE_CLASS = "rounded-tl-xl rounded-tr-none rounded-br-none rounded-bl-none ring-0 border-l border-t border-border/40 shadow-none"

export function ShellFrameView({
  breakpoint,
  mobileZone,
  sidebar,
  children,
  extraDialogs,
  cancelPendingNavigation,
  navigationPending,
  rail,
  profile,
  inbox,
}: Props) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: "community-shell" })
  const sidebarPanelRef = useRef<HTMLDivElement>(null)
  const [sidebarWidth, setSidebarWidth] = useState(240)
  useEffect(() => {
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

  if (breakpoint === "desktop") {
    return (
      <Shell onNavigationIntent={cancelPendingNavigation}>
        <ServerRail {...rail.railProps} bottomInset={60} />
        <div className="relative flex-1 flex flex-col min-w-0 pt-2">
          <AppSurface className={SHELL_SURFACE_CLASS}>
            <ResizablePanelGroup
              id="community-shell"
              orientation="horizontal"
              className="min-h-0 flex-1"
              defaultLayout={defaultLayout}
              onLayoutChanged={onLayoutChanged}
            >
              <ResizablePanel
                id="sidebar"
                defaultSize="24%"
                minSize={160}
                maxSize={360}
                className="flex flex-col bg-sidebar pb-15"
              >
                <div ref={sidebarPanelRef} className="flex min-h-0 flex-1 flex-col">
                  {sidebar()}
                </div>
              </ResizablePanel>
              <ResizableHandle className="bg-transparent" />
              <ResizablePanel
                id="main"
                defaultSize="76%"
                className="flex min-w-0 flex-col bg-background"
              >
                {navigationPending ? <ChannelLoadingFrame /> : children}
              </ResizablePanel>
            </ResizablePanelGroup>
          </AppSurface>
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
        </div>
        <ShellFrameOverlays
          controller={profile}
          breakpoint={breakpoint}
          profileStatusSeeds={profile.profile ? {
            initialStatusEmoji: profile.profile.initialStatusEmoji,
            initialStatusText: profile.profile.initialStatusText,
          } : undefined}
          extraDialogs={extraDialogs}
        />
      </Shell>
    )
  }

  return (
    <Shell onNavigationIntent={cancelPendingNavigation}>
      {mobileZone === "nav" && (
        <>
          <ServerRail {...rail.railProps} bottomInset={60} />
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col pt-2">
            <AppSurface className={SHELL_SURFACE_CLASS}>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-sidebar">
                <div className="flex min-h-0 min-w-0 flex-1">
                  {sidebar({ noHeader: false })}
                </div>
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
            </AppSurface>
          </div>
        </>
      )}
      {mobileZone === "messages" && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          {navigationPending ? <ChannelLoadingFrame /> : children}
        </div>
      )}
      {mobileZone === "nav" && navigationPending && (
        <div className="absolute inset-0 z-20 flex bg-background">
          <ChannelLoadingFrame />
        </div>
      )}
      <ShellFrameOverlays
        controller={profile}
        breakpoint={breakpoint}
        extraDialogs={extraDialogs}
      />
    </Shell>
  )
}
