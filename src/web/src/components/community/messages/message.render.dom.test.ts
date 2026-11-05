import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import React from "react"
import { act, fireEvent, screen, waitFor, within, type RenderResult } from "@/test/react-dom-harness"
import { renderCommunity } from "@/test/community-owner-harness"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  createMessageMenuPointAnchor,
  Message,
  messageCanShare,
  messageEventBelongsToRow,
  messageLinkClickUsesMenu,
  messageLinkPointerType,
  selectionBelongsToRow,
  shouldAdoptDesktopMenuInput,
  shouldActivateMessageOverlays,
  shouldSuppressTouchMenuOpen,
} from "./message"
import type { RenderMsg } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"

vi.mock("@/lib/community-db/projections", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/community-db/projections")>(),
  useCanonicalCommunityProfile: (userId: string | null | undefined) => userId === "u1"
    ? { userId, name: "Alice", discriminator: "", avatar: "A", avatarVersion: 0 }
    : undefined,
}))
vi.mock("./emoji-picker-interactive", async () => {
  const ReactModule = await import("react")
  return { default: ({ onPick }: { onPick: (emoji: string) => void }) =>
    ReactModule.createElement("button", { onClick: () => onPick("🎉") }, "Pick celebration") }
})
vi.mock("@/hooks/community/use-reaction-details", () => ({
  useReactionDetails: () => ({ data: { actors: [] }, isLoading: false }),
}))
vi.mock("@/components/ui/number-ticker", () => ({
  NumberTicker: ({ value }: { value: string | number }) => React.createElement("span", null, value),
}))

type MessageProps = Parameters<typeof Message>[0]
let queryClient: QueryClient
const views = new Set<RenderResult>()
const restoreProperties: Array<() => void> = []
function replaceProperty(target: object, key: PropertyKey, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, value })
  restoreProperties.push(() => {
    if (original) Object.defineProperty(target, key, original)
    else Reflect.deleteProperty(target, key)
  })
}
function rtlRender(tree: React.ReactNode) {
  const view = renderCommunity(tree)
  views.add(view)
  return view
}
function baseMsg(over: Partial<RenderMsg> = {}): RenderMsg {
  return { id: "m1", type: "chat", authorId: "u1", authorName: "Alice", content: "hello", createdAt: new Date(0).toISOString(), grouped: false, ...over }
}
function makeTree(props: MessageProps) {
  return React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Message, props))
}
function mount(props: Partial<MessageProps> = {}) {
  return rtlRender(makeTree({ m: baseMsg(), onOpenThread: vi.fn(), ...props }))
}
function row(view: RenderResult): HTMLElement {
  const result = view.container.querySelector<HTMLElement>("[data-page-swipe-reply-row]")
  if (!result) throw new Error("Expected the actual message row")
  return result
}
function body(view: RenderResult): HTMLElement {
  const result = view.container.querySelector<HTMLElement>("[data-community-message-body]")
  if (!result) throw new Error("Expected the visible message body")
  return result
}
function activate(view: RenderResult) {
  fireEvent.pointerEnter(row(view), { pointerType: "mouse" })
}
async function contextMenu(view: RenderResult, target: Element = body(view)) {
  activate(view)
  fireEvent.contextMenu(target, { button: 2 })
  await waitFor(() => expect(screen.getByRole("menu")).toBeVisible())
  return screen.getByRole("menu")
}
async function touchMenu(view: RenderResult, target: Element = body(view), point = { clientX: 271, clientY: 603 }) {
  fireEvent.pointerDown(target, { pointerType: "touch", pointerId: 17, button: 0, ...point })
  fireEvent.touchStart(target)
  fireEvent.touchEnd(target)
  fireEvent.click(target, { button: 0, ...point })
  await waitFor(() => expect(screen.getByRole("menu")).toBeVisible())
  return screen.getByRole("menu")
}
async function closeMenu() {
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
}
function swipe(view: RenderResult, delta = { x: 68, y: 2 }) {
  const target = body(view)
  const capture = vi.fn()
  Object.defineProperty(row(view), "setPointerCapture", { configurable: true, value: capture })
  fireEvent.pointerDown(target, { pointerType: "touch", pointerId: 1, clientX: 80, clientY: 100 })
  fireEvent.pointerMove(target, { pointerType: "touch", pointerId: 1, clientX: 80 + delta.x, clientY: 100 + delta.y })
  fireEvent.pointerUp(target, { pointerType: "touch", pointerId: 1, clientX: 80 + delta.x, clientY: 100 + delta.y })
  return capture
}
function selectText(target: Element, substring?: string) {
  const selection = window.getSelection()!
  const range = document.createRange()
  range.selectNodeContents(target)
  if (substring) {
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
    const nodes: Node[] = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    const text = nodes.map(node => node.textContent).join("")
    const start = text.indexOf(substring)
    if (start < 0) throw new Error("The intended visible selection is missing")
    let offset = 0, started = false
    for (const node of nodes) {
      const length = node.textContent?.length ?? 0
      if (!started && start < offset + length) {
        range.setStart(node, start - offset)
        started = true
      }
      if (started && start + substring.length <= offset + length) {
        range.setEnd(node, start + substring.length - offset)
        break
      }
      offset += length
    }
  }
  selection.removeAllRanges()
  selection.addRange(range)
  return selection
}
function reactionGroup(view: RenderResult) {
  return view.getByTestId(tid.reactionGroup("m1"))
}
function addReaction(view: RenderResult) {
  return within(reactionGroup(view)).getByRole("button", { name: "Add reaction", exact: true })
}
function holdReaction(view: RenderResult, emoji: string) {
  fireEvent.pointerDown(view.getByTestId(tid.reactionChip("m1", emoji)), { pointerType: "touch", clientX: 20, clientY: 20 })
  act(() => vi.advanceTimersByTime(450))
  return screen.getByRole("dialog")
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} })
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} unobserve() {} })
})
afterEach(async () => {
  for (const view of views) view.unmount()
  views.clear()
  queryClient.clear()
  window.getSelection()?.removeAllRanges()
  await act(async () => { await Promise.resolve() })
  vi.useRealTimers()
  for (const restore of restoreProperties.splice(0).reverse()) restore()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const secondHref = "https://example.com/second/path?from=message&mode=full#details"
const insideAnchor = {} as Node
const insideFocus = {} as Node
const outside = {} as Node
const rowElement = { contains: (node: Node | null) => node === insideAnchor || node === insideFocus }

describe("Message author line", () => {

  it.each([false, true])("keeps selection local while grouped is %s", (grouped) => {
    const onToggleSelect = vi.fn()
    const view = rtlRender(makeTree({
      m: baseMsg({ grouped }),
      selectMode: true,
      selected: true,
      onToggleSelect,
    }))
    expect(view.container.querySelectorAll("[data-message-author-line]")).toHaveLength(grouped ? 0 : 1)
    expect(view.container.querySelectorAll("[data-message-selection-checkbox]")).toHaveLength(1)
    fireEvent.click(view.getByText("hello"))
    expect(onToggleSelect).toHaveBeenCalledOnce()
  })


})

describe("Message memo comparator", () => {

  it.each([true, false])("selects an external-link message without navigating (hover: %s)", async (hoverCapable) => {
    const onToggleSelect = vi.fn()
    const view = rtlRender(makeTree({
      m: baseMsg({ content: "https://example.com/selection" }),
      onOpenThread: vi.fn(), onEnterSelect: vi.fn(), onToggleSelect,
      hoverCapable, selectMode: true, selected: true,
    }))
    const link = await view.findByRole("link", { name: "Link: https://example.com/selection" })
    const click = new MouseEvent("click", { bubbles: true, cancelable: true })
    act(() => { link.dispatchEvent(click) })
    expect(click.defaultPrevented).toBe(true)
    expect(onToggleSelect).toHaveBeenCalledOnce()
  })


  it.each([true, false])("preserves the activated live avatar through share selection (hover: %s)", (hoverCapable) => {
    const props = { m: baseMsg(), onOpenThread: vi.fn(), onEnterSelect: vi.fn(), hoverCapable }
    const view = rtlRender(makeTree(props))
    if (hoverCapable) {
      fireEvent.pointerEnter(row(view), { pointerType: "mouse" })
    }
    const avatar = view.container.querySelector("[data-avatar-kind]")
    expect(avatar).not.toBeNull()
    view.rerender(makeTree({ ...props, selectMode: true, selected: true }))
    expect(view.container.querySelector("[data-avatar-kind]")).toBe(avatar)
    view.rerender(makeTree({ ...props, selectMode: false }))
    expect(view.container.querySelector("[data-avatar-kind]")).toBe(avatar)
  })


  it("keeps an inactive desktop row stable with disabled menus while selecting", async () => {
    const props = { m: baseMsg(), onOpenThread: vi.fn(), onEnterSelect: vi.fn(), hoverCapable: true }
    const view = rtlRender(makeTree(props))
    const avatar = view.container.querySelector("[data-avatar-kind]")
    const originalRow = row(view)
    expect(screen.queryByRole("menu")).toBeNull()
    view.rerender(makeTree({ ...props, selectMode: true }))
    fireEvent.pointerEnter(row(view), { pointerType: "mouse" })
    fireEvent.pointerDown(body(view), { pointerType: "touch" })
    fireEvent.focus(row(view))
    fireEvent.keyDown(row(view), { key: "F10", shiftKey: true })
    fireEvent.contextMenu(body(view), { button: 2 })
    expect(row(view)).toBe(originalRow)
    expect(view.container.querySelector("[data-avatar-kind]")).toBe(avatar)
    expect(screen.queryByRole("menu")).toBeNull()
    view.rerender(makeTree(props))
    await contextMenu(view)
    expect(screen.getByRole("menuitem", { name: "Share as Image", exact: true })).toBeVisible()
    expect(row(view)).toBe(originalRow)
    expect(view.container.querySelector("[data-avatar-kind]")).toBe(avatar)
  })


  it("keeps the precise deleted-user fallback for unresolved live authors", () => {
    const view = mount({ m: baseMsg({ authorId: "unresolved", authorName: "Static fixture name" }) })
    expect(view.getByRole("button", { name: "Deleted user", exact: true })).toBeVisible()
    expect(view.queryByText("Static fixture name")).toBeNull()
  })


  it("bails out when compared fields are unchanged despite a fresh `m` clone", () => {
    const resolveUserName = vi.fn((id: string) => id)
    const props = { m: baseMsg({ reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["u2"] }] }), resolveUserName, onOpenThread: vi.fn() }
    const view = rtlRender(makeTree(props))
    expect(view.getByTestId(tid.reactionChip("m1", "👍"))).toHaveAttribute("aria-pressed", "false")
    const initial = resolveUserName.mock.calls.length
    expect(initial).toBeGreaterThan(0)
    view.rerender(makeTree({ ...props, m: { ...props.m } }))
    expect(resolveUserName.mock.calls.length).toBe(initial)
  })


  it("re-renders when content changes (edit)", () => {
    const props = { m: baseMsg({ reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["u2"] }] }), resolveUserName: vi.fn((id: string) => id), onOpenThread: vi.fn() }
    const view = rtlRender(makeTree(props))
    expect(body(view)).toHaveTextContent(/^hello$/)
    view.rerender(makeTree({ ...props, m: { ...props.m, content: "edited" } }))
    expect(body(view)).toHaveTextContent(/^edited$/)
    expect(within(body(view)).queryByText("hello", { exact: true })).toBeNull()
  })


  it("re-renders when reactions change", () => {
    const props = { m: baseMsg({ reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["u2"] }] }), onOpenThread: vi.fn() }
    const view = rtlRender(makeTree(props))
    const chip = () => view.getByTestId(tid.reactionChip("m1", "👍"))
    expect(chip()).toHaveAccessibleName("👍, 1 reaction, you have not reacted. Press to toggle")
    expect(chip()).toHaveAttribute("aria-pressed", "false")
    view.rerender(makeTree({ ...props, m: { ...props.m, reactions: [{ emoji: "👍", count: 2, me: true, userIds: ["u2", "u3"] }] } }))
    expect(chip()).toHaveAccessibleName("👍, 2 reactions, you reacted. Press to toggle")
    expect(chip()).toHaveAttribute("aria-pressed", "true")
  })


})

describe("Message visible reply body", () => {

  it("keeps the reply header and renders the full visible Markdown body", () => {
    const view = mount({ m: baseMsg({ content: "@Bob Smith\n**visible** body", replyTo: { id: "prior", authorName: "Bob Smith", text: "original" } }) })
    expect(body(view)).toHaveTextContent("@Bob Smith")
    expect(within(body(view)).getByText("visible", { exact: true })).toBeVisible()
    expect(body(view)).toHaveTextContent("body")
    expect(body(view)).not.toHaveTextContent("**visible**")
    expect(view.getByRole("button", { name: "Show original message", exact: true })).toHaveTextContent("@Bob Smithoriginal")
  })


  it("keeps both different leading mentions and prefix-only reply text shareable", () => {
    const view = mount({ m: baseMsg({ content: "@Carol\nhello", replyTo: { id: "prior", authorName: "Bob", text: "original" } }) })
    expect(body(view)).toHaveTextContent("@Carol")
    expect(messageCanShare(baseMsg({ content: "@Bob\n", replyTo: { id: "prior", authorName: "Bob", text: "original" } }))).toBe(true)
  })


})

describe("Message embed links", () => {

  it("omits empty title and field blocks while retaining populated preview fields", () => {
    const props = { m: baseMsg({ embeds: [{ title: "", desc: "Preview summary", fields: [] }] }), onOpenThread: vi.fn() }
    const view = rtlRender(makeTree(props))
    expect(view.getByRole("article")).toHaveTextContent(/^Preview summary$/)
    view.rerender(makeTree({ ...props, m: baseMsg({ embeds: [{ title: "", desc: "Preview summary", fields: [{ name: "Status", value: "Ready" }] }] }) }))
    expect(within(view.getByRole("article")).getByText("Status", { exact: true })).toBeVisible()
    expect(within(view.getByRole("article")).getByText("Ready", { exact: true })).toBeVisible()
  })


  it("routes author and title URLs through the shared external-link anchor", () => {
    const view = mount({ m: baseMsg({ embeds: [{ title: "Example story", url: "https://example.com/story?from=embed", author: { name: "Example author", url: "https://example.com/author" } }] }) })
    const links = within(view.getByRole("article")).getAllByRole("link")
    expect(links).toHaveLength(2)
    expect(view.getByRole("link", { name: "Example author", exact: true })).toHaveAttribute("href", "https://example.com/author")
    expect(view.getByRole("link", { name: "Example story", exact: true })).toHaveAttribute("href", "https://example.com/story?from=embed")
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank")
      expect(link).toHaveAttribute("rel", "noopener noreferrer")
    }
  })


})

describe("Message ordinary-link gesture ownership", () => {

  it("derives actual touch/mouse modality before using hover capability as fallback", () => {
    const ownedTarget = {} as EventTarget
    const portalTarget = {} as EventTarget
    const rowOwner = { contains: (target: Node | null) => target === ownedTarget }
    expect(messageEventBelongsToRow(ownedTarget, rowOwner)).toBe(true)
    expect(messageEventBelongsToRow(portalTarget, rowOwner)).toBe(false)

    expect(messageLinkPointerType({ type: "click", pointerType: "touch" })).toBe("touch")
    expect(messageLinkPointerType({
      type: "click",
      sourceCapabilities: { firesTouchEvents: true },
    })).toBe("touch")
    expect(messageLinkPointerType({ type: "click" })).toBeNull()

    expect(messageLinkClickUsesMenu({
      clickPointerType: "touch", capturedPointerType: "mouse", hoverCapable: true,
    })).toBe(true)
    expect(messageLinkClickUsesMenu({
      clickPointerType: null, capturedPointerType: "pen", hoverCapable: true,
    })).toBe(true)
    expect(messageLinkClickUsesMenu({
      clickPointerType: null, capturedPointerType: "mouse", hoverCapable: false,
    })).toBe(false)
    expect(messageLinkClickUsesMenu({
      clickPointerType: null, capturedPointerType: null, hoverCapable: false,
    })).toBe(true)
    expect(messageLinkClickUsesMenu({
      clickPointerType: null, capturedPointerType: null, hoverCapable: true,
    })).toBe(false)
    expect(messageLinkClickUsesMenu({
      clickPointerType: null,
      capturedPointerType: null,
      hoverCapable: false,
      desktopInputSeen: true,
    })).toBe(false)
  })


  it("keeps mouse primary click direct on a touch-default device", async () => {
    const view = mount({ m: baseMsg({ content: `first https://example.com/first second ${secondHref}` }), hoverCapable: false, onCopy: vi.fn() })
    const link = await view.findByRole("link", { name: `Link: ${secondHref}` })
    activate(view)
    fireEvent.pointerDown(link, { button: 0, pointerType: "mouse" })
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    act(() => { link.dispatchEvent(click) })
    expect(click.defaultPrevented).toBe(false)
    expect(screen.queryByRole("menu")).toBeNull()
  })


  it("keeps keyboard Enter direct on a touch-default fallback", async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined)
    replaceProperty(window, "__TAURI__", { opener: { openUrl } })
    try {
      const view = mount({ m: baseMsg({ content: secondHref }), hoverCapable: false, onCopy: vi.fn() })
      const link = await view.findByRole("link", { name: `Link: ${secondHref}` })
      fireEvent.keyDown(link, { key: "Enter" })
      const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
      await act(async () => { link.dispatchEvent(click); await Promise.resolve() })
      expect(click.defaultPrevented).toBe(true)
      expect(openUrl).toHaveBeenCalledOnce()
      expect(openUrl).toHaveBeenCalledWith(secondHref)
      expect(screen.queryByRole("menu")).toBeNull()
    } finally {
      delete (window as Window & { __TAURI__?: unknown }).__TAURI__
    }
  })


  it("opens the existing menu first for a real touch tap on a hover-capable hybrid", async () => {
    const openWindow = vi.spyOn(window, "open").mockReturnValue(null)
    const writeText = vi.fn().mockResolvedValue(undefined)
    replaceProperty(navigator, "clipboard", { writeText })
    const view = mount({ m: baseMsg({ content: `first https://example.com/first second ${secondHref}` }), hoverCapable: true, onCopy: vi.fn(), onShareSingle: vi.fn() })
    const link = await view.findByRole("link", { name: `Link: ${secondHref}` })
    await touchMenu(view, link)
    expect(screen.getAllByRole("menuitem").map(item => item.textContent?.trim()).slice(-3)).toEqual(["Share as Image", "Copy Link", "Open Link"])
    expect(screen.getAllByRole("separator")).toHaveLength(1)
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Link", exact: true }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(secondHref))
    expect(openWindow).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    await touchMenu(view, link)
    fireEvent.click(screen.getByRole("menuitem", { name: "Open Link", exact: true }))
    expect(openWindow).toHaveBeenCalledOnce()
    expect(openWindow).toHaveBeenCalledWith(secondHref, "_blank", "noopener,noreferrer")
  })


  it("adds the link suffix only for the exact desktop secondary-click target and clears it", async () => {
    const openWindow = vi.spyOn(window, "open").mockReturnValue(null)
    const view = mount({ m: baseMsg({ content: `first https://example.com/first second ${secondHref}` }), hoverCapable: false, onCopy: vi.fn(), onShareSingle: vi.fn() })
    const link = await view.findByRole("link", { name: `Link: ${secondHref}` })
    await contextMenu(view, link)
    expect(screen.getAllByRole("menuitem").map(item => item.textContent?.trim()).slice(-3)).toEqual(["Share as Image", "Copy Link", "Open Link"])
    expect(screen.getAllByRole("separator")).toHaveLength(1)
    expect(openWindow).not.toHaveBeenCalled()
    await closeMenu()
    await contextMenu(view)
    expect(screen.queryByRole("menuitem", { name: "Copy Link", exact: true })).toBeNull()
    expect(screen.queryByRole("menuitem", { name: "Open Link", exact: true })).toBeNull()
    expect(screen.queryByRole("separator")).toBeNull()
  })


})

describe("Message Pin menu capability", () => {

  it.each([
    ["desktop right-click", true, "context-menu-item"],
    ["mobile touch", false, "dropdown-menu-item"],
  ] as const)("gates Pin and Unpin in the %s menu", async (_label, hoverCapable, _slot) => {
    const onPin = vi.fn()
    const props = { m: baseMsg(), hoverCapable, onOpenThread: vi.fn(), onCopy: vi.fn() }
    const view = rtlRender(makeTree(props))
    const open = () => hoverCapable ? contextMenu(view) : touchMenu(view)
    await open()
    expect(screen.queryByRole("menuitem", { name: "Pin Message", exact: true })).toBeNull()
    expect(screen.queryByRole("menuitem", { name: "Unpin Message", exact: true })).toBeNull()
    await closeMenu()
    view.rerender(makeTree({ ...props, onPin, pinned: false }))
    await open()
    expect(screen.queryByRole("menuitem", { name: "Unpin Message", exact: true })).toBeNull()
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin Message", exact: true }))
    expect(onPin).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    view.rerender(makeTree({ ...props, onPin, pinned: true }))
    await open()
    expect(screen.queryByRole("menuitem", { name: "Pin Message", exact: true })).toBeNull()
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin Message", exact: true }))
    expect(onPin).toHaveBeenCalledTimes(2)
  })


})

describe("Message portal event ownership", () => {

  it("keeps a reaction dialog mounted and ignores its pointer, click, and swipe events", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const onReply = vi.fn()
    const vibrate = vi.fn()
    replaceProperty(navigator, "vibrate", vibrate)
    const view = mount({ m: baseMsg({ content: "portal ownership", reactions: [{ emoji: "🔥", count: 1, me: false, userIds: ["u2"] }] }), hoverCapable: false, onCopy: vi.fn(), onReply, onToggleReaction: vi.fn() })
    const dialog = holdReaction(view, "🔥")
    expect(dialog).toBeVisible()
    expect(row(view).contains(dialog)).toBe(false)
    const target = within(dialog).getByText("portal ownership", { exact: true })
    fireEvent.pointerEnter(target, { pointerType: "mouse" })
    fireEvent.click(target, { clientX: 25, clientY: 25 })
    fireEvent.pointerDown(target, { pointerType: "touch", pointerId: 77, clientX: 80, clientY: 100 })
    fireEvent.pointerMove(target, { pointerType: "touch", pointerId: 77, clientX: 150, clientY: 102 })
    fireEvent.pointerUp(target, { pointerType: "touch", pointerId: 77, clientX: 150, clientY: 102 })
    expect(screen.getByRole("dialog")).toBe(dialog)
    expect(dialog).toBeVisible()
    expect(screen.queryByRole("menu")).toBeNull()
    expect(onReply).not.toHaveBeenCalled()
    expect(vibrate).not.toHaveBeenCalled()
  })


})

describe("Message reaction picker", () => {

  it("retains an open reaction details dialog and its empty state through final reaction removal", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const reaction = { emoji: "👍", count: 1, me: true, userIds: ["u1"] }
    const props = { m: baseMsg({ reactions: [reaction] }), hoverCapable: false, onOpenThread: vi.fn(), onReact: vi.fn() }
    const view = rtlRender(makeTree(props))
    const group = reactionGroup(view)
    const dialog = holdReaction(view, "👍")
    view.rerender(makeTree({ ...props, m: baseMsg({ reactions: [] }) }))
    expect(screen.getByRole("dialog")).toBe(dialog)
    expect(within(dialog).getByText("No reactions yet", { exact: true })).toBeVisible()
    expect(group.isConnected).toBe(true)
    fireEvent.click(within(dialog).getByRole("button", { name: "Close", exact: true }))
    act(() => vi.runOnlyPendingTimers())
    expect(group).toHaveFocus()
    view.rerender(makeTree(props))
    expect(view.getByTestId(tid.reactionChip("m1", "👍"))).toBeVisible()
    expect(reactionGroup(view)).toBe(group)
  })


  it("removes the inline reaction row from flow on1→0 and restores it on0→1 while retaining menu add", async () => {
    const onReact = vi.fn()
    const reaction = { emoji: "👍", count: 1, me: true, userIds: ["u1"] }
    const props = { m: baseMsg({ reactions: [reaction] }), hoverCapable: false, onOpenThread: vi.fn(), onReact }
    const view = rtlRender(makeTree(props))
    const group = reactionGroup(view)
    expect(addReaction(view)).toBeVisible()
    view.rerender(makeTree({ ...props, m: baseMsg({ reactions: [] }) }))
    expect(within(group).queryByRole("button")).toBeNull()
    expect(view.queryByTestId(tid.reactionChip("m1", "👍"))).toBeNull()
    expect(reactionGroup(view)).toBe(group)
    await touchMenu(view)
    fireEvent.click(screen.getByRole("menuitem", { name: "Add Reaction", exact: true }))
    expect(onReact).toHaveBeenCalledOnce()
    expect(onReact).toHaveBeenCalledWith("👍")
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    view.rerender(makeTree(props))
    expect(addReaction(view)).toBeVisible()
    expect(view.getByTestId(tid.reactionChip("m1", "👍"))).toBeVisible()
    expect(reactionGroup(view)).toBe(group)
  })


  it("opens the non-hover picker and suppresses its Shadow DOM selection click at the row", async () => {
    const onReact = vi.fn()
    const view = mount({ m: baseMsg({ reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["u2"] }] }), hoverCapable: false, onReact })
    expect(screen.queryByRole("button", { name: "Pick celebration", exact: true })).toBeNull()
    fireEvent.click(addReaction(view))
    fireEvent.click(await screen.findByRole("button", { name: "Pick celebration", exact: true }))
    expect(onReact).toHaveBeenCalledOnce()
    expect(onReact).toHaveBeenCalledWith("🎉")
    await waitFor(() => expect(screen.queryByRole("button", { name: "Pick celebration", exact: true })).toBeNull())
    const host = document.createElement("span")
    const shadow = host.attachShadow({ mode: "open" })
    const control = document.createElement("button")
    control.textContent = "Shadow control"
    const selected = vi.fn()
    control.addEventListener("click", selected)
    shadow.append(control)
    body(view).append(host)
    act(() => { control.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true })) })
    expect(selected).toHaveBeenCalledOnce()
    expect(screen.queryByRole("menu")).toBeNull()
    expect(onReact).toHaveBeenCalledOnce()
  })


  it("keeps desktop hover activation separate from click-to-open", async () => {
    const view = mount({ m: baseMsg({ reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["u2"] }] }), hoverCapable: true, onReact: vi.fn() })
    expect(addReaction(view)).toBeVisible()
    expect(screen.queryByRole("button", { name: "Pick celebration", exact: true })).toBeNull()
    activate(view)
    expect(addReaction(view)).toBeVisible()
    expect(screen.queryByRole("button", { name: "Pick celebration", exact: true })).toBeNull()
    fireEvent.click(addReaction(view))
    expect(await screen.findByRole("button", { name: "Pick celebration", exact: true })).toBeVisible()
  })


  it("keeps existing reaction chips on their exact toggle callback", () => {
    const onToggleReaction = vi.fn()
    const view = mount({ m: baseMsg({ reactions: [{ emoji: "🔥", count: 2, me: true, userIds: ["u1", "u2"] }] }), hoverCapable: false, onToggleReaction, onReact: vi.fn() })
    fireEvent.click(view.getByTestId(tid.reactionChip("m1", "🔥")))
    expect(onToggleReaction).toHaveBeenCalledOnce()
    expect(onToggleReaction).toHaveBeenCalledWith("🔥")
  })


  it("keeps the touch action menu Add Reaction item as the direct thumbs-up shortcut", async () => {
    const onReact = vi.fn()
    const view = mount({ m: baseMsg({ reactions: [] }), hoverCapable: false, onReact })
    await touchMenu(view)
    fireEvent.click(screen.getByRole("menuitem", { name: "Add Reaction", exact: true }))
    expect(onReact).toHaveBeenCalledOnce()
    expect(onReact).toHaveBeenCalledWith("👍")
  })


})

describe("Message touch action menu", () => {

  it("recovers the same row from mouse input to a real touch tap and back", async () => {
    const onCopy = vi.fn()
    const view = mount({ hoverCapable: false, onCopy })
    const originalRow = row(view)
    const originalBody = body(view)
    activate(view)
    fireEvent.pointerDown(body(view), { pointerType: "mouse", button: 0 })
    fireEvent.click(body(view))
    expect(screen.queryByRole("menu")).toBeNull()
    await touchMenu(view)
    expect(row(view)).toBe(originalRow)
    expect(body(view)).toBe(originalBody)
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Text", exact: true }))
    expect(onCopy).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    fireEvent.pointerDown(body(view), { pointerType: "mouse", button: 2 })
    await contextMenu(view)
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Text", exact: true }))
    expect(onCopy).toHaveBeenCalledTimes(2)
    expect(row(view)).toBe(originalRow)
    expect(body(view)).toBe(originalBody)
  })


  it("uses the touch menu for a concrete body tap on a hover-capable hybrid", async () => {
    const view = mount({ hoverCapable: true, onCopy: vi.fn() })
    await touchMenu(view)
    expect(screen.getByRole("menuitem", { name: "Copy Text", exact: true })).toBeVisible()
  })


  it("swipes right past threshold into the existing reply callback exactly once", async () => {
    const vibrate = vi.fn()
    replaceProperty(navigator, "vibrate", vibrate)
    const onReply = vi.fn()
    const view = mount({ hoverCapable: false, onReply })
    const capture = swipe(view)
    expect(onReply).toHaveBeenCalledOnce()
    expect(vibrate).toHaveBeenCalledOnce()
    expect(capture).toHaveBeenCalledWith(1)
    expect(row(view).style.transform).toBe("")
    fireEvent.pointerUp(body(view), { pointerType: "touch", pointerId: 1 })
    expect(onReply).toHaveBeenCalledOnce()
  })


  it("rejects vertical movement without replying or vibrating", async () => {
    const vibrate = vi.fn()
    replaceProperty(navigator, "vibrate", vibrate)
    const onReply = vi.fn()
    const view = mount({ hoverCapable: false, onReply })
    swipe(view, { x: 6, y: 30 })
    expect(onReply).not.toHaveBeenCalled()
    expect(vibrate).not.toHaveBeenCalled()
  })


  it("cancels a pending swipe when text selection starts inside the row", async () => {
    const vibrate = vi.fn()
    replaceProperty(navigator, "vibrate", vibrate)
    const onReply = vi.fn()
    const view = mount({ hoverCapable: false, onReply })
    const capture = vi.fn()
    Object.defineProperty(row(view), "setPointerCapture", { configurable: true, value: capture })
    fireEvent.pointerDown(body(view), { pointerType: "touch", pointerId: 1, clientX: 80, clientY: 100 })
    expect(selectText(body(view)).toString()).toBe("hello")
    fireEvent.pointerMove(body(view), { pointerType: "touch", pointerId: 1, clientX: 150, clientY: 102 })
    fireEvent.pointerUp(body(view), { pointerType: "touch", pointerId: 1, clientX: 150, clientY: 102 })
    expect(onReply).not.toHaveBeenCalled()
    expect(vibrate).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    expect(row(view).style.transform).toBe("")
  })


  it("long-presses an avatar once, suppresses profile click, and cancels on movement", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const onMentionAuthor = vi.fn()
    const onOpenProfile = vi.fn()
    const view = mount({ hoverCapable: false, onReply: vi.fn(), onMentionAuthor, onOpenProfile })
    const avatar = view.getByRole("button", { name: "Open Alice profile; long press to mention", exact: true })
    fireEvent.pointerDown(avatar, { pointerType: "mouse", clientX: 30, clientY: 40 })
    fireEvent.pointerMove(avatar, { pointerType: "mouse", clientX: 50, clientY: 40 })
    fireEvent.pointerDown(avatar, { pointerType: "touch", clientX: 30, clientY: 40 })
    act(() => vi.advanceTimersByTime(500))
    expect(onMentionAuthor).toHaveBeenCalledOnce()
    const context = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
    act(() => { avatar.dispatchEvent(context) })
    expect(context.defaultPrevented).toBe(true)
    fireEvent.click(avatar)
    expect(onOpenProfile).not.toHaveBeenCalled()
    fireEvent.pointerDown(avatar, { pointerType: "touch", clientX: 30, clientY: 40 })
    fireEvent.pointerMove(avatar, { pointerType: "touch", clientX: 50, clientY: 40 })
    act(() => vi.advanceTimersByTime(500))
    expect(onMentionAuthor).toHaveBeenCalledOnce()
    fireEvent.click(avatar)
    expect(onOpenProfile).not.toHaveBeenCalled()
    fireEvent.pointerDown(avatar, { pointerType: "touch", clientX: 30, clientY: 40 })
    fireEvent.pointerCancel(avatar, { pointerType: "touch" })
    act(() => vi.advanceTimersByTime(500))
    fireEvent.click(avatar)
    expect(onMentionAuthor).toHaveBeenCalledOnce()
    expect(onOpenProfile).not.toHaveBeenCalled()
    fireEvent.pointerDown(avatar, { pointerType: "touch", clientX: 30, clientY: 40 })
    fireEvent.pointerUp(avatar, { pointerType: "touch" })
    fireEvent.click(avatar)
    expect(onOpenProfile).toHaveBeenCalledOnce()
    fireEvent.pointerDown(avatar, { pointerType: "touch", clientX: 30, clientY: 40 })
    view.unmount()
    act(() => vi.advanceTimersByTime(500))
    expect(onMentionAuthor).toHaveBeenCalledOnce()
  })


  it("creates a zero-size virtual anchor at the viewport click coordinates", () => {
    const rect = createMessageMenuPointAnchor(123, 456).getBoundingClientRect()

    expect(rect).toMatchObject({
      x: 123,
      y: 456,
      top: 456,
      right: 123,
      bottom: 456,
      left: 123,
      width: 0,
      height: 0,
    })
  })


  it("uses row taps with an invisible dropdown anchor and no persistent ellipsis", async () => {
    const view = mount({ hoverCapable: false, onReply: vi.fn(), onCopy: vi.fn() })
    expect(view.queryByRole("button", { name: "More actions", exact: true })).toBeNull()
    const hiddenAnchor = view.container.querySelector('button[data-slot="dropdown-menu-trigger"][aria-hidden="true"]')
    expect(hiddenAnchor).not.toBeNull()
    expect(hiddenAnchor).toHaveAttribute("tabindex", "-1")
    expect(row(view)).not.toHaveAttribute("role", "button")
    expect(row(view)).not.toHaveAttribute("tabindex")
    await touchMenu(view)
    expect(screen.getByRole("menuitem", { name: "Reply", exact: true })).toBeVisible()
  })


  it("anchors an accepted row tap to its viewport coordinates", async () => {
    const onCopy = vi.fn()
    const view = mount({ m: baseMsg({ content: "long message\n".repeat(200) }), hoverCapable: false, onReply: vi.fn(), onCopy })
    await touchMenu(view, body(view), { clientX: 271, clientY: 603 })
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Text", exact: true }))
    expect(onCopy).toHaveBeenCalledOnce()
  })


  it("lets a short row tap reach the menu but suppresses long-press, selection, and nested-control taps", () => {
    expect(shouldSuppressTouchMenuOpen({
      nestedControl: false, selectionInsideRow: false, longPress: false,
    })).toBe(false)
    expect(shouldSuppressTouchMenuOpen({
      nestedControl: false, selectionInsideRow: false, longPress: true,
    })).toBe(true)
    expect(shouldSuppressTouchMenuOpen({
      nestedControl: false, selectionInsideRow: true, longPress: false,
    })).toBe(true)
    expect(shouldSuppressTouchMenuOpen({
      nestedControl: true, selectionInsideRow: false, longPress: false,
    })).toBe(true)
  })


})

describe("Message desktop text selection", () => {

  it("recognizes a non-collapsed selection with either endpoint inside the row", () => {
    expect(selectionBelongsToRow({
      isCollapsed: false,
      anchorNode: insideAnchor,
      focusNode: outside,
    }, rowElement)).toBe(true)
    expect(selectionBelongsToRow({
      isCollapsed: false,
      anchorNode: outside,
      focusNode: insideFocus,
    }, rowElement)).toBe(true)
  })


  it("rejects collapsed and outside-row selections", () => {
    expect(selectionBelongsToRow({
      isCollapsed: true,
      anchorNode: insideAnchor,
      focusNode: insideFocus,
    }, rowElement)).toBe(false)
    expect(selectionBelongsToRow({
      isCollapsed: false,
      anchorNode: outside,
      focusNode: outside,
    }, rowElement)).toBe(false)
    expect(selectionBelongsToRow(null, rowElement)).toBe(false)
  })


  it("recognizes a fully covered middle row in a cross-message selection", () => {
    const row = document.createElement("div")
    const before = document.createTextNode("first")
    const after = document.createTextNode("last")
    const container = document.createElement("div")
    container.append(before, row, after)
    row.textContent = "middle"
    const range = document.createRange()
    range.setStart(before, 1)
    range.setEnd(after, 2)
    expect(selectionBelongsToRow({
      isCollapsed: false, anchorNode: before, focusNode: after,
      rangeCount: 1, getRangeAt: () => range,
    }, row)).toBe(true)
    range.setEnd(before, 3)
    expect(selectionBelongsToRow({
      isCollapsed: false, anchorNode: before, focusNode: before,
      rangeCount: 1, getRangeAt: () => range,
    }, row)).toBe(false)
  })


  it("preserves secondary-click selection and copies its snapshot without reusing it on another open", async () => {
    const onCopy = vi.fn()
    const view = mount({ m: baseMsg({ content: "prefix chosen text suffix" }), onCopy })
    activate(view)
    expect(selectText(body(view), " chosen text ").toString()).toBe(" chosen text ")
    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 2, pointerType: "mouse" })
    act(() => { body(view).dispatchEvent(down) })
    expect(down.defaultPrevented).toBe(true)
    await contextMenu(view)
    window.getSelection()?.removeAllRanges()
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Text", exact: true }))
    expect(onCopy).toHaveBeenLastCalledWith(" chosen text ")
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    await contextMenu(view)
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Text", exact: true }))
    expect(onCopy).toHaveBeenLastCalledWith(undefined)
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    const other = document.createElement("p")
    other.textContent = "other row"
    view.container.append(other)
    selectText(other)
    const foreignDown = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 2, pointerType: "mouse" })
    act(() => { body(view).dispatchEvent(foreignDown) })
    expect(foreignDown.defaultPrevented).toBe(false)
    await contextMenu(view)
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Text", exact: true }))
    expect(onCopy).toHaveBeenLastCalledWith(undefined)
  })


  it("observes the desktop context target without taking over authenticated contextmenu policy", () => {
    const view = mount({ onCopy: vi.fn() })
    const observed = vi.fn()
    view.container.addEventListener("contextmenu", observed)
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })
    act(() => { body(view).dispatchEvent(event) })
    expect(observed).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(false)
    expect(screen.queryByRole("menu")).toBeNull()
  })


})

describe("Message image attachment layout", () => {

  it.each([
    { name: "attachment", fields: { attachments: [{ kind: "image" as const, name: "same.png", url: "/same.png" }] } },
    { name: "embed", fields: { embeds: [{ image: { url: "/same.png", width: 320, height: 200 } }] } },
    { name: "Markdown", fields: { content: "![Image](/same.png)" } },
  ])("retains a loaded $name image through activation, input menus and selection", async ({ fields }) => {
    const onImageLoad = vi.fn()
    const props = { m: baseMsg(fields), onOpenThread: vi.fn(), onCopy: vi.fn(), onImageLoad, onReply: vi.fn() }
    const view = rtlRender(makeTree(props))
    const image = view.container.querySelector<HTMLImageElement>('[data-remote-image-kind="content"]')!
    Object.defineProperties(image, {
      decode: { configurable: true, value: () => Promise.resolve() },
      naturalWidth: { configurable: true, value: 320 },
      naturalHeight: { configurable: true, value: 200 },
    })
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    expect(image).toHaveAttribute("data-remote-image-state", "ready")
    const originalRow = row(view)
    const retained = () => {
      expect(row(view)).toBe(originalRow)
      expect(view.container.querySelector('[data-remote-image-kind="content"]')).toBe(image)
      expect(image.isConnected).toBe(true)
      expect(image).toHaveAttribute("src", "/same.png")
      expect(image).toHaveAttribute("data-remote-image-state", "ready")
      expect(onImageLoad).toHaveBeenCalledTimes("content" in fields ? 0 : 1)
    }
    for (let cycle = 0; cycle < 3; cycle++) { activate(view); retained() }
    await contextMenu(view)
    retained()
    await closeMenu()
    await touchMenu(view)
    retained()
    await closeMenu()
    activate(view)
    retained()
    view.rerender(makeTree({ ...props, selectMode: true }))
    expect(view.container.querySelector('[data-remote-image-kind="content"]')).toBe(image)
    fireEvent.contextMenu(body(view), { button: 2 })
    expect(screen.queryByRole("menu")).toBeNull()
    view.rerender(makeTree(props))
    retained()
    view.rerender(makeTree({ ...props, hoverCapable: false }))
    retained()
    view.rerender(makeTree(props))
    retained()
  })


  it.each([
    { name: "attachment", fields: { attachments: [{ kind: "image" as const, name: "same.png", url: "/same.png" }] } },
    { name: "embed", fields: { embeds: [{ image: { url: "/same.png", width: 320, height: 200 } }] } },
    { name: "Markdown", fields: { content: "![Image](/same.png)" } },
  ])("retains a same-message $name image but retires readiness and late decode for a different message", async ({ fields }) => {
    const onOpenThread = vi.fn()
    const tree = (id: string, suffix = "") => makeTree({ m: baseMsg({ ...fields, id, reactions: suffix ? [{ emoji: "🔥", count: 1, me: false, userIds: [] }] : [] }), onOpenThread })
    const view = rtlRender(tree("one"))
    const current = () => view.container.querySelector<HTMLImageElement>('[data-remote-image-kind="content"]')!
    const prepare = (image: HTMLImageElement, decode = () => Promise.resolve()) => Object.defineProperties(image, {
      decode: { configurable: true, value: decode }, naturalWidth: { configurable: true, value: 320 }, naturalHeight: { configurable: true, value: 200 },
    })
    const first = current()
    prepare(first)
    fireEvent.load(first)
    await act(async () => { await Promise.resolve() })
    expect(first).toHaveAttribute("data-remote-image-state", "ready")
    view.rerender(tree("one", " update"))
    expect(current()).toBe(first)
    expect(first).toHaveAttribute("data-remote-image-state", "ready")
    view.rerender(tree("two"))
    const second = current()
    expect(second).not.toBe(first)
    expect(first.isConnected).toBe(false)
    let finish!: () => void
    const obsolete = new Promise<void>((resolve) => { finish = resolve })
    prepare(second, () => obsolete)
    fireEvent.load(second)
    view.rerender(tree("three"))
    const third = current()
    expect(third).not.toBe(second)
    await act(async () => { finish(); await obsolete })
    expect(third).toHaveAttribute("data-remote-image-state", "pending")
    prepare(third)
    fireEvent.load(third)
    await act(async () => { await Promise.resolve() })
    expect(third).toHaveAttribute("data-remote-image-state", "ready")
  })


  it("keeps a known portrait image intrinsic and constrains it by message width + max height", () => {
    const view = mount({ m: baseMsg({ attachments: [{ kind: "image", name: "portrait.png", url: "/portrait.png", width: 396, height: 702 }] }) })
    const image = view.getByRole("img", { name: "portrait.png", exact: true })
    expect(image).toHaveAttribute("src", "/portrait.png")
    expect(image).toHaveAttribute("width", "396")
    expect(image).toHaveAttribute("height", "702")
  })


  it("loads the canonical thumbnail in-list and opens the original identity on click", () => {
    const onPreviewImage = vi.fn()
    const view = mount({ m: baseMsg({ attachments: [{ kind: "image", name: "photo.png", url: "/original", thumbnailUrl: "/thumbnail", width: 640, height: 480 }] }), onPreviewImage })
    const image = view.getByRole("img", { name: "photo.png", exact: true })
    expect(image).toHaveAttribute("src", "/thumbnail")
    expect(image).toHaveAttribute("loading", "lazy")
    fireEvent.click(image)
    expect(onPreviewImage).toHaveBeenCalledOnce()
    expect(onPreviewImage).toHaveBeenCalledWith({ originalUrl: "/original", thumbnailUrl: "/thumbnail", name: "photo.png", width: 640, height: 480 })
  })


})

describe("Message file attachment", () => {

  it("opens previewable files through the shared attachment card", () => {
    const onPreviewAttachment = vi.fn()
    const file = { kind: "file" as const, name: "notes.md", url: "/notes", contentType: "text/markdown", sizeBytes: 128, size: "128 B" }
    const view = mount({ m: baseMsg({ attachments: [file] }), onPreviewAttachment })
    fireEvent.click(view.getByTestId("community-attachment-card-notes.md"))
    expect(onPreviewAttachment).toHaveBeenCalledOnce()
    expect(onPreviewAttachment).toHaveBeenCalledWith(file)
  })


  it("renders media through the shared progressive-disclosure block", async () => {
    const media = {
      kind: "file" as const,
      name: "voice.ogg",
      url: "/voice",
      contentType: "audio/ogg",
      sizeBytes: 256,
      size: "256 B",
    }
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined)
    const view = rtlRender(makeTree({
      m: baseMsg({ attachments: [media] }),
      onOpenThread: vi.fn(),
    }))

    expect(view.container.querySelectorAll("audio, video")).toHaveLength(0)
    fireEvent.click(view.getByRole("button", { name: "Play voice.ogg", exact: true }))
    await act(async () => { await Promise.resolve() })
    const player = view.container.querySelector("audio")
    expect(player).not.toBeNull()
    expect(player).toHaveAttribute("src", "/voice")
    expect(play).toHaveBeenCalledOnce()
    expect(play.mock.contexts[0]).toBe(player)
    fireEvent.click(view.getByRole("button", { name: "Pause voice.ogg", exact: true }))
    expect(pause).toHaveBeenCalledOnce()
    expect(pause.mock.contexts[0]).toBe(player)
    expect(view.getByRole("button", { name: "Play voice.ogg", exact: true })).toBeEnabled()
  })


})

describe("Message lazy overlays", () => {

  it("does not swap menu shells when portal close reveals the pointer over restored focus", () => {
    const focused = {} as Element
    const row = { contains: vi.fn((target: Node | null) => target === focused) }

    expect(shouldAdoptDesktopMenuInput("mouse", row, focused)).toBe(false)
    expect(shouldAdoptDesktopMenuInput("mouse", row, null)).toBe(true)
    expect(shouldAdoptDesktopMenuInput("touch", row, null)).toBe(false)
  })


  it("keeps coarse swipe reply available after the row sees mouse input", () => {
    const onReply = vi.fn()
    const view = mount({ hoverCapable: false, onReply })
    activate(view)
    swipe(view)
    expect(onReply).toHaveBeenCalledOnce()
  })


  it("does not remount the row when the pointer enters an author button", () => {
    const onOpenProfile = vi.fn()
    const view = mount({ onOpenProfile, onReply: vi.fn() })
    const author = view.getByRole("button", { name: "Alice", exact: true })
    const originalRow = row(view)
    fireEvent.pointerEnter(author, { pointerType: "mouse" })
    expect(view.getByRole("button", { name: "Alice", exact: true })).toBe(author)
    expect(row(view)).toBe(originalRow)
    fireEvent.click(author)
    expect(onOpenProfile).toHaveBeenCalledOnce()
    expect(shouldActivateMessageOverlays(author)).toBe(false)
    expect(shouldActivateMessageOverlays(body(view))).toBe(true)
  })


  it("keeps the first author click live while lazy overlays are inactive", () => {
    const onOpenProfile = vi.fn()
    const view = mount({ onOpenProfile, onReply: vi.fn() })
    const author = view.getByRole("button", { name: "Alice", exact: true })
    fireEvent.pointerEnter(author, { pointerType: "mouse" })
    expect(screen.queryByRole("menu")).toBeNull()
    expect(view.queryByRole("button", { name: "Reply", exact: true })).toBeNull()
    const click = new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 20 })
    act(() => { author.dispatchEvent(click) })
    expect(onOpenProfile).toHaveBeenCalledOnce()
    expect(onOpenProfile.mock.calls[0][0]).toBe("Alice")
    expect(onOpenProfile.mock.calls[0][1].nativeEvent).toBe(click)
    expect(onOpenProfile.mock.calls[0].slice(2)).toEqual([undefined, "u1"])
  })


  it("keeps menu contents and toolbar lazy with a stable disabled root until activation", async () => {
    const onReply = vi.fn()
    const view = mount({ onReply, onReact: vi.fn() })
    const originalRow = row(view)
    expect(screen.queryByRole("menu")).toBeNull()
    expect(view.queryByRole("button", { name: "Reply", exact: true })).toBeNull()
    expect(view.queryByTestId(tid.reactionAdd("m1"))).toBeNull()
    activate(view)
    expect(row(view)).toBe(originalRow)
    fireEvent.click(view.getByRole("button", { name: "Reply", exact: true }))
    expect(onReply).toHaveBeenCalledOnce()
    await contextMenu(view)
    expect(screen.getByRole("menuitem", { name: "Reply", exact: true })).toBeVisible()
    expect(row(view)).toBe(originalRow)
  })


  it.each([
    ["Retry", (onRetry: ReturnType<typeof vi.fn>, _onDismiss: ReturnType<typeof vi.fn>) => onRetry],
    ["Dismiss", (_onRetry: ReturnType<typeof vi.fn>, onDismiss: ReturnType<typeof vi.fn>) => onDismiss],
  ])("keeps a failed row out of lazy overlays so pointerenter → first %s click fires once", (label, expectedCallback) => {
    const onRetry = vi.fn()
    const onDismiss = vi.fn()
    const view = mount({ m: baseMsg({ failed: true }), onCopy: vi.fn(), onRetry, onDismiss })
    const originalRow = row(view)
    fireEvent.pointerEnter(row(view), { pointerType: "mouse" })
    expect(row(view)).toBe(originalRow)
    expect(screen.queryByRole("menu")).toBeNull()
    expect(view.queryByRole("button", { name: "More actions", exact: true })).toBeNull()
    fireEvent.click(view.getByRole("button", { name: label === "Dismiss" ? "Dismiss" : "Message failed to send. Click to retry.", exact: true }))
    expect(expectedCallback(onRetry, onDismiss)).toHaveBeenCalledOnce()
    expect(label === "Dismiss" ? onRetry : onDismiss).not.toHaveBeenCalled()
  })


})

describe("Message selected-text menu focus", () => {

  it("retains keyboard focus policy through close and leaves pointer focus alone", async () => {
    const view = mount({ m: baseMsg({ content: "selected message" }), hoverCapable: true, onCopy: vi.fn() })
    activate(view)
    selectText(body(view))
    await contextMenu(view)
    await closeMenu()
    expect(row(view)).toHaveFocus()
    const outsideButton = document.createElement("button")
    outsideButton.textContent = "Outside target"
    document.body.append(outsideButton)
    try {
      selectText(body(view))
      await contextMenu(view)
      fireEvent.pointerDown(outsideButton, { pointerType: "mouse", button: 0 })
      outsideButton.focus()
      fireEvent.click(outsideButton)
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
      expect(outsideButton).toHaveFocus()
      window.getSelection()?.removeAllRanges()
      await contextMenu(view)
      await closeMenu()
      view.unmount()
      outsideButton.focus()
      fireEvent.keyDown(document, { key: "Escape" })
      expect(outsideButton).toHaveFocus()
    } finally { outsideButton.remove() }
  })


})
