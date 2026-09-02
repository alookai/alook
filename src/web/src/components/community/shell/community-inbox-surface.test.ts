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
    PopoverContent: pass("popover-content"),
    PopoverPopup: pass("popover-popup"),
    PopoverPortal: pass("popover-portal"),
    PopoverPositioner: pass("popover-positioner"),
    PopoverTitle: pass("popover-title"),
    PopoverTrigger: pass("popover-trigger"),
  }
})

async function renderSurface(breakpoint: "mobile" | "desktop", open = true) {
  const anchorRef = createRef<HTMLDivElement>()
  const suppressFocusReturnRef = { current: false }
  const onOpenChange = vi.fn()
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(CommunityInboxSurface, {
      breakpoint,
      open,
      onOpenChange,
      hasUnread: true,
      anchorRef,
      suppressFocusReturnRef,
    }, createElement("inbox-content")))
  })
  return { renderer, anchorRef, suppressFocusReturnRef, onOpenChange }
}

describe("CommunityInboxSurface", () => {
  it("uses a backdrop-free nonmodal Popover surface on mobile", async () => {
    const { renderer, anchorRef, suppressFocusReturnRef } = await renderSurface("mobile")
    expect(renderer.root.findByType("popover-root").props.modal).toBe(false)
    const trigger = renderer.root.findByType("popover-trigger").props.render
    const triggerClasses = trigger.props.className.split(" ")
    expect(trigger.props["data-testid"]).toBe(tid.inboxTrigger)
    expect(trigger.props["aria-label"]).toBe("Close Inbox")
    expect(trigger.props["aria-pressed"]).toBe(true)
    expect(trigger.props.className).toContain("aria-expanded:text-foreground")
    expect(triggerClasses).not.toContain("hover:bg-accent")
    expect(triggerClasses).toContain("hover:text-foreground")
    expect(triggerClasses).toContain("active:text-foreground")
    expect(triggerClasses).not.toContain("border")
    expect(triggerClasses).not.toContain("bg-accent")
    expect(triggerClasses).not.toContain("shadow")
    expect(triggerClasses).toContain("focus-visible:ring-2")
    expect(renderer.root.findByType("svg").props.className).not.toContain("fill-current")
    expect(renderer.root.findByType("svg").props.fill).toBe("none")
    const unreadDot = renderer.root.find((node) => (
      node.type === "span" && node.props.className?.includes("bg-primary")
    ))
    expect(unreadDot.props.className.split(" ")).toEqual(expect.arrayContaining([
      "-right-1",
      "-top-1",
    ]))
    expect(unreadDot.parent?.props.className.split(" ")).toEqual(expect.arrayContaining([
      "relative",
      "size-4",
    ]))
    expect(renderer.root.findAllByType("popover-backdrop")).toHaveLength(0)

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
    expect(popup.props.initialFocus).toBe(false)
    expect(popup.props.className).toContain("w-(--anchor-width)")
    expect(renderer.root.findByType("popover-title").children).toEqual(["Inbox"])
    expect(renderer.root.findAllByType("popover-close")).toHaveLength(0)
    const card = renderer.root.findByProps({ "data-testid": tid.inboxMobileCard })
    expect(card.props.className).toContain("rounded-t-xl")
    expect(card.props.className).not.toContain("rounded-xl")
    expect(card.props.style.height)
      .toContain("100dvh")

    suppressFocusReturnRef.current = true
    expect(popup.props.finalFocus()).toBe(false)
  })

  it("keeps the mobile trigger outlined while closed", async () => {
    const { renderer } = await renderSurface("mobile", false)
    const trigger = renderer.root.findByType("popover-trigger").props.render
    expect(trigger.props["aria-label"]).toBe("Open Inbox")
    expect(trigger.props["aria-pressed"]).toBe(false)
    expect(trigger.props.className).toContain("aria-expanded:text-foreground")
    expect(trigger.props.className.split(" ")).not.toContain("hover:bg-accent")
    expect(renderer.root.findByType("svg").props.className).not.toContain("fill-current")
    expect(renderer.root.findByType("svg").props.fill).toBe("none")
  })

  it("keeps the exact anchored desktop Popover path", async () => {
    const { renderer } = await renderSurface("desktop")
    const content = renderer.root.findByType("popover-content")
    expect(content.props).toMatchObject({ side: "top", align: "end" })
    expect(content.props.className).toBe(
      "w-90 max-w-[calc(100vw-1rem)] overflow-hidden p-0",
    )
    const trigger = renderer.root.findByType("popover-trigger").props.render
    expect(trigger.props["aria-label"]).toBe("Inbox")
    expect(trigger.props["aria-pressed"]).toBeUndefined()
    expect(trigger.props.className).not.toContain("aria-expanded:text-foreground")
    expect(trigger.props.className.split(" ")).toContain("hover:bg-accent")
    expect(renderer.root.findByType("svg").props.className).not.toContain("fill-current")
    const unreadDot = renderer.root.find((node) => (
      node.type === "span" && node.props.className?.includes("bg-primary")
    ))
    const unreadDotClasses = unreadDot.props.className.split(" ")
    expect(unreadDotClasses).toEqual(expect.arrayContaining([
      "right-1",
      "top-1",
    ]))
    expect(unreadDotClasses).not.toContain("-right-1")
    expect(unreadDotClasses).not.toContain("-top-1")
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
