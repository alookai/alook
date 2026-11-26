import { createElement, forwardRef, type ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"

const positionerPropsSpy = vi.fn()
const popoverPropsSpy = vi.fn()

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => {
    popoverPropsSpy(props)
    return createElement("div", null, children)
  },
  PopoverPortal: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  PopoverPositioner: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => {
    positionerPropsSpy(props)
    return createElement("div", null, children)
  },
  PopoverPopup: forwardRef<HTMLDivElement, { children: ReactNode; className?: string }>(
    function MockPopoverPopup({ children, className }, ref) {
      return createElement("div", { ref, className }, children)
    },
  ),
}))

vi.mock("@/components/community/social/profile-secondary-position", () => ({
  useProfileSecondaryPosition: () => ({
    popoverRef: { current: null },
    cardRef: { current: null },
    previewRef: { current: null },
    position: { placement: "right", left: 328, top: 0, height: 260 },
    ready: true,
  }),
}))

import { UserBarPopover } from "./user-bar-popover"

describe("UserBarPopover", () => {
  it("keeps the complete profile as the anchor and docks its companion independently", () => {
    const renderer = render(
      <UserBarPopover
        anchor={{ current: null }}
        onDismiss={vi.fn()}
        onEscape={vi.fn()}
        companion={createElement("section", { "data-testid": "companion" }, "Running bots")}
      >
        <article data-testid="profile">Full profile</article>
      </UserBarPopover>,
    )

    const profile = renderer.getByTestId("profile")
    const dock = renderer.getByTestId(tid.userBarProfileSecondaryDock)
    expect(profile.parentElement?.nextElementSibling).toBe(dock)
    expect(dock).toHaveAttribute("data-placement", "right")
    expect(dock).toHaveAttribute("data-measurement-ready", "true")
    expect(dock.style.left).toBe("328px")
    expect(dock.style.height).toBe("260px")
    expect(renderer.getByTestId("companion")).toBeInTheDocument()
  })

  it("pins the popover above the user bar and shifts inside safe bounds without flipping sideways", () => {
    positionerPropsSpy.mockClear()
    const anchor = { current: document.createElement("div") }
    render(
      <UserBarPopover anchor={anchor} inbox onDismiss={vi.fn()} onEscape={vi.fn()}>
        <div data-testid="inbox-body">Inbox</div>
      </UserBarPopover>,
    )

    expect(positionerPropsSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      anchor,
      side: "top",
      align: "start",
      sideOffset: 8,
      collisionPadding: 8,
      sticky: true,
      collisionAvoidance: { side: "shift", align: "shift", fallbackAxisSide: "none" },
    }))
  })

  it("cancels outside-press only for interactive User Bar buttons and dismisses on blank User Bar space", () => {
    popoverPropsSpy.mockClear()
    const onDismiss = vi.fn()
    const onEscape = vi.fn()
    const userBar = document.createElement("div")
    userBar.dataset.testid = tid.userBar
    const blank = document.createElement("div")
    const button = document.createElement("button")
    const icon = document.createElement("span")
    button.appendChild(icon)
    userBar.appendChild(blank)
    userBar.appendChild(button)
    document.body.appendChild(userBar)
    const renderer = render(
      <UserBarPopover anchor={{ current: userBar }} onDismiss={onDismiss} onEscape={onEscape}>
        <div>Inbox</div>
      </UserBarPopover>,
    )
    const onOpenChange = popoverPropsSpy.mock.calls.at(-1)?.[0].onOpenChange as (
      open: boolean,
      details: { reason: string; event: Event; cancel: () => void },
    ) => void

    const buttonCancel = vi.fn()
    onOpenChange(false, { reason: "outside-press", event: { target: icon } as unknown as Event, cancel: buttonCancel })
    expect(buttonCancel).toHaveBeenCalledOnce()
    expect(onDismiss).not.toHaveBeenCalled()

    const blankCancel = vi.fn()
    onOpenChange(false, { reason: "outside-press", event: { target: blank } as unknown as Event, cancel: blankCancel })
    expect(blankCancel).not.toHaveBeenCalled()
    expect(onDismiss).toHaveBeenCalledOnce()

    const escapeCancel = vi.fn()
    onOpenChange(false, { reason: "escape-key", event: { target: document.body } as unknown as Event, cancel: escapeCancel })
    expect(escapeCancel).not.toHaveBeenCalled()
    expect(onEscape).toHaveBeenCalledOnce()

    renderer.unmount()
    userBar.remove()
  })
})
