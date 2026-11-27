import { createElement, useLayoutEffect, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import type { Breakpoint } from "@/hooks/use-mobile"
import { CommunityShellLayout } from "./community-shell-layout"
import { COMMUNITY_LAYOUT_PREPAINT_ATTRIBUTE } from "./shell-frame-geometry"

const layoutMocks = vi.hoisted(() => ({
  clampedGroupWidth: 640,
  clampedSidebarWidth: 280,
  defaultLayout: undefined as { sidebar: number; main: number } | undefined,
  onResizeCapture: null as ((size: { inPixels: number; asPercentage: number }) => void) | null,
}))

vi.mock("react-resizable-panels", () => ({
  useDefaultLayout: () => ({
    defaultLayout: layoutMocks.defaultLayout,
    onLayoutChanged: vi.fn(),
  }),
}))

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children, groupRef }: Record<string, unknown>) => {
    useLayoutEffect(() => {
      const ref = groupRef as { current: unknown } | undefined
      if (!ref) return
      let layout = { sidebar: 43.75, main: 56.25 }
      ref.current = {
        getLayout: () => layout,
        setLayout: (next: Record<string, number>) => {
          const track = Math.max(1, layoutMocks.clampedGroupWidth - 1)
          const maxPct = (layoutMocks.clampedSidebarWidth / track) * 100
          const clamped = Math.min(next.sidebar ?? maxPct, maxPct)
          layout = { sidebar: clamped, main: 100 - clamped }
          return layout
        },
      }
      return () => { ref.current = null }
    }, [groupRef])
    return createElement(
      "div",
      {
        "data-slot": "resizable-panel-group",
        ref: (el: HTMLDivElement | null) => {
          if (el) {
            el.getBoundingClientRect = () => ({
              width: layoutMocks.clampedGroupWidth,
              height: 800,
              top: 0,
              left: 0,
              right: layoutMocks.clampedGroupWidth,
              bottom: 800,
              x: 0,
              y: 0,
              toJSON: () => ({}),
            })
          }
        },
      },
      children as ReactNode,
    )
  },
  ResizablePanel: ({ children, id, panelRef, elementRef, onResize }: Record<string, unknown>) => {
    useLayoutEffect(() => {
      if (id !== "sidebar") return
      layoutMocks.onResizeCapture = (onResize as ((size: { inPixels: number; asPercentage: number }) => void) | undefined) ?? null
      const ref = panelRef as { current: unknown } | undefined
      if (!ref) return
      ref.current = {
        getSize: () => ({
          inPixels: layoutMocks.clampedSidebarWidth,
          asPercentage: (layoutMocks.clampedSidebarWidth / Math.max(1, layoutMocks.clampedGroupWidth - 1)) * 100,
        }),
        resize: vi.fn(),
      }
      return () => {
        ref.current = null
        layoutMocks.onResizeCapture = null
      }
    }, [id, panelRef, onResize])
    return createElement(
      "div",
      {
        "data-slot": "resizable-panel",
        "data-testid": String(id ?? ""),
        ref: (el: HTMLDivElement | null) => {
          const eRef = elementRef as { current: HTMLDivElement | null } | undefined
          if (eRef) eRef.current = el
          if (el && id === "sidebar") {
            el.getBoundingClientRect = () => ({
              width: layoutMocks.clampedSidebarWidth,
              height: 800,
              top: 0,
              left: 0,
              right: layoutMocks.clampedSidebarWidth,
              bottom: 800,
              x: 0,
              y: 0,
              toJSON: () => ({}),
            })
          }
        },
      },
      children as ReactNode,
    )
  },
  ResizableHandle: ({ elementRef }: Record<string, unknown>) =>
    createElement("div", {
      "data-slot": "resizable-handle",
      ref: (el: HTMLDivElement | null) => {
        const eRef = elementRef as { current: HTMLDivElement | null } | undefined
        if (eRef) eRef.current = el
      },
    }),
}))

beforeEach(() => {
  layoutMocks.clampedGroupWidth = 1200
  layoutMocks.clampedSidebarWidth = 360
  layoutMocks.defaultLayout = { sidebar: 30, main: 70 }
  layoutMocks.onResizeCapture = null
})

afterEach(() => {
  document.documentElement.removeAttribute(COMMUNITY_LAYOUT_PREPAINT_ATTRIBUTE)
  vi.restoreAllMocks()
})

describe("CommunityShellLayout desktop sidebar restore", () => {
  it("terminates mobile-to-desktop restore within five animation frames and releases prepaint lock when clamped", async () => {
    const rafQueue: Array<FrameRequestCallback> = []
    let rafScheduleCount = 0
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      rafScheduleCount += 1
      rafQueue.push(cb)
      return rafScheduleCount
    })
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})

    const makeProps = (breakpoint: Breakpoint) => ({
      breakpoint,
      surface: "detail" as const,
      rail: createElement("div", null, "rail"),
      sidebar: createElement("div", null, "sidebar"),
      main: createElement("div", null, "main"),
      userBar: createElement("div", null, "userbar"),
    })

    const view = render(createElement(CommunityShellLayout, makeProps("desktop")))
    await act(async () => {
      layoutMocks.onResizeCapture?.({ inPixels: 360, asPercentage: 30 })
    })

    await act(async () => {
      view.rerender(createElement(CommunityShellLayout, makeProps("mobile")))
    })

    layoutMocks.clampedGroupWidth = 640
    layoutMocks.clampedSidebarWidth = 280
    rafQueue.length = 0
    rafScheduleCount = 0

    await act(async () => {
      view.rerender(createElement(CommunityShellLayout, makeProps("desktop")))
      await Promise.resolve()
    })

    let executedFrames = 0
    for (let i = 0; i < 25; i += 1) {
      const next = rafQueue.shift()
      if (!next) break
      executedFrames += 1
      await act(async () => {
        next(i * 16)
      })
    }

    expect(executedFrames).toBeLessThanOrEqual(5)
    expect(rafQueue.length).toBe(0)
    expect(document.documentElement.hasAttribute(COMMUNITY_LAYOUT_PREPAINT_ATTRIBUTE)).toBe(false)

    view.unmount()
  })
})
