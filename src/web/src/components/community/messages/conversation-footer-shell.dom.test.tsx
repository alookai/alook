import React from "react"
import { createPortal } from "react-dom"
import { act, fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConversationPresentationContext } from "@/contexts/community/conversation-activity"
import {
  ConversationFooterShell,
  ConversationFooterSlotProvider,
  useConversationFooterSlot,
} from "./conversation-footer-shell"

const originalWebkit = Object.getOwnPropertyDescriptor(window, "webkit")
const originalTauri = Object.getOwnPropertyDescriptor(window, "__TAURI__")
afterEach(() => {
  document.documentElement.style.removeProperty("--alook-keyboard-progress")
  if (originalWebkit) Object.defineProperty(window, "webkit", originalWebkit)
  else Reflect.deleteProperty(window, "webkit")
  if (originalTauri) Object.defineProperty(window, "__TAURI__", originalTauri)
  else Reflect.deleteProperty(window, "__TAURI__")
})

describe("ConversationFooterShell", () => {
  it("tracks a growing composer, restores selection flow, and retains the draft", () => {
    let resize: ResizeObserverCallback | undefined
    const disconnect = vi.fn()
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback }
      observe() {}
      disconnect = disconnect
    })
    let height = 60
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { height: this.dataset.slot === "community-conversation-footer" ? height : 0 } as DOMRect
    })
    let slot: NonNullable<ReturnType<typeof useConversationFooterSlot>>
    function Controls() {
      slot = useConversationFooterSlot()!
      return <button onClick={() => slot.setSelectionActive(!slot.selectionActive)}>toggle</button>
    }
    const view = render(<ConversationFooterSlotProvider>
      <Controls />
      <ConversationFooterShell data-testid="overlay"><input defaultValue="Keep draft" /></ConversationFooterShell>
    </ConversationFooterSlotProvider>)
    try {
      const footer = view.getByTestId("overlay")
      const draft = view.getByRole("textbox")
      expect(footer).toHaveStyle({ marginTop: "-60px" })
      expect(slot!.overlayHeight).toBe(60)
      height = 132
      act(() => resize!([], {} as ResizeObserver))
      expect(footer).toHaveStyle({ marginTop: "-132px" })
      expect(slot!.overlayHeight).toBe(132)
      fireEvent.click(view.getByRole("button"))
      expect(slot!.overlayHeight).toBe(0)
      expect(footer.style.marginTop).toBe("")
      fireEvent.click(view.getByRole("button"))
      expect(footer).toHaveStyle({ marginTop: "-132px" })
      expect(view.getByRole("textbox")).toBe(draft)
      expect(draft).toHaveValue("Keep draft")
    } finally {
      view.unmount()
      rect.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it("keeps one retained footer and draft while native keyboard geometry changes from cover to expanded", async () => {
    const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth")
    Object.defineProperty(window, "__TAURI__", { configurable: true, value: {} })
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 382 })
    let native = { bottomInset: 285, viewportWidth: 382 }
    Object.defineProperty(window, "webkit", { configurable: true, value: { messageHandlers: {
      alookKeyboard: { postMessage: async () => native },
    } } })
    const view = render(<ConversationFooterShell data-testid="fold-footer" style={{ marginBottom: 6 }}>
      <input aria-label="Fold draft" defaultValue="Keep this unsent" />
    </ConversationFooterShell>)
    try {
      const footer = view.getByTestId("fold-footer")
      const draft = view.getByRole("textbox", { name: "Fold draft" })
      await waitFor(() => expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe(`${100 * 285 / 382}vw`))
      expect(footer).toHaveStyle({ marginBottom: "var(--alook-keyboard-progress, 6px)" })
      native = { bottomInset: 244, viewportWidth: 867 }
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 867 })
      act(() => window.dispatchEvent(new Event("resize")))
      await waitFor(() => expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe(`${100 * 244 / 867}vw`))
      expect(view.getByTestId("fold-footer")).toBe(footer)
      expect(view.getByRole("textbox", { name: "Fold draft" })).toBe(draft)
      expect(draft).toHaveValue("Keep this unsent")
      native = { bottomInset: 0, viewportWidth: 867 }
      act(() => window.dispatchEvent(new Event("alook:keyboard-change")))
      await waitFor(() => expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe(""))
      expect(footer).toHaveStyle({ marginBottom: "var(--alook-keyboard-progress, 6px)" })
    } finally {
      view.unmount()
      if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth)
    }
  })

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
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe(`${100 * 300 / window.innerWidth}vw`))
    expect(footer).toHaveStyle({ marginBottom: "var(--alook-keyboard-progress, 6px)", borderRadius: "8px" })
    for (const entry of stable) expect(entry.node.getAttribute("style")).toBe(entry.style)
    expect(renderer.getByRole("textbox", { name: "Native draft" })).toBe(draft)
    expect(draft).toHaveValue("Unsent draft")
    bottomInset = 0
    act(() => window.dispatchEvent(new Event("alook:keyboard-change")))
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe(""))
    expect(footer).toHaveStyle({ marginBottom: "var(--alook-keyboard-progress, 6px)", borderRadius: "8px" })
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
    await waitFor(() => expect(renderer.getByTestId("footer")).toHaveStyle({ marginBottom: "var(--alook-keyboard-progress, 0px)" }))
    expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe(`${100 * 200 / window.innerWidth}vw`)
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
