import React from "react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { fireEvent, render } from "@/test/react-dom-harness"
import { DEMO_MESSAGES } from "@/components/home/landing-interactive-shell-data"
import type { MessageCellPresentationProps } from "./message-cell-types"
import { MessageReplyPreview } from "../message-reply-preview"

let LobeMessageCell: typeof import("./lobe-message-cell")["LobeMessageCell"]

const appearance = vi.hoisted(() => ({ value: "light" }))
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: appearance.value }) }))

const observers = new Set<MutationObserver>()
const mediaListeners: Array<Set<EventListenerOrEventListenerObject>> = []
const listenerCount = () => mediaListeners.reduce((count, listeners) => count + listeners.size, 0)
const rootAttributes = () => [...document.documentElement.attributes].map(attribute => [attribute.name, attribute.value])
const originalFetch = globalThis.fetch

beforeAll(async () => {
  const OriginalObserver = window.MutationObserver
  class TrackedObserver extends OriginalObserver {
    observe(target: Node, options?: MutationObserverInit) { observers.add(this); super.observe(target, options) }
    disconnect() { observers.delete(this); super.disconnect() }
  }
  vi.stubGlobal("MutationObserver", TrackedObserver)
  vi.stubGlobal("matchMedia", (query: string) => {
    const listeners = new Set<EventListenerOrEventListenerObject>()
    mediaListeners.push(listeners)
    return {
      media: query, matches: false, onchange: null,
      addEventListener: (_type: string, fn: EventListenerOrEventListenerObject) => listeners.add(fn),
      removeEventListener: (_type: string, fn: EventListenerOrEventListenerObject) => listeners.delete(fn),
      addListener: (fn: EventListenerOrEventListenerObject) => listeners.add(fn),
      removeListener: (fn: EventListenerOrEventListenerObject) => listeners.delete(fn),
      dispatchEvent: () => false,
    }
  })
  const attributes = rootAttributes()
  // Observe the first native import and first mount, before a library singleton can become a baseline.
  ;({ LobeMessageCell } = await import("./lobe-message-cell"))
  expect(rootAttributes()).toEqual(attributes)
  expect(observers.size).toBe(0)
  expect(listenerCount()).toBe(0)
})

afterEach(() => {
  appearance.value = "light"
  vi.stubGlobal("fetch", originalFetch)
  expect(observers.size).toBe(0)
  expect(listenerCount()).toBe(0)
})
afterAll(() => { vi.unstubAllGlobals() })

function fixture(id = "native-lobe-message") {
  const reply = vi.fn(), mention = vi.fn(), profile = vi.fn(), copy = vi.fn(), reaction = vi.fn(), denied = vi.fn(), jump = vi.fn(), selection = vi.fn()
  const props: MessageCellPresentationProps = {
    message: { ...DEMO_MESSAGES["demo-general"][0], id, content: "Raw content must not create a second renderer" },
    authorName: "Canonical author", timestamp: "13:45", compact: false, grouped: false, selected: false, highlighted: false,
    onReply: reply, onMentionAuthor: mention, onCopy: copy, onToggleReaction: reaction,
    slots: {
      avatar: <button onPointerDown={mention} onClick={profile}>Original avatar</button>,
      header: <header>Canonical author <time>13:45</time></header>,
      reply: <button onClick={jump}>Original quote</button>,
      content: <div data-testid="safe-content">Original safe content</div>,
      footer: <button onClick={() => reaction("👍")}>Original reaction</button>,
      actions: <><button onClick={reply}>Original reply</button><button onClick={() => copy("selected")}>Original copy</button><button disabled onClick={denied}>Denied action</button></>,
      selection: <input type="checkbox" aria-label="Original selection" onChange={selection} />,
    },
  }
  return { props, reply, mention, profile, copy, reaction, denied, jump, selection }
}

describe("Lobe native cell with the shared real-message contract", () => {
  it("mounts the actual native cell and each safe slot once without a second body, input or request", () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const { props } = fixture()
    const view = render(<LobeMessageCell {...props} />)
    try {
      expect(view.container.querySelectorAll(".lobe-chat-item-docs")).toHaveLength(1)
      expect(view.getByTestId("safe-content").textContent).toBe("Original safe content")
      expect(view.getAllByText("13:45")).toHaveLength(1)
      expect(view.queryByText(props.message.content!)).toBeNull()
      expect(view.getAllByRole("button", { name: "Original avatar" })).toHaveLength(1)
      expect(view.getAllByRole("button", { name: "Original quote" })).toHaveLength(1)
      expect(view.getAllByRole("button", { name: "Original reaction" })).toHaveLength(1)
      expect(view.getByRole("checkbox", { name: "Original selection" })).not.toBeChecked()
      expect(view.queryByRole("textbox")).toBeNull()
      expect(view.queryByRole("log")).toBeNull()
      expect(fetch).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it("preserves the original avatar pointer and action callbacks once, including disabled actions", () => {
    const test = fixture()
    const view = render(<LobeMessageCell {...test.props} />)
    try {
      fireEvent.pointerDown(view.getByRole("button", { name: "Original avatar" }), { pointerType: "touch" })
      fireEvent.click(view.getByRole("button", { name: "Original avatar" }))
      fireEvent.click(view.getByRole("button", { name: "Original reply" }))
      fireEvent.click(view.getByRole("button", { name: "Original copy" }))
      fireEvent.click(view.getByRole("button", { name: "Original quote" }))
      fireEvent.click(view.getByRole("button", { name: "Original reaction" }))
      fireEvent.click(view.getByRole("checkbox", { name: "Original selection" }))
      fireEvent.click(view.getByRole("button", { name: "Denied action" }))
      expect(test.mention).toHaveBeenCalledTimes(1)
      expect(test.profile).toHaveBeenCalledTimes(1)
      expect(test.reply).toHaveBeenCalledTimes(1)
      expect(test.copy).toHaveBeenCalledExactlyOnceWith("selected")
      expect(test.jump).toHaveBeenCalledTimes(1)
      expect(test.reaction).toHaveBeenCalledExactlyOnceWith("👍")
      expect(test.selection).toHaveBeenCalledTimes(1)
      expect(test.denied).not.toHaveBeenCalled()
      expect(view.getByRole("button", { name: "Denied action" })).toBeDisabled()
    } finally { view.unmount() }
  })

  it("uses the replacement message and handlers when a mounted cell is rebound", () => {
    const first = fixture("first"), second = fixture("second")
    const view = render(<LobeMessageCell {...first.props} />)
    try {
      view.rerender(<LobeMessageCell {...second.props} />)
      expect(view.container.querySelector('[data-lobe-message-cell="first"]')).toBeNull()
      expect(view.container.querySelector('[data-lobe-message-cell="second"]')).not.toBeNull()
      fireEvent.click(view.getByRole("button", { name: "Original reply" }))
      fireEvent.pointerDown(view.getByRole("button", { name: "Original avatar" }), { pointerType: "touch" })
      expect(first.reply).not.toHaveBeenCalled()
      expect(first.mention).not.toHaveBeenCalled()
      expect(second.reply).toHaveBeenCalledTimes(1)
      expect(second.mention).toHaveBeenCalledTimes(1)
    } finally { view.unmount() }
  })

  it("uses the Current slot host and shared reply lifecycle behind actual native parts", () => {
    const test = fixture()
    const reply = { id: "target", authorName: "Peer", text: "", loading: true }
    const tree = (loading: boolean) => <LobeMessageCell {...test.props} slots={{ ...test.props.slots,
      reply: <MessageReplyPreview reply={{ ...reply, loading, text: loading ? "" : "Loading message…" }} authorName="Peer" onJump={test.jump} />,
    }} />
    const view = render(tree(true))
    try {
      const host = view.container.querySelector('[data-message-renderer="lobe"]')!
      const avatar = view.getByRole("button", { name: "Original avatar" })
      const body = view.getByRole("checkbox", { name: "Original selection" }).parentElement!
      expect(avatar.parentElement!.children[1]).toBe(body)
      expect(avatar.parentElement!.parentElement).toBe(host)
      expect(view.getByRole("button", { name: "Original reply" }).parentElement).toBe(host)
      expect(body.querySelectorAll(".lobe-chat-item-docs")).toHaveLength(1)
      expect(body.querySelector(".lobe-chat-chat-item__body")).not.toBeNull()
      expect(body.querySelector(".lobe-chat-chat-item__message")).not.toBeNull()
      const button = view.getByRole("button", { name: "Show original message" })
      const reserved = getComputedStyle(button).height
      expect(view.getByRole("status", { name: "Loading quoted message" })).toBeVisible()
      view.rerender(tree(false))
      expect(view.getByRole("button", { name: "Show original message" })).toBe(button)
      expect(getComputedStyle(button).height).toBe(reserved)
      expect(view.getByText("Loading message…")).toBeVisible()
      expect(view.queryByRole("status", { name: "Loading quoted message" })).toBeNull()
      fireEvent.click(button)
      expect(test.jump).toHaveBeenCalledTimes(1)
    } finally { view.unmount() }
  })

  it("does not invent avatar, quote, footer, actions or selection when their slots are absent", () => {
    const { props } = fixture()
    const view = render(<LobeMessageCell {...props} compact grouped slots={{ ...props.slots, avatar: null, reply: null, footer: null, actions: null, selection: null }} />)
    try {
      expect(view.container.querySelectorAll(".lobe-chat-item-docs")).toHaveLength(1)
      expect(view.queryByRole("button")).toBeNull()
      expect(view.queryByRole("checkbox")).toBeNull()
      expect(view.getByTestId("safe-content")).toBeVisible()
    } finally { view.unmount() }
  })

  it("scopes dark appearance and disposes native root observers and media listeners on unmount", () => {
    appearance.value = "dark"
    const attributes = rootAttributes()
    const { props } = fixture()
    const view = render(<LobeMessageCell {...props} />)
    try {
      expect(view.container.querySelector('[data-theme="dark"]')).not.toBeNull()
      expect(rootAttributes()).toEqual(attributes)
      expect(observers.size).toBeGreaterThan(0)
      expect(listenerCount()).toBeGreaterThan(0)
    } finally { view.unmount() }
    expect(observers.size).toBe(0)
    expect(listenerCount()).toBe(0)
    expect(rootAttributes()).toEqual(attributes)
  })
})
