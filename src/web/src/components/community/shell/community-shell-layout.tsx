"use client"

import {
  useCallback,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react"
import { useDefaultLayout, type PanelSize } from "react-resizable-panels"
import { AppSurface } from "@/components/ui/app-surface"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import type { Breakpoint } from "@/hooks/use-mobile"
import type { CommunitySurface } from "@/lib/community/community-route"
import { cn } from "@/lib/utils"
import {
  COMMUNITY_RAIL_WIDTH,
  COMMUNITY_SIDEBAR_DEFAULT_PERCENTAGE,
  COMMUNITY_SIDEBAR_MAX_WIDTH,
  COMMUNITY_SIDEBAR_MIN_WIDTH,
  COMMUNITY_USER_BAR_HEIGHT_CSS,
  desktopUserBarOverlayCssWidth,
  desktopUserBarOverlayWidth,
} from "./shell-frame-geometry"
import { Shell } from "./shell"
import { useHydratedClient } from "./use-hydrated-client"

const SHELL_SURFACE_CLASS = "rounded-tl-xl rounded-tr-none rounded-br-none rounded-bl-none ring-0 border-l border-t border-border/40 shadow-none"
const communityLayoutStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: (key) => typeof localStorage === "undefined" ? null : localStorage.getItem(key),
  setItem: (key, value) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value)
  },
}

type CommunityShellLayoutProps = {
  breakpoint: Breakpoint
  surface: CommunitySurface
  rail: ReactNode
  sidebar: ReactNode
  main: ReactNode
  userBar: ReactNode
  overlays?: ReactNode
  onNavigationIntent?: () => void
  busy?: boolean
  label?: string
  routeKind?: string
  testId?: string
  preserveHiddenMobileModules?: boolean
}

/** The single geometry owner for authenticated and session-pending community shells. */
export function CommunityShellLayout({
  breakpoint,
  surface,
  rail,
  sidebar,
  main,
  userBar,
  overlays,
  onNavigationIntent,
  busy,
  label,
  routeKind,
  testId,
  preserveHiddenMobileModules = false,
}: CommunityShellLayoutProps) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "community-shell",
    onlySaveAfterUserInteractions: true,
    storage: communityLayoutStorage,
  })
  const hydratedClient = useHydratedClient()
  const sidebarPanelRef = useRef<HTMLDivElement>(null)
  const userBarOverlayRef = useRef<HTMLDivElement>(null)
  const syncDesktopUserBarWidth = useCallback((size: PanelSize) => {
    const measuredSidebarWidth = sidebarPanelRef.current?.getBoundingClientRect().width
    const sidebarWidth = measuredSidebarWidth && measuredSidebarWidth > 0
      ? measuredSidebarWidth
      : size.inPixels
    userBarOverlayRef.current?.style.setProperty(
      "--community-desktop-user-bar-width",
      `${desktopUserBarOverlayWidth(sidebarWidth)}px`,
    )
  }, [])

  const isDesktop = breakpoint === "desktop"
  const isMobileList = breakpoint === "mobile" && surface === "list"
  const isMobileDetail = breakpoint === "mobile" && surface === "detail"
  const isInitial = breakpoint === "unknown"
  const isInitialDetail = isInitial && surface === "detail"
  const sidebarMobileActive = isMobileList || (isInitial && surface === "list")
  const sidebarMobileHidden = isMobileDetail || isInitialDetail
  const mainMobileActive = isMobileDetail || isInitialDetail
  const mainMobileHidden = isMobileList || (isInitial && surface === "list")
  const showUserBar = isDesktop || isMobileList || isInitial || preserveHiddenMobileModules

  const sidebarPercentage = hydratedClient
    ? defaultLayout?.sidebar ?? COMMUNITY_SIDEBAR_DEFAULT_PERCENTAGE
    : COMMUNITY_SIDEBAR_DEFAULT_PERCENTAGE
  const initialUserBarStyle = {
    "--community-desktop-user-bar-width": desktopUserBarOverlayCssWidth(
      sidebarPercentage,
      hydratedClient,
    ),
    marginLeft: -COMMUNITY_RAIL_WIDTH,
  } as CSSProperties

  return (
    <Shell
      onNavigationIntent={onNavigationIntent}
      aria-busy={busy ? "true" : undefined}
      aria-label={label}
      data-community-route-kind={routeKind}
      data-testid={testId}
      data-slot="community-shell-root"
    >
      {(!isMobileDetail || preserveHiddenMobileModules) && (
        <div className={cn(
          "flex min-h-0",
          isInitialDetail && "hidden sm:contents",
          isMobileDetail && preserveHiddenMobileModules && "hidden",
        )}>
          {rail}
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
          data-slot="community-app-surface"
          className={cn(
            SHELL_SURFACE_CLASS,
            isMobileDetail && "rounded-none border-0 bg-background shadow-none ring-0",
            isInitialDetail && "max-sm:rounded-none max-sm:border-0 max-sm:bg-background max-sm:shadow-none max-sm:ring-0",
          )}
        >
          <ResizablePanelGroup
            key={hydratedClient ? "persisted-layout" : "ssr-layout"}
            id="community-shell"
            orientation="horizontal"
            disabled={!isDesktop}
            className={cn(
              "min-h-0 flex-1",
              !isDesktop && [
                "max-sm:*:data-[mobile-active=true]:flex-1!",
                "max-sm:*:data-[mobile-hidden=true]:hidden!",
              ],
            )}
            defaultLayout={hydratedClient ? defaultLayout : undefined}
            onLayoutChanged={onLayoutChanged}
          >
            <ResizablePanel
              id="sidebar"
              defaultSize={`${COMMUNITY_SIDEBAR_DEFAULT_PERCENTAGE}%`}
              minSize={COMMUNITY_SIDEBAR_MIN_WIDTH}
              maxSize={COMMUNITY_SIDEBAR_MAX_WIDTH}
              onResize={syncDesktopUserBarWidth}
              hidden={isMobileDetail}
              data-mobile-active={sidebarMobileActive || undefined}
              data-mobile-hidden={sidebarMobileHidden || undefined}
              className={cn(
                "flex flex-col bg-sidebar",
                (isDesktop || isMobileList || isInitial) && "pb-[calc(3.75rem+var(--app-safe-area-bottom))] sm:pb-15",
              )}
            >
              <div
                ref={sidebarPanelRef}
                data-community-mobile-surface={isMobileList ? "list" : undefined}
                className="flex min-h-0 min-w-0 flex-1 flex-col"
              >
                {sidebar}
              </div>
            </ResizablePanel>
            <ResizableHandle className={cn("bg-transparent", !isDesktop && "hidden")} />
            <ResizablePanel
              id="main"
              defaultSize="76%"
              hidden={isMobileList}
              data-mobile-active={mainMobileActive || undefined}
              data-mobile-hidden={mainMobileHidden || undefined}
              className="flex min-w-0 flex-col bg-background"
            >
              <div
                data-community-mobile-surface={isMobileDetail ? "detail" : undefined}
                className="flex min-h-0 flex-1 flex-col"
              >
                {main}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </AppSurface>

        {showUserBar && (
          <div
            ref={userBarOverlayRef}
            data-slot="community-user-bar-overlay"
            className={cn(
              "absolute bottom-0 left-0 z-10",
              isDesktop && "w-(--community-desktop-user-bar-width)",
              isInitial && "w-[calc(100%+3.5rem)] sm:w-(--community-desktop-user-bar-width)",
              isInitialDetail && "max-sm:hidden",
              isMobileDetail && preserveHiddenMobileModules && "hidden",
            )}
            style={isMobileList ? {
                  width: `calc(100% + ${COMMUNITY_RAIL_WIDTH}px)`,
                  marginLeft: -COMMUNITY_RAIL_WIDTH,
                }
              : initialUserBarStyle}
          >
            <div
              data-slot="community-user-bar-underlay"
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 bg-linear-to-t from-(--app-bg) to-transparent"
              style={{ height: COMMUNITY_USER_BAR_HEIGHT_CSS }}
            />
            {userBar}
          </div>
        )}
      </div>
      {overlays}
    </Shell>
  )
}
