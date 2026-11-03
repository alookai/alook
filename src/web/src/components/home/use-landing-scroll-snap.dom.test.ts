import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { attachLandingScrollSnap } from "./use-landing-scroll-snap"

let y: number
let clock: number
let root: HTMLElement
let allowed: boolean
let dispose: (() => void) | undefined
let mediaChange: () => void
let nextFrame: number
const frames = new Map<number, FrameRequestCallback>()
const scrollTo = vi.fn()

function move(top: number) {
  y = top
  window.dispatchEvent(new Event("scroll"))
}
function wheel(deltaY = 100, target: EventTarget = root) {
  const event = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}
function point(top: number, bottom: number, hero = false) {
  const section = document.createElement("section")
  const node = hero ? section : document.createElement("div")
  if (hero) node.dataset.testid = "landing-hero"
  else { node.dataset.landingScrollAnchor = ""; section.append(node) }
  node.getBoundingClientRect = () => ({ top: top - y, bottom: bottom - y } as DOMRect)
  section.getBoundingClientRect = () => ({ top: top - y, bottom: bottom - y } as DOMRect)
  node.getClientRects = () => [{}] as unknown as DOMRectList
  root.append(section)
  return section
}
function frameAt(time: number) {
  clock = time
  const callbacks = [...frames.values()]
  frames.clear()
  callbacks.forEach(callback => callback(clock))
}

beforeEach(() => {
  vi.useFakeTimers()
  y = 0; clock = 0; nextFrame = 1; allowed = true
  frames.clear()
  scrollTo.mockReset().mockImplementation(({ top }: ScrollToOptions) => move(top!))
  vi.stubGlobal("scrollTo", scrollTo)
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++; frames.set(id, callback); return id
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
  vi.spyOn(performance, "now").mockImplementation(() => clock)
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y })
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 960 })
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 })
  Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 6000 })
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    get matches() {
      const minWidth = query.match(/min-width:\s*(\d+)px/)
      return allowed && (!minWidth || window.innerWidth >= Number(minWidth[1]))
    },
    addEventListener: (_event: string, listener: () => void) => { mediaChange = listener },
    removeEventListener: vi.fn(),
  })))
  root = document.createElement("main")
  document.body.append(root)
})
afterEach(() => {
  dispose?.(); dispose = undefined
  root.remove()
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe("desktop landing section transitions", () => {
  it("starts in a narrow 960px desktop window and lands core below navigation", () => {
    point(0, 900, true); point(1000, 1600)
    dispose = attachLandingScrollSnap(root)
    expect(wheel().defaultPrevented).toBe(true)
    expect(frames.size).toBe(1)
    expect(scrollTo).not.toHaveBeenCalled()
    frameAt(440)
    expect(y).toBe(912)
  })
  it("requires 20px intent rather than accidental tiny trackpad input", () => {
    point(0, 900, true); point(1000, 1600)
    dispose = attachLandingScrollSnap(root)
    wheel(5); expect(frames.size).toBe(0)
    wheel(15); expect(frames.size).toBe(1)
  })
  it("lets tall section content scroll before transitioning to the next core", () => {
    point(0, 900, true); point(1000, 3000); point(3300, 3900)
    y = 1000
    dispose = attachLandingScrollSnap(root)
    expect(wheel().defaultPrevented).toBe(false)
    expect(frames.size).toBe(0)
    move(2150); vi.advanceTimersByTime(48)
    expect(frames.size).toBe(1)
    frameAt(440)
    expect(y).toBe(3212)
  })
  it("consumes same-gesture momentum without skipping to a second section", () => {
    point(0, 900, true); point(1000, 1600); point(1900, 2500)
    dispose = attachLandingScrollSnap(root)
    wheel(); frameAt(300)
    expect(wheel().defaultPrevented).toBe(true)
    frameAt(440)
    expect(wheel().defaultPrevented).toBe(true)
    expect(frames.size).toBe(0)
    expect(y).toBe(912)
    clock = 700; wheel()
    expect(frames.size).toBe(1)
    frameAt(1140)
    expect(y).toBe(1812)
  })
  it("lets a reverse gesture interrupt and return to the previous section", () => {
    point(0, 900, true); point(1000, 1600)
    dispose = attachLandingScrollSnap(root)
    wheel(); frameAt(200)
    expect(y).toBeGreaterThan(0)
    wheel(-100); frameAt(640)
    expect(y).toBe(0)
  })
  it.each(["mobile", "reduced motion"])("does not intercept or animate when excluded by %s", () => {
    allowed = false
    point(0, 900, true); point(1000, 1600)
    dispose = attachLandingScrollSnap(root)
    expect(wheel().defaultPrevented).toBe(false)
    move(100); vi.advanceTimersByTime(500)
    expect(frames.size).toBe(0)
    expect(window.matchMedia).toHaveBeenCalledWith(expect.stringContaining("prefers-reduced-motion: no-preference"))
    expect(window.matchMedia).toHaveBeenCalledWith(expect.stringContaining("pointer: fine"))
  })
  it("leaves nested scrolling, horizontal gestures and consumed events alone", () => {
    point(0, 900, true); point(1000, 1600)
    const inner = document.createElement("div")
    inner.style.overflowY = "auto"
    Object.defineProperties(inner, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } })
    root.append(inner)
    dispose = attachLandingScrollSnap(root)
    expect(wheel(100, inner).defaultPrevented).toBe(false)
    const horizontal = new WheelEvent("wheel", { deltaY: 5, deltaX: 50, bubbles: true, cancelable: true })
    root.dispatchEvent(horizontal)
    const consumed = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true })
    consumed.preventDefault(); root.dispatchEvent(consumed)
    expect(frames.size).toBe(0)
  })
  it("supports scroll keys but preserves focused controls and Escape", () => {
    point(0, 900, true); point(1000, 1600)
    dispose = attachLandingScrollSnap(root)
    const button = document.createElement("button"); root.append(button)
    button.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }))
    expect(frames.size).toBe(0)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", cancelable: true }))
    expect(frames.size).toBe(1)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    expect(frames.size).toBe(0)
  })
  it("cancels frames on media change or unmount and does not capture footer scrolling", () => {
    point(0, 900, true); point(1000, 1600)
    dispose = attachLandingScrollSnap(root)
    wheel(); allowed = false; mediaChange()
    expect(frames.size).toBe(0)
    allowed = true; clock = 500; wheel()
    dispose(); dispose = undefined
    expect(frames.size).toBe(0)
    y = 2000; dispose = attachLandingScrollSnap(root)
    expect(wheel().defaultPrevented).toBe(false)
  })
})
