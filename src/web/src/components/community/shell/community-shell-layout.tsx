"use client"

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import { useDefaultLayout } from "react-resizable-panels"
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
  desktopUserBarOverlayWidth,
} from "./shell-frame-geometry"
import { Shell } from "./shell"

const SHELL_SURFACE_CLASS = "rounded-tl-xl rounded-tr-none rounded-br-none rounded-bl-none ring-0 border-l border-t border-border/40 shadow-none"
const MOBILE_SURFACE_TRANSITION_MS = 180
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
  transition?: {
    mode: string
    targetHref: string
  }
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
  transition,
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

  const isDesktop = breakpoint === "desktop"
  const isMobileList = breakpoint === "mobile" && surface === "list"
  const isMobileDetail = breakpoint === "mobile" && surface === "detail"
  const isInitial = breakpoint === "unknown"
  const isInitialDetail = isInitial && surface === "detail"
  const showUserBar = isDesktop || isMobileList || isInitial || preserveHiddenMobileModules
  const transitionMode = transition?.mode
  const transitionTargetHref = transition?.targetHref

  useEffect(() => {
    if (transitionMode !== "committed" || !transitionTargetHref) return
    const previousHref = previousCommittedHrefRef.current
    previousCommittedHrefRef.current = transitionTargetHref
    if (
      breakpoint !== "mobile"
      || !previousHref
      || previousHref === transitionTargetHref
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
  }, [breakpoint, surface, transitionMode, transitionTargetHref])
  useEffect(() => () => mobileSurfaceAnimationRef.current?.cancel(), [])

  const initialUserBarStyle = {
    "--community-desktop-user-bar-width": `${desktopUserBarOverlayWidth(sidebarWidth)}px`,
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
              data-slot="community-sidebar-panel"
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
                {sidebar}
              </div>
            </ResizablePanel>
            <ResizableHandle className={cn("bg-transparent", !isDesktop && "hidden")} />
            <ResizablePanel
              data-slot="community-main-panel"
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
                {main}
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
              isMobileDetail && preserveHiddenMobileModules && "hidden",
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
            {userBar}
          </div>
        )}
      </div>
      {overlays}
    </Shell>
  )
}
