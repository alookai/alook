import { createElement, createRef } from "react"
import { renderToString } from "react-dom/server"
import { Group, Panel, Separator, type GroupImperativeHandle } from "react-resizable-panels"
import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { ThreadSplitView } from "./thread-split-view"

const storageKey = "react-resizable-panels:community-thread-split-layout"
const saved = { parent: 57.538, thread: 42.462 }

function nativeGeometry(initialWidth: number) {
  let width = initialWidth
  const observers = new Set<{ notify: () => void }>()
  const elementWidth = (element: HTMLElement): number => {
    if (width === 0) return 0
    if (element.hasAttribute("data-separator")) return 1
    if (element.hasAttribute("data-panel")) {
      const siblings = Array.from(element.parentElement?.children ?? [])
        .filter(node => node.hasAttribute("data-panel")) as HTMLElement[]
      const weight = (node: HTMLElement) => parseFloat(node.style.flexGrow || node.style.flexBasis) || 0
      const total = siblings.reduce((sum, node) => sum + weight(node), 0)
      return Math.round((width - 1) * weight(element) / (total || 100))
    }
    return width
  }
  const elementLeft = (element: HTMLElement) => {
    const siblings = Array.from(element.parentElement?.children ?? []) as HTMLElement[]
    return element.parentElement?.hasAttribute("data-group")
      ? siblings.slice(0, siblings.indexOf(element)).reduce((left, node) => left + elementWidth(node), 0)
      : 0
  }
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(elementLeft(this), 0, elementWidth(this), 800)
  })
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) { return elementLeft(this) })
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return elementWidth(this) })
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return elementWidth(this) })
  vi.stubGlobal("ResizeObserver", class {
    targets = new Set<Element>()
    constructor(private callback: ResizeObserverCallback) { observers.add(this) }
    notify = () => {
      const entries = [...this.targets].filter(target => target.isConnected).map(target => ({
        target,
        contentRect: target.getBoundingClientRect(),
        borderBoxSize: [{ inlineSize: elementWidth(target as HTMLElement), blockSize: 800 }],
        contentBoxSize: [{ inlineSize: elementWidth(target as HTMLElement), blockSize: 800 }],
        devicePixelContentBoxSize: [{ inlineSize: elementWidth(target as HTMLElement), blockSize: 800 }],
      }))
      if (entries.length) this.callback(entries as ResizeObserverEntry[], this as unknown as ResizeObserver)
    }
    observe(target: Element) { this.targets.add(target); queueMicrotask(this.notify) }
    disconnect() { this.targets.clear(); observers.delete(this) }
    unobserve(target: Element) { this.targets.delete(target) }
  })
  return async (nextWidth: number) => {
    width = nextWidth
    await act(async () => { for (const observer of [...observers]) observer.notify() })
  }
}

describe("ThreadSplitView actual native persistence", () => {
  it.each([false, true].flatMap(hydrate => [false, true].flatMap(startFull => [false, true]
    .map(startZero => ({ hydrate, startFull, startZero })))))(
    "restores with hydration=$hydrate full=$startFull zero=$startZero",
    async ({ hydrate, startFull, startZero }) => {
      localStorage.setItem(storageKey, JSON.stringify(saved))
      const read = vi.spyOn(Storage.prototype, "getItem")
      const error = vi.spyOn(console, "error").mockImplementation(() => {})
      const resize = nativeGeometry(startZero ? 0 : 1225)
      const parent = createElement("span", null, "Parent")
      const thread = createElement("input", { defaultValue: "unsent child" })
      const node = createElement(ThreadSplitView, {
        split: !startFull, conversationSubtype: startFull ? "unknown" : "thread", parent, thread,
      })
      const browser = window
      let html = ""
      if (hydrate) {
        try {
          vi.stubGlobal("window", undefined)
          html = renderToString(node)
        } finally { vi.stubGlobal("window", browser) }
        expect(html).toContain("flex-basis:44%")
      }
      const container = document.createElement("div")
      container.innerHTML = html
      document.body.appendChild(container)
      const view = render(node, { container, hydrate })
      try {
        const group = container.querySelector("[data-group]")
        const input = container.querySelector("input")
        if (startFull) {
          view.rerender(createElement(ThreadSplitView, { split: true, conversationSubtype: "thread", parent, thread }))
          expect(container.querySelector("[data-group]")).toBe(group)
          expect(container.querySelector("input")).toBe(input)
          expect(input?.value).toBe("unsent child")
        }
        if (startZero) {
          await act(async () => { await Promise.resolve() })
          await resize(1225)
          expect(container.querySelector("[data-group]")).toBe(group)
          expect(container.querySelector("input")).toBe(input)
        }
        await waitFor(() => expect(read).toHaveBeenCalledWith(storageKey))
        const panel = container.querySelector("#thread") as HTMLElement
        await waitFor(() => expect(Number(panel.style.flexGrow)).toBeCloseTo(saved.thread, 2))
        expect(panel.style.flexBasis).toBe("0px")
        expect(error.mock.calls.filter(call => call.some(value => /hydrat/i.test(String(value))))).toEqual([])
        expect(localStorage.getItem(storageKey)).toBe(JSON.stringify(saved))
      } finally {
        view.unmount()
        container.remove()
        localStorage.removeItem(storageKey)
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
      }
    },
  )

  it("defers native application until its geometry callback reports a usable layout", async () => {
    const resize = nativeGeometry(0)
    const groupRef = createRef<GroupImperativeHandle>()
    const changed = vi.fn()
    const view = render(createElement(Group, { id: "zero-native-public", groupRef, onLayoutChanged: changed },
      createElement(Panel, { id: "parent", defaultSize: "56%", minSize: 320 }, "Parent"),
      createElement(Separator),
      createElement(Panel, { id: "thread", defaultSize: "44%", minSize: 360, maxSize: 800 }, "Child")))
    try {
      await act(async () => { await Promise.resolve() })
      expect(groupRef.current?.getLayout()).toEqual({})
      expect(changed).not.toHaveBeenCalled()
      let ignored: unknown
      act(() => { ignored = groupRef.current?.setLayout(saved) })
      expect(ignored).not.toEqual(saved)
      expect(groupRef.current?.getLayout()).toEqual({})
      await resize(1225)
      expect(changed).toHaveBeenCalled()
      expect(groupRef.current?.getLayout()).toEqual({ parent: 56, thread: 44 })
      act(() => { groupRef.current?.setLayout(saved) })
      expect(groupRef.current?.getLayout()).toEqual(saved)
      const panel = view.container.querySelector("#thread") as HTMLElement
      expect(panel.style.flexGrow).toBe("42.462")
      expect(panel.style.flexBasis).toBe("0px")
    } finally {
      view.unmount()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })

  it("saves a subsequent native keyboard resize after applying the stored layout", async () => {
    nativeGeometry(1225)
    localStorage.setItem(storageKey, JSON.stringify(saved))
    const view = render(createElement(ThreadSplitView, { split: true, parent: "Parent", thread: "Child" }))
    try {
      const panel = view.container.querySelector("#thread") as HTMLElement
      await waitFor(() => expect(Number(panel.style.flexGrow)).toBeCloseTo(saved.thread, 2))
      expect(localStorage.getItem(storageKey)).toBe(JSON.stringify(saved))
      const separator = view.container.querySelector("[data-separator]") as HTMLElement
      act(() => { separator.focus() })
      fireEvent.keyDown(separator, { key: "ArrowLeft" })
      await waitFor(() => expect(localStorage.getItem(storageKey)).not.toBe(JSON.stringify(saved)))
      const stored = JSON.parse(localStorage.getItem(storageKey)!) as typeof saved
      expect(stored.thread).toBeCloseTo(Number(panel.style.flexGrow), 2)
      expect(stored.parent + stored.thread).toBeCloseTo(100, 2)
    } finally {
      view.unmount()
      localStorage.removeItem(storageKey)
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })
})
