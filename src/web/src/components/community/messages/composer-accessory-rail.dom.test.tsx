import React from "react"
import { createPortal } from "react-dom"
import { describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"
import { ComposerAccessoryRail } from "./composer-accessory-rail"
import { ConversationFooterShell, ConversationFooterSlotProvider, useConversationFooterSlot } from "./conversation-footer-shell"

vi.mock("@/components/ui/number-ticker", () => ({
  NumberTicker: ({ value }: { value: number }) => React.createElement("span", null, value),
}))

describe("ComposerAccessoryRail geometry", () => {
  it("shares the composer's logical safe-area-aware inline edges", () => {
    function Accessory() {
      const target = useConversationFooterSlot()?.accessoryTarget
      return target ? createPortal(
        <ComposerAccessoryRail typingNames={["Alice"]} scrollCount={2} scrollMode="scroll" onScroll={vi.fn()} />,
        target,
      ) : null
    }
    const renderer = render(
      <ConversationFooterSlotProvider>
        <Accessory />
        <ConversationFooterShell><div>composer</div></ConversationFooterShell>
      </ConversationFooterSlotProvider>,
    )

    const slot = renderer.container.querySelector('[data-slot="community-composer-accessory-slot"]')!
    expect(slot).toHaveClass(
      "pl-(--community-composer-inline-start)",
      "pr-(--community-composer-inline-end)",
    )
    expect(renderer.getByTestId(tid.composerAccessoryRail).parentElement).toBe(slot)
    expect(renderer.getByTestId(tid.typingIndicator)).toHaveClass("h-full")
    expect(renderer.getByTestId(tid.typingIndicator)).not.toHaveClass("h-8")
    expect(renderer.getByTestId(tid.composerAccessoryRail)).not.toHaveClass(
      "pl-(--community-composer-inline-start)",
      "pr-(--community-composer-inline-end)",
      "px-2",
      "sm:px-4",
    )
  })

  it("leaves positioning to the Footer box and fills the shared row height", () => {
    const renderer = render(
      <ComposerAccessoryRail
        typingNames={[]}
        scrollCount={1}
        scrollMode="jump"
        onScroll={vi.fn()}
      />,
    )

    expect(renderer.getByTestId(tid.composerAccessoryRail)).not.toHaveClass(
      "absolute",
      "inset-x-0",
      "bottom-2",
      "sm:bottom-4",
    )
    expect(renderer.getByTestId(tid.composerAccessoryRail)).toHaveStyle({ height: "32px" })
    expect(renderer.getByTestId(tid.scrollToPresent)).toHaveClass("h-full")
  })
})
