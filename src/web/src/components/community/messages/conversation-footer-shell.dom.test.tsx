import React from "react"
import { fireEvent, render } from "@/test/react-dom-harness"
import { describe, expect, it } from "vitest"
import {
  ConversationFooterShell,
  ConversationFooterSlotProvider,
  useConversationFooterSlot,
} from "./conversation-footer-shell"

describe("ConversationFooterShell", () => {
  it("keeps ordinary composer content in normal flow", () => {
    const renderer = render(
      <ConversationFooterShell data-testid="footer">
        <div data-testid="composer-editor">composer</div>
      </ConversationFooterShell>,
    )

    const footer = renderer.getByTestId("footer")
    expect(footer).toHaveClass("relative", "shrink-0")
    expect(footer).toHaveAttribute("data-slot", "community-conversation-footer")
    expect(footer).toHaveAttribute("data-selection-active", "false")
    expect(renderer.getByTestId("composer-editor").parentElement)
      .not.toHaveClass("absolute", "invisible", "h-0")
    expect(footer.querySelector('[data-slot="community-selection-footer-slot"]'))
      .toHaveClass("hidden")
    expect(footer.querySelector('[data-slot="community-composer-overlay"]')).toBeNull()
  })

  it("replaces the mounted composer with an explicit in-flow selection slot", () => {
    function SelectionToggle() {
      const footer = useConversationFooterSlot()!
      return (
        <button type="button" onClick={() => footer.setSelectionActive(true)}>
          select
        </button>
      )
    }
    const renderer = render(
      <ConversationFooterSlotProvider>
        <SelectionToggle />
        <ConversationFooterShell data-testid="footer">
          <div data-testid="composer-editor">draft</div>
        </ConversationFooterShell>
      </ConversationFooterSlotProvider>,
    )
    const footer = renderer.getByTestId("footer")
    const editor = renderer.getByTestId("composer-editor")

    fireEvent.click(renderer.getByRole("button", { name: "select" }))

    expect(footer).toHaveAttribute("data-selection-active", "true")
    expect(editor).toBeInTheDocument()
    expect(editor.parentElement).toHaveClass("invisible", "h-0", "overflow-hidden")
    expect(footer.querySelector('[data-slot="community-selection-footer-slot"]'))
      .toHaveClass("relative", "h-[calc(3.75rem+var(--app-safe-area-bottom))]", "sm:h-15")
    expect(footer.querySelector('[data-slot="community-selection-footer-slot"]'))
      .not.toHaveClass("absolute", "inset-0", "hidden")
  })
})
