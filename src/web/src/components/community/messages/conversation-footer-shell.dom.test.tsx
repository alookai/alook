import React from "react"
import { createPortal } from "react-dom"
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
    const accessory = footer.querySelector('[data-slot="community-composer-accessory-slot"]')!
    expect(accessory).toHaveClass("absolute", "bottom-full", "flex", "items-center", "pointer-events-none")
    expect(accessory).toHaveStyle({ height: "40px" })
    expect(accessory.parentElement).toBe(footer)
  })

  it("replaces the mounted composer with an explicit in-flow selection slot", () => {
    function SelectionToggle() {
      const footer = useConversationFooterSlot()!
      return (
        <>
        <button type="button" onClick={() => footer.setSelectionActive(true)}>
          select
        </button>
        {footer.accessoryTarget && !footer.selectionActive && createPortal(<span>typing</span>, footer.accessoryTarget)}
        </>
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
    const accessory = footer.querySelector('[data-slot="community-composer-accessory-slot"]')!
    expect(accessory).toHaveTextContent("typing")
    expect(accessory).not.toBe(editor.parentElement)

    fireEvent.click(renderer.getByRole("button", { name: "select" }))

    expect(footer).toHaveAttribute("data-selection-active", "true")
    expect(editor).toBeInTheDocument()
    expect(editor.parentElement).toHaveClass("invisible", "h-0", "overflow-hidden")
    expect(accessory).toHaveClass("hidden")
    expect(accessory).not.toHaveTextContent("typing")
    expect(footer.querySelector('[data-slot="community-selection-footer-slot"]'))
      .toHaveClass("relative", "h-[calc(3.75rem+var(--app-safe-area-bottom))]", "sm:h-15")
    expect(footer.querySelector('[data-slot="community-selection-footer-slot"]'))
      .not.toHaveClass("absolute", "inset-0", "hidden")
  })

  it("keeps split-surface targets independent and retires both handles when a Footer leaves", () => {
    const slots: Record<string, NonNullable<ReturnType<typeof useConversationFooterSlot>>> = {}
    function Probe({ id }: { id: string }) {
      const slot = useConversationFooterSlot()!
      React.useLayoutEffect(() => { slots[id] = slot }, [id, slot])
      return slot.accessoryTarget ? createPortal(<span>{id} typing</span>, slot.accessoryTarget) : null
    }
    function Scope({ id, showFooter = true }: { id: string; showFooter?: boolean }) {
      return <ConversationFooterSlotProvider>
        <Probe id={id} />
        {showFooter && <ConversationFooterShell data-testid={id}><div>{id} composer</div></ConversationFooterShell>}
      </ConversationFooterSlotProvider>
    }
    const renderer = render(<><Scope id="parent" /><Scope id="thread" /></>)
    const parent = slots.parent.accessoryTarget!
    const thread = slots.thread.accessoryTarget!
    expect(parent).not.toBe(thread)
    expect(slots.parent.target).not.toBe(slots.thread.target)
    expect(parent).toHaveTextContent("parent typing")
    expect(thread).toHaveTextContent("thread typing")
    expect(renderer.getByTestId("parent").contains(parent)).toBe(true)
    expect(renderer.getByTestId("thread").contains(thread)).toBe(true)

    renderer.rerender(<><Scope id="parent" showFooter={false} /><Scope id="thread" /></>)
    expect(slots.parent.accessoryTarget).toBeNull()
    expect(slots.parent.target).toBeNull()
    expect(slots.thread.accessoryTarget).toBe(thread)
    expect(parent).not.toBeInTheDocument()
    expect(thread).toHaveTextContent("thread typing")

    renderer.rerender(<><Scope id="parent" /><Scope id="thread" /></>)
    expect(slots.parent.accessoryTarget).not.toBe(parent)
    expect(slots.parent.accessoryTarget).toHaveTextContent("parent typing")
    expect(slots.thread.accessoryTarget).toBe(thread)
  })
})
