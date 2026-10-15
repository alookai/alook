import { StrictMode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@/test/react-dom-harness"
import { LineClamp } from "./line-clamp"

let views: Array<ReturnType<typeof render>>
let width = 10
let glyphWidth = 1
let callbacks: ResizeObserverCallback[]
let disconnects: Array<ReturnType<typeof vi.fn>>
let frames: Map<number, FrameRequestCallback>
let fonts: EventTarget
let settleFonts: () => void
let originalFonts: PropertyDescriptor | undefined

beforeEach(() => {
  views = []
  width = 10
  glyphWidth = 1
  callbacks = []
  disconnects = []
  frames = new Map()
  let nextFrame = 0
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame))
  vi.stubGlobal("ResizeObserver", class {
    observe = vi.fn()
    disconnect = vi.fn()
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback)
      disconnects.push(this.disconnect)
    }
  })
  fonts = Object.assign(new EventTarget(), { ready: new Promise<void>((resolve) => { settleFonts = resolve }) })
  originalFonts = Object.getOwnPropertyDescriptor(document, "fonts")
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const suffix = this.querySelector('[data-slot="line-clamp-after"]')?.textContent ?? ""
    const measuredWidth = this.dataset.slot === "line-clamp-content" ? Math.max(width, suffix.length * glyphWidth) : width
    return new DOMRect(0, 0, measuredWidth, 1)
  })
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    const cells = Array.from(this.textContent ?? "").length * glyphWidth
    const count = Math.ceil(cells / width)
    return Object.assign(Array.from({ length: count }, (_, index) => new DOMRect(0, index * 2, width, 1)), { item: () => null }) as unknown as DOMRectList
  })
})

afterEach(() => {
  views.forEach((view) => view.unmount())
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts)
  else Reflect.deleteProperty(document, "fonts")
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function flushLayout() {
  act(() => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((callback) => callback(0))
  })
}

function triggerResize() {
  act(() => { callbacks.at(-1)?.([], {} as ResizeObserver) })
  flushLayout()
}

function mount(text: string, options: { maxLines?: number; location?: "end" | "middle" } = {}) {
  const view = render(<LineClamp text={text} textTestId="text" after={<span data-testid="seq">#9</span>} {...options} />)
  views.push(view)
  return view
}

describe("LineClamp", () => {
  it("keeps full short and naturally wrapped two-line text with one intact suffix", () => {
    const rendered = mount("ABC")
    expect(screen.getByTestId("text")).toHaveTextContent("ABC")
    rendered.rerender(<LineClamp text="ABCDEFGHIJKLMNO" textTestId="text" after={<span data-testid="seq">#9</span>} />)
    expect(screen.getByTestId("text")).toHaveTextContent("ABCDEFGHIJKLMNO")
    expect(screen.getAllByTestId("seq")).toHaveLength(1)
    expect(rendered.container.querySelector('[data-clamped="false"]')).not.toBeNull()
    rendered.unmount()
  })

  it("reserves the entire suffix when truncating and exposes the full text to assistive technology", () => {
    const name = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    const rendered = mount(name, { maxLines: 1 })
    expect(screen.getByTestId("text")).toHaveTextContent("ABCDEFG…")
    expect(screen.getByTestId("text")).toHaveAttribute("aria-hidden", "true")
    expect(rendered.container.querySelector(".sr-only")).toHaveTextContent(name)
    expect(screen.getByTestId("seq")).toHaveTextContent("#9")
    expect(document.querySelector('[inert]')).toBeNull()
    rendered.unmount()
  })

  it("keeps both ends in middle mode for one or several lines", () => {
    const rendered = mount("ABCDEFGHIJKLMNO", { maxLines: 1, location: "middle" })
    expect(screen.getByTestId("text")).toHaveTextContent("ABCD…MNO")
    rendered.rerender(<LineClamp text="ABCDEFGHIJKLMNOPQRSTUVWXYZ" textTestId="text" location="middle" maxLines={2} after="#9" />)
    expect(screen.getByTestId("text")).toHaveTextContent("ABCDEFGHI…STUVWXYZ")
    rendered.unmount()
  })

  it.each([
    { budget: 3, after: "#9" },
    { budget: 4, after: "#9" },
    { budget: 1, after: undefined },
    { budget: 2, after: undefined },
  ])("uses an explicit middle fallback when width $budget cannot preserve both ends with $after", ({ budget, after }) => {
    width = budget
    const text = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    const rendered = render(<LineClamp data-testid="clamp" text={text} textTestId="text" maxLines={1} location="middle" after={after} />)
    views.push(rendered)
    expect(screen.getByTestId("text")).toBeEmptyDOMElement()
    expect(screen.getByTestId("clamp")).toHaveAttribute("data-clamp-fallback", "insufficient-space")
    expect(rendered.container.querySelector(".sr-only")).toHaveTextContent(text)
    if (after) expect(rendered.container.querySelector('[data-slot="line-clamp-after"]')).toHaveTextContent(after)
    rendered.unmount()
  })

  it("retains at least one complete grapheme on each end at the exact minimum middle budget", () => {
    width = 5
    const rendered = mount("ABCDEFGHIJKLMNOPQRSTUVWXYZ", { maxLines: 1, location: "middle" })
    expect(screen.getByTestId("text")).toHaveTextContent("A…Z")
    expect(rendered.container.querySelector("[data-clamp-fallback]")).toBeNull()
    width = 3
    rendered.rerender(<LineClamp text="ABCDEFGHIJKLMNOPQRSTUVWXYZ" textTestId="text" maxLines={2} location="middle" after="#9" />)
    expect(screen.getByTestId("text")).toHaveTextContent("AB…Z")
    expect(rendered.container.querySelector("[data-clamp-fallback]")).toBeNull()
    rendered.unmount()
  })

  it("cuts on whole grapheme boundaries rather than inside emoji or combining marks", () => {
    width = 30
    const name = "🧑🏽‍💻é🇨🇳👩‍👩‍👧‍👦".repeat(4)
    const rendered = mount(name, { maxLines: 1, location: "middle" })
    const [prefix, suffix] = screen.getByTestId("text").textContent!.split("…")
    expect(prefix.length).toBeGreaterThan(0)
    expect(suffix.length).toBeGreaterThan(0)
    const boundaries = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(name)].map(({ index }) => index)
    expect(boundaries).toContain(prefix.length)
    expect([...boundaries, name.length]).toContain(name.length - suffix.length)
    rendered.unmount()
  })

  it("reflows after container, suffix and font changes and after a zero-width mount becomes visible", async () => {
    width = 0
    const rendered = mount("ABCDEFGHIJKLMNOPQRSTUVWXY")
    expect(screen.getByTestId("text")).toHaveTextContent("ABCDEFGHIJKLMNOPQRSTUVWXY")
    width = 10
    triggerResize()
    expect(screen.getByTestId("text")).toHaveTextContent("ABCDEFGHIJKLMNOPQ…")
    width = 20
    triggerResize()
    expect(screen.getByTestId("text")).toHaveTextContent("ABCDEFGHIJKLMNOPQRSTUVWXY")
    glyphWidth = 2
    act(() => { fonts.dispatchEvent(new Event("loadingdone")) })
    flushLayout()
    expect(screen.getByTestId("text")).toHaveTextContent("ABCDEFGHIJKLMNOPQ…")
    rendered.rerender(<LineClamp text="ABCDEFGHIJKLMNOPQRSTUVWXY" textTestId="text" after="#12345" />)
    expect(screen.getByTestId("text")).toHaveTextContent("ABCDEFGHIJKLM…")
    rendered.unmount()
    await act(async () => { settleFonts() })
    expect(frames.size).toBe(0)
    expect(disconnects.every((disconnect) => disconnect.mock.calls.length === 1)).toBe(true)
  })

  it("omits an ellipsis that cannot fit and explicitly exposes an impossible suffix width", () => {
    width = 2
    const rendered = mount("ABCDEFGHIJKLMNO", { maxLines: 1 })
    expect(screen.getByTestId("text")).toBeEmptyDOMElement()
    expect(screen.getByTestId("seq")).toHaveTextContent("#9")
    expect(rendered.container.querySelector("[data-clamp-overflow]")).toBeNull()
    width = 1
    triggerResize()
    expect(rendered.container.querySelector('[data-clamp-overflow="true"]')).not.toBeNull()
    expect(screen.getByTestId("seq")).toHaveTextContent("#9")
    rendered.unmount()
  })

  it("keeps full text and the native bounded fallback when Intl.Segmenter is unavailable", () => {
    vi.stubGlobal("Intl", Object.assign(Object.create(Intl), { Segmenter: undefined }))
    const rendered = mount("👩‍👩‍👧‍👦é".repeat(4), { maxLines: 1 })
    expect(screen.getByTestId("text")).toHaveTextContent("👩‍👩‍👧‍👦é".repeat(4))
    expect(screen.getByTestId("text").style.webkitLineClamp).toBe("1")
    expect(screen.getByTestId("seq")).toHaveTextContent("#9")
    expect(disconnects).toHaveLength(0)
    rendered.unmount()
  })

  it("cleans up repeated StrictMode mounts and pending resize work", () => {
    const rendered = render(<StrictMode><LineClamp text="ABCDEFGHIJKLMNOPQRSTUVWXYZ" after="#9" /></StrictMode>)
    views.push(rendered)
    act(() => { callbacks.at(-1)?.([], {} as ResizeObserver) })
    expect(frames.size).toBeGreaterThan(0)
    rendered.unmount()
    act(() => { callbacks.at(-1)?.([], {} as ResizeObserver) })
    expect(frames.size).toBe(0)
    expect(disconnects.every((disconnect) => disconnect.mock.calls.length === 1)).toBe(true)
    expect(document.querySelector('[inert]')).toBeNull()
  })
})
