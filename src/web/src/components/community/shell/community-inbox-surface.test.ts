import { createElement, createRef, type PropsWithChildren } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import { CommunityInboxSurface } from "./community-inbox-surface"
import { tid } from "@/lib/community/testids"

vi.mock("@/components/ui/popover", () => {
  const pass = (type: string) =>
    function Pass({ children, ...props }: PropsWithChildren<Record<string, unknown>>) {
      return createElement(type, props, children)
    }
  return {
    Popover: pass("popover-root"),
    PopoverBackdrop: pass("popover-backdrop"),
    PopoverClose: pass("popover-close"),
    PopoverContent: pass("popover-content"),
    PopoverPopup: pass("popover-popup"),
    PopoverPortal: pass("popover-portal"),
    PopoverPositioner: pass("popover-positioner"),
    PopoverTitle: pass("popover-title"),
    PopoverTrigger: pass("popover-trigger"),
  }
})

async function renderSurface(breakpoint: "mobile" | "desktop") {
  const anchorRef = createRef<HTMLDivElement>()
  const suppressFocusReturnRef = { current: false }
  const onOpenChange = vi.fn()
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(CommunityInboxSurface, {
      breakpoint,
      open: true,
      onOpenChange,
      hasUnread: true,
      anchorRef,
      suppressFocusReturnRef,
    }, createElement("inbox-content")))
  })
  return { renderer, anchorRef, suppressFocusReturnRef, onOpenChange }
}

describe("CommunityInboxSurface", () => {
  it("uses a scoped real nonmodal Popover surface on mobile", async () => {
    const { renderer, anchorRef, suppressFocusReturnRef } = await renderSurface("mobile")
    expect(renderer.root.findByType("popover-root").props.modal).toBe(false)
    expect(renderer.root.findByType("popover-trigger").props.render.props["data-testid"])
      .toBe(tid.inboxTrigger)

    const backdrop = renderer.root.findByType("popover-backdrop")
    expect(backdrop.props["data-testid"]).toBe(tid.inboxMobileBackdrop)
    expect(backdrop.props.style).toEqual({
      top: "var(--app-safe-area-top)",
      bottom: "calc(60px + var(--app-safe-area-bottom))",
    })

    const positioner = renderer.root.findByType("popover-positioner")
    expect(positioner.props).toMatchObject({
      anchor: anchorRef,
      positionMethod: "fixed",
      side: "top",
      align: "start",
      sideOffset: 0,
      collisionAvoidance: { side: "none", align: "none", fallbackAxisSide: "none" },
    })
    const popup = renderer.root.findByType("popover-popup")
    expect(popup.props["data-testid"]).toBe(tid.inboxMobileSurface)
    expect(popup.props.className).toContain("w-(--anchor-width)")
    expect(renderer.root.findByType("popover-title").children).toEqual(["Inbox"])
    expect(renderer.root.findByType("popover-close").props).toMatchObject({
      "data-testid": tid.inboxMobileClose,
      "aria-label": "Close Inbox",
    })
    expect(renderer.root.findByProps({ "data-testid": tid.inboxMobileCard }).props.style.height)
      .toContain("100dvh")

    suppressFocusReturnRef.current = true
    expect(popup.props.finalFocus()).toBe(false)
  })

  it("keeps the exact anchored desktop Popover path", async () => {
    const { renderer } = await renderSurface("desktop")
    const content = renderer.root.findByType("popover-content")
    expect(content.props).toMatchObject({ side: "top", align: "end" })
    expect(content.props.className).toBe(
      "w-90 max-w-[calc(100vw-1rem)] overflow-hidden p-0",
    )
    expect(renderer.root.findAllByType("popover-backdrop")).toHaveLength(0)
    expect(renderer.root.findAllByType("popover-popup")).toHaveLength(0)
  })

  it("keeps open ownership controlled and resets focus suppression on reopen", async () => {
    const { renderer, suppressFocusReturnRef, onOpenChange } = await renderSurface("mobile")
    suppressFocusReturnRef.current = true
    await act(async () => renderer.root.findByType("popover-root").props.onOpenChange(true, {
      reason: "trigger-press",
      event: new Event("click"),
    }))
    expect(suppressFocusReturnRef.current).toBe(false)
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })
})
