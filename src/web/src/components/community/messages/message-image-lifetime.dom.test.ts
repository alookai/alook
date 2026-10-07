import React from "react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent, screen, waitFor } from "@/test/react-dom-harness"
import { renderCommunity } from "@/test/community-owner-harness"
import { Message } from "./message"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { RenderMsg } from "@/lib/community/models/message"

const m: RenderMsg = {
  id: "message-image-lifetime", type: "chat", authorId: "peer", authorName: "Peer",
  content: "selectable message https://example.com/read", createdAt: new Date(0).toISOString(), grouped: false,
  attachments: [{ kind: "image", name: "photo.png", url: "/original.png", thumbnailUrl: "/thumbnail.png", width: 320, height: 200 }],
}
const defaults = { m, onOpenThread: () => {}, onReply: () => {}, onCopy: () => {} }
function row(container: HTMLElement) { return container.querySelector<HTMLElement>('[data-slot="context-menu-trigger"]')! }
function thumbnail(container: HTMLElement) { return container.querySelector<HTMLImageElement>('img[src="/thumbnail.png"]')! }
function pointer(target: HTMLElement, type: string, name: "pointerdown" | "pointerover", button = 0) {
  const event = new MouseEvent(name, { bubbles: true, button, clientX: 20, clientY: 30 })
  Object.defineProperties(event, { pointerType: { value: type }, pointerId: { value: 1 } })
  fireEvent(target, event)
}
async function closeMenu() {
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals() })

it.each([true, false])("opens the first Shift+F10 with real Base UI while retaining media (hover=%s)", async (hoverCapable) => {
  const view = renderCommunity(React.createElement(Message, { ...defaults, hoverCapable }))
  const image = thumbnail(view.container), body = row(view.container), parent = image.parentElement
  expect(screen.queryByRole("menuitem")).toBeNull()
  expect((body.style as CSSStyleDeclaration & { WebkitTouchCallout: string }).WebkitTouchCallout).toBe(hoverCapable ? "none" : "default")
  fireEvent.keyDown(body, { key: "F10", shiftKey: true })
  expect(await screen.findByRole("menuitem", { name: "Reply" })).toBeVisible()
  expect(row(view.container)).toBe(body)
  expect(thumbnail(view.container)).toBe(image)
  expect(image.parentElement).toBe(parent)
  await closeMenu()
  expect(thumbnail(view.container)).toBe(image)
})

it("opens the first ContextMenu key without prior hover and keeps closed menu contents lazy", async () => {
  const view = renderCommunity(React.createElement(Message, { ...defaults }))
  const image = thumbnail(view.container)
  expect(document.querySelector('[data-slot="context-menu-content"]')).toBeNull()
  fireEvent.keyDown(row(view.container), { key: "ContextMenu" })
  expect(await screen.findByRole("menuitem", { name: "Reply" })).toBeVisible()
  await closeMenu()
  expect(document.querySelector('[data-slot="context-menu-content"]')).toBeNull()
  expect(thumbnail(view.container)).toBe(image)
})

it("keeps row, media and ancestors stable across hover, touch, mouse, selection and permissions", async () => {
  const onReply = vi.fn(), preview = vi.fn(), painted = vi.fn()
  const props = { ...defaults, hoverCapable: false, onReply, onPreviewImage: preview, onImageLoad: painted }
  const view = renderCommunity(React.createElement(Message, props))
  const image = thumbnail(view.container), body = row(view.container)
  let finish!: () => void
  const decode = new Promise<void>(resolve => { finish = resolve })
  Object.defineProperties(image, {
    decode: { configurable: true, value: () => decode },
    naturalWidth: { configurable: true, value: 320 },
    naturalHeight: { configurable: true, value: 200 },
  })
  fireEvent.load(image)
  fireEvent.error(image)
  const ancestors: Element[] = []
  for (let current = image.parentElement; current && current !== view.container; current = current.parentElement) ancestors.push(current)
  const sameLifetime = () => {
    expect(row(view.container)).toBe(body)
    expect(thumbnail(view.container)).toBe(image)
    expect(image.isConnected).toBe(true)
    for (const ancestor of ancestors) expect(ancestor.contains(image)).toBe(true)
  }
  pointer(body, "mouse", "pointerover")
  sameLifetime()
  fireEvent.contextMenu(body, { button: 2, clientX: 20, clientY: 30 })
  expect(await screen.findByRole("menuitem", { name: "Reply" })).toBeVisible()
  sameLifetime()
  await closeMenu()
  pointer(body, "touch", "pointerdown")
  fireEvent.click(body, { clientX: 30, clientY: 40 })
  expect(await screen.findByRole("menuitem", { name: "Reply" })).toBeVisible()
  sameLifetime()
  fireEvent.click(screen.getByRole("menuitem", { name: "Reply" }))
  expect(onReply).toHaveBeenCalledOnce()
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
  sameLifetime()
  pointer(body, "mouse", "pointerdown", 2)
  fireEvent.contextMenu(body, { button: 2 })
  expect(await screen.findByRole("menuitem", { name: "Reply" })).toBeVisible()
  sameLifetime()
  await closeMenu()
  view.rerender(React.createElement(Message, { ...props, selectMode: true, onToggleSelect: vi.fn() }))
  sameLifetime()
  const keyboard = new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })
  fireEvent(body, keyboard)
  expect(keyboard.defaultPrevented).toBe(false)
  expect(screen.queryByRole("menu")).toBeNull()
  view.rerender(React.createElement(Message, { ...props, m: { ...m, failed: true } }))
  sameLifetime()
  view.rerender(React.createElement(Message, { ...props, onReply: undefined, onCopy: undefined }))
  sameLifetime()
  view.rerender(React.createElement(Message, props))
  sameLifetime()
  await act(async () => { finish(); await decode })
  expect(image.dataset.remoteImageState).toBe("ready")
  expect(painted).toHaveBeenCalledOnce()
})

it.each([true, false])("closes an open menu on selection or capability loss without reopening it (hover=%s)", async (hoverCapable) => {
  const props = { ...defaults, hoverCapable }
  const view = renderCommunity(React.createElement(Message, props))
  const body = row(view.container), image = thumbnail(view.container)
  const open = async () => {
    if (hoverCapable) fireEvent.contextMenu(body, { button: 2 })
    else fireEvent.click(body)
    expect(await screen.findByRole("menuitem", { name: "Reply" })).toBeVisible()
  }
  await open()
  view.rerender(React.createElement(Message, { ...props, selectMode: true }))
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
  view.rerender(React.createElement(Message, props))
  expect(screen.queryByRole("menu")).toBeNull()
  await open()
  view.rerender(React.createElement(Message, { ...props, onReply: undefined, onCopy: undefined }))
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
  view.rerender(React.createElement(Message, props))
  expect(screen.queryByRole("menu")).toBeNull()
  expect(row(view.container)).toBe(body)
  expect(thumbnail(view.container)).toBe(image)
})

it("leaves text selection, nested preview clicks and native touch long press intact", async () => {
  const preview = vi.fn()
  const view = renderCommunity(React.createElement(Message, { ...defaults, hoverCapable: false, onPreviewImage: preview }))
  const body = row(view.container), image = thumbnail(view.container)
  const text = view.getByText(/selectable message/, { exact: false })
  const selection = window.getSelection()!, range = document.createRange()
  range.selectNodeContents(text); selection.addRange(range)
  pointer(body, "touch", "pointerdown")
  fireEvent.click(body)
  expect(screen.queryByRole("menu")).toBeNull()
  selection.removeAllRanges()
  fireEvent.click(view.getByRole("button", { name: "Open photo.png" }))
  expect(preview).toHaveBeenCalledOnce()
  expect(screen.queryByRole("menu")).toBeNull()
  const touch = new Event("touchstart", { bubbles: true, cancelable: true })
  Object.defineProperty(touch, "touches", { value: [{ clientX: 20, clientY: 30 }] })
  fireEvent(body, touch)
  expect(touch.defaultPrevented).toBe(false)
  expect((body.style as CSSStyleDeclaration & { WebkitTouchCallout: string }).WebkitTouchCallout).toBe("default")
  expect(thumbnail(view.container)).toBe(image)
})

it("keeps menu contents and mark reads inactive for untouched rows", () => {
  let client!: QueryClient
  function InspectOwner({ children }: { children: React.ReactNode }) {
    const current = useQueryClient()
    React.useLayoutEffect(() => { client = current }, [current])
    return children
  }
  const view = renderCommunity(React.createElement(InspectOwner, null, React.createElement("section", null, Array.from({ length: 30 }, (_, index) => React.createElement(Message, { ...defaults, key: index, m: { ...m, id: `closed-${index}` }, onMark: () => {} })))))
  for (let index = 0; index < 30; index++) {
    const query = client.getQueryCache().find({ queryKey: communityKeys.messageMarked(`closed-${index}`) })!
    expect(query.getObserversCount()).toBe(1)
    expect(query.isActive()).toBe(false)
    expect(query.state.fetchStatus).toBe("idle")
  }
  expect(view.container.querySelectorAll('[data-slot="context-menu-trigger"]')).toHaveLength(30)
  expect(document.querySelectorAll('[data-slot="context-menu-content"], [data-slot="dropdown-menu-content"]')).toHaveLength(0)
  expect(screen.queryByRole("menuitem")).toBeNull()
})
