import { createElement, forwardRef, type ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  PopoverPortal: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  PopoverPositioner: ({ children }: { children: ReactNode }) => createElement("div", null, children),
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
})
