import { cloneElement, createElement, createRef, type PropsWithChildren, type ReactElement, type ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { CommunityInboxSurface } from "./community-inbox-surface"
import { tid } from "@/lib/community/testids"

const surfaceProps = vi.hoisted(() => new Map<string, Record<string, unknown>>())

vi.mock("@/components/ui/popover", () => {
  const pass = (type: string) =>
    function Pass({ children, ...props }: PropsWithChildren<Record<string, unknown>>) {
      surfaceProps.set(type, props)
      return createElement(type, props, children)
    }
  return {
    Popover: pass("popover-root"),
    PopoverContent: pass("popover-content"),
    PopoverPopup: pass("popover-popup"),
    PopoverPortal: pass("popover-portal"),
    PopoverPositioner: pass("popover-positioner"),
    PopoverTitle: pass("popover-title"),
    PopoverTrigger: ({ children, render: trigger }: { children?: ReactNode; render: ReactElement }) => {
      surfaceProps.set("popover-trigger", { render: trigger })
      return cloneElement(trigger, undefined, children)
    },
  }
})

async function renderSurface(breakpoint: "mobile" | "desktop", open = true) {
  const anchorRef = createRef<HTMLDivElement>()
  const suppressFocusReturnRef = { current: false }
  const onOpenChange = vi.fn()
  surfaceProps.clear()
  const renderer = render(createElement(CommunityInboxSurface, {
      breakpoint,
      open,
      onOpenChange,
      hasUnread: true,
      anchorRef,
      suppressFocusReturnRef,
    }, createElement("inbox-content")))
  return { renderer, anchorRef, suppressFocusReturnRef, onOpenChange }
}

describe("CommunityInboxSurface", () => {
  it("uses a backdrop-free nonmodal Popover surface on mobile", async () => {
    const { renderer, anchorRef, suppressFocusReturnRef } = await renderSurface("mobile")
    expect(surfaceProps.get("popover-root")?.modal).toBe(false)
    const trigger = renderer.getByTestId(tid.inboxTrigger)
    const triggerClasses = trigger.className.split(" ")
    expect(trigger).toHaveAttribute("aria-label", "Close Inbox")
    expect(trigger).toHaveAttribute("aria-pressed", "true")
    expect(trigger.className).toContain("aria-expanded:text-foreground")
    expect(triggerClasses).not.toContain("hover:bg-accent")
    expect(triggerClasses).toContain("hover:text-foreground")
    expect(triggerClasses).toContain("active:text-foreground")
    expect(triggerClasses).not.toContain("border")
    expect(triggerClasses).not.toContain("bg-accent")
    expect(triggerClasses).not.toContain("shadow")
    expect(triggerClasses).toContain("focus-visible:ring-2")
    const icon = trigger.querySelector("svg")!
    expect(icon.getAttribute("class")).not.toContain("fill-current")
    expect(icon).toHaveAttribute("fill", "none")
    const unreadDot = trigger.querySelector<HTMLElement>("span.bg-primary")!
    expect(unreadDot.className.split(" ")).toEqual(expect.arrayContaining([
      "-right-1",
      "-top-1",
    ]))
    expect(unreadDot.parentElement?.className.split(" ")).toEqual(expect.arrayContaining([
      "relative",
      "size-4",
    ]))
    expect(renderer.container.querySelectorAll("popover-backdrop")).toHaveLength(0)

    const positioner = surfaceProps.get("popover-positioner")
    expect(positioner).toMatchObject({
      anchor: anchorRef,
      positionMethod: "fixed",
      side: "top",
      align: "start",
      sideOffset: 0,
      collisionAvoidance: { side: "none", align: "none", fallbackAxisSide: "none" },
    })
    const popup = surfaceProps.get("popover-popup")!
    expect(popup["data-testid"]).toBe(tid.inboxMobileSurface)
    expect(popup.initialFocus).toBe(false)
    expect(popup.className).toContain("w-(--anchor-width)")
    expect(renderer.container.querySelector("popover-title")).toHaveTextContent("Inbox")
    expect(renderer.container.querySelectorAll("popover-close")).toHaveLength(0)
    const card = renderer.getByTestId(tid.inboxMobileCard)
    expect(card.className).toContain("rounded-t-xl")
    expect(card.className).not.toContain("rounded-xl")
    expect(card.style.height)
      .toContain("100dvh")

    suppressFocusReturnRef.current = true
    expect((popup.finalFocus as () => boolean)()).toBe(false)
  })

  it("keeps the mobile trigger outlined while closed", async () => {
    const { renderer } = await renderSurface("mobile", false)
    const trigger = renderer.getByTestId(tid.inboxTrigger)
    expect(trigger).toHaveAttribute("aria-label", "Open Inbox")
    expect(trigger).toHaveAttribute("aria-pressed", "false")
    expect(trigger.className).toContain("aria-expanded:text-foreground")
    expect(trigger.className.split(" ")).not.toContain("hover:bg-accent")
    expect(trigger.querySelector("svg")?.getAttribute("class")).not.toContain("fill-current")
    expect(trigger.querySelector("svg")).toHaveAttribute("fill", "none")
  })

  it("keeps the exact anchored desktop Popover path", async () => {
    const { renderer } = await renderSurface("desktop")
    const content = surfaceProps.get("popover-content")!
    expect(content).toMatchObject({ side: "top", align: "end" })
    expect(content.className).toBe(
      "w-90 max-w-[calc(100vw-1rem)] overflow-hidden p-0",
    )
    const trigger = renderer.getByTestId(tid.inboxTrigger)
    expect(trigger).toHaveAttribute("aria-label", "Inbox")
    expect(trigger).not.toHaveAttribute("aria-pressed")
    expect(trigger.className).not.toContain("aria-expanded:text-foreground")
    expect(trigger.className.split(" ")).toContain("hover:bg-accent")
    expect(trigger.querySelector("svg")?.getAttribute("class")).not.toContain("fill-current")
    const unreadDot = trigger.querySelector<HTMLElement>("span.bg-primary")!
    const unreadDotClasses = unreadDot.className.split(" ")
    expect(unreadDotClasses).toEqual(expect.arrayContaining([
      "right-1",
      "top-1",
    ]))
    expect(unreadDotClasses).not.toContain("-right-1")
    expect(unreadDotClasses).not.toContain("-top-1")
    expect(renderer.container.querySelectorAll("popover-backdrop")).toHaveLength(0)
    expect(renderer.container.querySelectorAll("popover-popup")).toHaveLength(0)
  })

  it("keeps open ownership controlled and resets focus suppression on reopen", async () => {
    const { renderer, suppressFocusReturnRef, onOpenChange } = await renderSurface("mobile")
    suppressFocusReturnRef.current = true
    await act(async () => (surfaceProps.get("popover-root")?.onOpenChange as (
      open: boolean,
      details: { reason: string; event: Event },
    ) => void)(true, {
      reason: "trigger-press",
      event: new Event("click"),
    }))
    expect(suppressFocusReturnRef.current).toBe(false)
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })
})
