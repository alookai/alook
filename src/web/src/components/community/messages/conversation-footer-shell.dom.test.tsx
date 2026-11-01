import React from "react"
import { createPortal } from "react-dom"
import { act, fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { afterEach, describe, expect, it } from "vitest"
import { ConversationPresentationContext } from "@/contexts/community/conversation-activity"
import {
  ConversationFooterShell,
  ConversationFooterSlotProvider,
  useConversationFooterSlot,
} from "./conversation-footer-shell"

const originalWebkit = Object.getOwnPropertyDescriptor(window, "webkit")
const originalTauri = Object.getOwnPropertyDescriptor(window, "__TAURI__")
afterEach(() => {
  if (originalWebkit) Object.defineProperty(window, "webkit", originalWebkit)
  else Reflect.deleteProperty(window, "webkit")
  if (originalTauri) Object.defineProperty(window, "__TAURI__", originalTauri)
  else Reflect.deleteProperty(window, "__TAURI__")
})

describe("ConversationFooterShell", () => {
  it("reserves native occlusion only in the conversation footer and restores the existing style and draft", async () => {
    Object.defineProperty(window, "__TAURI__", { configurable: true, value: {} })
    let bottomInset = 0
    Object.defineProperty(window, "webkit", { configurable: true, value: { messageHandlers: {
      alookKeyboard: { postMessage: async () => ({ bottomInset, viewportWidth: window.innerWidth }) },
    } } })
    const renderer = render(<div data-testid="shell" style={{ height: 600, display: "flex" }}>
      <aside data-testid="rail" style={{ width: 56 }}>Rail</aside>
      <aside data-testid="sidebar" style={{ width: 260 }}>Sidebar</aside>
      <section data-testid="conversation" style={{ display: "flex", flexDirection: "column", flex: 1 }}>
        <header data-testid="header">Channel</header>
        <div data-testid="messages" style={{ flex: 1 }}>Messages</div>
        <ConversationFooterShell data-testid="footer" style={{ marginBottom: 6, borderRadius: 8 }}>
          <input aria-label="Native draft" defaultValue="Unsent draft" />
        </ConversationFooterShell>
      </section>
    </div>)
    const footer = renderer.getByTestId("footer")
    const draft = renderer.getByRole("textbox", { name: "Native draft" })
    const stable = ["shell", "rail", "sidebar", "conversation", "header", "messages"]
      .map(id => ({ node: renderer.getByTestId(id), style: renderer.getByTestId(id).getAttribute("style") }))
    bottomInset = 300
    act(() => window.dispatchEvent(new Event("alook:keyboard-change")))
    await waitFor(() => expect(footer).toHaveStyle({ marginBottom: "300px", borderRadius: "8px" }))
    for (const entry of stable) expect(entry.node.getAttribute("style")).toBe(entry.style)
    expect(renderer.getByRole("textbox", { name: "Native draft" })).toBe(draft)
    expect(draft).toHaveValue("Unsent draft")
    bottomInset = 0
    act(() => window.dispatchEvent(new Event("alook:keyboard-change")))
    await waitFor(() => expect(footer).toHaveStyle({ marginBottom: "6px", borderRadius: "8px" }))
    expect(renderer.getByRole("textbox", { name: "Native draft" })).toBe(draft)
  })

  it("keeps retained inactive conversations out of native layout consumption", async () => {
    Object.defineProperty(window, "__TAURI__", { configurable: true, value: {} })
    Object.defineProperty(window, "webkit", { configurable: true, value: { messageHandlers: {
      alookKeyboard: { postMessage: async () => ({ bottomInset: 200, viewportWidth: window.innerWidth }) },
    } } })
    function Page({ presented }: { presented: boolean }) {
      return <ConversationPresentationContext value={presented}>
        <ConversationFooterShell data-testid="footer"><input aria-label="Retained draft" defaultValue="Keep" /></ConversationFooterShell>
      </ConversationPresentationContext>
    }
    const renderer = render(<Page presented={false} />)
    const draft = renderer.getByRole("textbox", { name: "Retained draft" })
    await act(async () => {})
    expect(renderer.getByTestId("footer").style.marginBottom).toBe("")
    renderer.rerender(<Page presented />)
    await waitFor(() => expect(renderer.getByTestId("footer")).toHaveStyle({ marginBottom: "200px" }))
    renderer.rerender(<Page presented={false} />)
    expect(renderer.getByTestId("footer").style.marginBottom).toBe("")
    expect(renderer.getByRole("textbox", { name: "Retained draft" })).toBe(draft)
  })

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
