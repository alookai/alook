"use client"

import {
  useCallback,
  useInsertionEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react"
import { flushSync } from "react-dom"
import {
  useDefaultLayout,
  type GroupImperativeHandle,
  type PanelImperativeHandle,
  type PanelSize,
} from "react-resizable-panels"
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
  COMMUNITY_LAYOUT_PREPAINT_ATTRIBUTE,
  COMMUNITY_LAYOUT_PREPAINT_SIDEBAR_WIDTH,
  COMMUNITY_LAYOUT_PREPAINT_USER_BAR_WIDTH,
  COMMUNITY_SIDEBAR_DEFAULT_WIDTH,
  COMMUNITY_SIDEBAR_MAX_WIDTH,
  COMMUNITY_SIDEBAR_MIN_WIDTH,
  COMMUNITY_SEPARATOR_WIDTH,
  COMMUNITY_USER_BAR_HEIGHT_CSS,
  desktopSidebarRestoreTarget,
  desktopUserBarInitialOverlayCssWidth,
  desktopUserBarOverlayWidth,
} from "./shell-frame-geometry"
import { Shell } from "./shell"
import { useHydratedClient } from "./use-hydrated-client"

const SHELL_SURFACE_CLASS = "rounded-tl-xl rounded-tr-none rounded-br-none rounded-bl-none ring-0 border-l border-t border-border/40 shadow-none"
const DESKTOP_PREPAINT_MEDIA_QUERY = "(min-width: 640px)"
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

type PendingDesktopRestore = {
  target: number | string
  animationFrame: number | null
}

const DESKTOP_RESTORE_PIXEL_EPSILON = 1 + (1 / 64)
const DESKTOP_RESTORE_PERCENTAGE_EPSILON = 0.01

function constrainDesktopGeometry(target: number | string) {
  const root = document.documentElement
  if (typeof target === "number") {
    root.style.setProperty(COMMUNITY_LAYOUT_PREPAINT_SIDEBAR_WIDTH, `${target}px`)
    root.style.setProperty(
      COMMUNITY_LAYOUT_PREPAINT_USER_BAR_WIDTH,
      `${desktopUserBarOverlayWidth(target)}px`,
    )
  }
  root.setAttribute(COMMUNITY_LAYOUT_PREPAINT_ATTRIBUTE, "")
}

function releaseDesktopGeometryConstraint() {
  document.documentElement.removeAttribute(COMMUNITY_LAYOUT_PREPAINT_ATTRIBUTE)
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
  const persistedSidebarPercentage = hydratedClient
    ? defaultLayout?.sidebar
    : undefined
  const sidebarPanelRef = useRef<HTMLDivElement>(null)
  const panelGroupHandleRef = useRef<GroupImperativeHandle | null>(null)
  const sidebarPanelHandleRef = useRef<PanelImperativeHandle | null>(null)
  const resizeHandleRef = useRef<HTMLDivElement>(null)
  const userBarOverlayRef = useRef<HTMLDivElement>(null)
  const committedBreakpointRef = useRef<Breakpoint>(breakpoint)
  const renderedBreakpointRef = useRef<Breakpoint>(breakpoint)
  const desktopSidebarWidthRef = useRef<number | undefined>(undefined)
  const pendingDesktopRestoreRef = useRef<PendingDesktopRestore | null>(null)
  const hydratedLayoutAppliedRef = useRef(false)

  useInsertionEffect(() => {
    renderedBreakpointRef.current = breakpoint
    if (breakpoint === "mobile" && pendingDesktopRestoreRef.current !== null) {
      const { animationFrame } = pendingDesktopRestoreRef.current
      if (animationFrame !== null) cancelAnimationFrame(animationFrame)
      pendingDesktopRestoreRef.current = null
      releaseDesktopGeometryConstraint()
    }
    if (
      committedBreakpointRef.current === "mobile"
      && breakpoint === "desktop"
      && pendingDesktopRestoreRef.current === null
    ) {
      pendingDesktopRestoreRef.current = {
        target: desktopSidebarRestoreTarget(
          desktopSidebarWidthRef.current,
          persistedSidebarPercentage,
        ),
        animationFrame: null,
      }
      constrainDesktopGeometry(pendingDesktopRestoreRef.current.target)
    }
  }, [breakpoint, persistedSidebarPercentage])

  const setDesktopUserBarWidth = useCallback((sidebarWidth: number) => {
    userBarOverlayRef.current?.style.setProperty(
      "--community-desktop-user-bar-width",
      `${desktopUserBarOverlayWidth(sidebarWidth)}px`,
    )
  }, [])
  const syncDesktopUserBarWidth = useCallback((size: PanelSize) => {
    if (
      renderedBreakpointRef.current !== "desktop"
      || pendingDesktopRestoreRef.current !== null
    ) return
    const measuredSidebarWidth = sidebarPanelRef.current?.getBoundingClientRect().width
    const sidebarWidth = measuredSidebarWidth && measuredSidebarWidth > 0
      ? measuredSidebarWidth
      : size.inPixels
    desktopSidebarWidthRef.current = sidebarWidth
    setDesktopUserBarWidth(sidebarWidth)
  }, [setDesktopUserBarWidth])
  const persistDoubleClickReset = useCallback(() => {
    const sidebarPanelHandle = sidebarPanelHandleRef.current
    if (!sidebarPanelHandle) return
    sidebarPanelHandle.resize(COMMUNITY_SIDEBAR_DEFAULT_WIDTH)
    queueMicrotask(() => {
      const layout = panelGroupHandleRef.current?.getLayout()
      if (!layout || Object.keys(layout).length === 0) return
      onLayoutChanged(layout, { isUserInteraction: true })
    })
  }, [onLayoutChanged])

  useLayoutEffect(() => {
    const onDoubleClick = (event: MouseEvent) => {
      const resizeHandle = resizeHandleRef.current
      if (!resizeHandle) return
      const rect = resizeHandle.getBoundingClientRect()
      const hitPadding = 10
      if (
        event.clientX >= rect.left - hitPadding
        && event.clientX <= rect.right + hitPadding
        && event.clientY >= rect.top
        && event.clientY <= rect.bottom
      ) persistDoubleClickReset()
    }
    document.addEventListener("dblclick", onDoubleClick, true)
    return () => document.removeEventListener("dblclick", onDoubleClick, true)
  }, [persistDoubleClickReset])

  useLayoutEffect(() => {
    if (
      defaultLayout === undefined
      || hydratedLayoutAppliedRef.current
    ) return

    const panelGroupHandle = panelGroupHandleRef.current
    if (!panelGroupHandle) return
    const prepaintSidebarWidth = document.documentElement.hasAttribute(
      COMMUNITY_LAYOUT_PREPAINT_ATTRIBUTE,
    ) && window.matchMedia(DESKTOP_PREPAINT_MEDIA_QUERY).matches
      ? sidebarPanelRef.current?.getBoundingClientRect().width
      : undefined
    const panelGroupWidth = breakpoint === "desktop"
      ? sidebarPanelRef.current
        ?.closest<HTMLElement>('[data-slot="resizable-panel-group"]')
        ?.getBoundingClientRect().width
      : undefined
    const restoredSidebarWidth = panelGroupWidth && panelGroupWidth > COMMUNITY_SEPARATOR_WIDTH
      ? Math.min(
          COMMUNITY_SIDEBAR_MAX_WIDTH,
          Math.max(
            COMMUNITY_SIDEBAR_MIN_WIDTH,
            defaultLayout.sidebar / 100 * (panelGroupWidth - COMMUNITY_SEPARATOR_WIDTH),
          ),
        )
      : prepaintSidebarWidth
    hydratedLayoutAppliedRef.current = true
    panelGroupHandle.setLayout(defaultLayout)
    if (restoredSidebarWidth && restoredSidebarWidth > 0) {
      sidebarPanelHandleRef.current?.resize(restoredSidebarWidth)
      desktopSidebarWidthRef.current = restoredSidebarWidth
      setDesktopUserBarWidth(restoredSidebarWidth)
    } else {
      userBarOverlayRef.current?.style.setProperty(
        "--community-desktop-user-bar-width",
        desktopUserBarInitialOverlayCssWidth(defaultLayout.sidebar),
      )
    }
  }, [breakpoint, defaultLayout, setDesktopUserBarWidth])

  useLayoutEffect(() => {
    if (
      busy
      || defaultLayout === undefined
      || !hydratedLayoutAppliedRef.current
      || pendingDesktopRestoreRef.current !== null
      || !window.matchMedia(DESKTOP_PREPAINT_MEDIA_QUERY).matches
    ) return
    // The session-pending shell keeps owning the exact prepaint geometry. Once
    // the loaded shell has applied the saved layout, retain the constraint for
    // this commit so the panel library cannot expose its default for one frame.
    requestAnimationFrame(() => {
      releaseDesktopGeometryConstraint()
    })
  }, [breakpoint, busy, defaultLayout])

  useLayoutEffect(() => {
    committedBreakpointRef.current = breakpoint
    const pendingRestore = pendingDesktopRestoreRef.current
    if (
      breakpoint !== "desktop"
      || pendingRestore === null
    ) return

    const panelHandle = sidebarPanelHandleRef.current
    if (!panelHandle) return
    let cancelled = false
    const restore = () => {
      if (
        cancelled
        || pendingDesktopRestoreRef.current !== pendingRestore
        || renderedBreakpointRef.current !== "desktop"
      ) return
      const groupWidth = sidebarPanelRef.current
        ?.closest<HTMLElement>('[data-slot="resizable-panel-group"]')
        ?.getBoundingClientRect().width
      const panelTrackWidth = groupWidth && groupWidth > COMMUNITY_SEPARATOR_WIDTH
        ? groupWidth - COMMUNITY_SEPARATOR_WIDTH
        : undefined
      const expectedPercentage = typeof pendingRestore.target === "string"
        ? Number.parseFloat(pendingRestore.target)
        : panelTrackWidth
          ? pendingRestore.target / panelTrackWidth * 100
          : undefined
      // Let the library observe its unconstrained panel geometry while applying
      // the canonical layout. If it is not ready yet, the constraint is put
      // back synchronously before the browser can paint.
      flushSync(() => {
        releaseDesktopGeometryConstraint()
        if (expectedPercentage !== undefined) {
          const groupHandle = panelGroupHandleRef.current
          const currentKeys = Object.keys(groupHandle?.getLayout() ?? {})
          const keyOrders = currentKeys.length === 2
            ? [currentKeys, currentKeys.toReversed()]
            : [["main", "sidebar"], ["sidebar", "main"]]
          for (const keys of keyOrders) {
            const candidate = Object.fromEntries(keys.map((key) => [
              key,
              key === "sidebar" ? expectedPercentage : 100 - expectedPercentage,
            ]))
            const applied = groupHandle?.setLayout(candidate)
            if (
              applied?.sidebar !== undefined
              && Math.abs(applied.sidebar - expectedPercentage)
                <= DESKTOP_RESTORE_PERCENTAGE_EPSILON
            ) break
          }
        } else {
          panelHandle.resize(pendingRestore.target)
        }
      })
      const size = panelHandle.getSize()
      const expectedWidth = typeof pendingRestore.target === "number"
        ? pendingRestore.target
        : panelTrackWidth && expectedPercentage !== undefined
          ? Math.min(
              COMMUNITY_SIDEBAR_MAX_WIDTH,
              Math.max(
                COMMUNITY_SIDEBAR_MIN_WIDTH,
                expectedPercentage / 100 * panelTrackWidth,
              ),
            )
          : undefined
      const appliedPercentage = panelGroupHandleRef.current?.getLayout()?.sidebar
        ?? size.asPercentage
      const storeRestored = expectedPercentage === undefined
        ? expectedWidth !== undefined
          && Math.abs(size.inPixels - expectedWidth) <= DESKTOP_RESTORE_PIXEL_EPSILON
        : Math.abs(appliedPercentage - expectedPercentage)
          <= DESKTOP_RESTORE_PERCENTAGE_EPSILON
      if (!storeRestored) {
        constrainDesktopGeometry(pendingRestore.target)
        pendingRestore.animationFrame = requestAnimationFrame(restore)
        return
      }

      const measuredWidth = sidebarPanelRef.current?.getBoundingClientRect().width
      const appliedWidth = measuredWidth && measuredWidth > 0
        ? measuredWidth
        : size.inPixels
      if (
        expectedWidth !== undefined
        && Math.abs(appliedWidth - expectedWidth) > DESKTOP_RESTORE_PIXEL_EPSILON
      ) {
        constrainDesktopGeometry(pendingRestore.target)
        pendingRestore.animationFrame = requestAnimationFrame(restore)
        return
      }
      desktopSidebarWidthRef.current = appliedWidth
      setDesktopUserBarWidth(appliedWidth)
      pendingDesktopRestoreRef.current = null
    }
    queueMicrotask(restore)
    return () => {
      cancelled = true
      if (pendingRestore.animationFrame !== null) {
        cancelAnimationFrame(pendingRestore.animationFrame)
      }
      if (pendingDesktopRestoreRef.current === pendingRestore) {
        pendingDesktopRestoreRef.current = null
        releaseDesktopGeometryConstraint()
      }
    }
  }, [breakpoint, defaultLayout, setDesktopUserBarWidth])

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

  const initialUserBarStyle = {
    "--community-desktop-user-bar-width": desktopUserBarInitialOverlayCssWidth(
      persistedSidebarPercentage,
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
            id="community-shell"
            groupRef={panelGroupHandleRef}
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
              panelRef={sidebarPanelHandleRef}
              defaultSize={COMMUNITY_SIDEBAR_DEFAULT_WIDTH}
              minSize={COMMUNITY_SIDEBAR_MIN_WIDTH}
              maxSize={COMMUNITY_SIDEBAR_MAX_WIDTH}
              groupResizeBehavior="preserve-pixel-size"
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
            <ResizableHandle
              className={cn("bg-transparent", !isDesktop && "hidden")}
              disableDoubleClick
              elementRef={resizeHandleRef}
            />
            <ResizablePanel
              id="main"
              groupResizeBehavior="preserve-relative-size"
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
