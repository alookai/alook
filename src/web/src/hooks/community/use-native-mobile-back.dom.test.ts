import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import {
  NATIVE_MOBILE_BACK_EVENT,
  useNativeMobileBack,
} from "./use-native-mobile-back"

function Harness(props: Parameters<typeof useNativeMobileBack>[0]) {
  useNativeMobileBack(props)
  return null
}

function dispatchBack() {
  const event = new Event(NATIVE_MOBILE_BACK_EVENT, { cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe("useNativeMobileBack", () => {
  afterEach(() => {
    document.querySelectorAll('[data-native-back-test-layer]').forEach((node) => node.remove())
  })

  it("dismisses the top document layer before shell or route navigation", () => {
    const dismissShellOverlay = vi.fn(() => true)
    const replacePath = vi.fn()
    const keydown = vi.fn()
    document.addEventListener("keydown", keydown, { once: true })
    const layer = document.createElement("div")
    layer.dataset.slot = "dialog-content"
    layer.dataset.nativeBackTestLayer = "true"
    document.body.append(layer)
    const renderer = render(createElement(Harness, {
      dismissShellOverlay,
      parentPath: "/c/me",
      replacePath,
    }))

    const event = dispatchBack()

    expect(event.defaultPrevented).toBe(true)
    expect(keydown).toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }))
    expect(dismissShellOverlay).not.toHaveBeenCalled()
    expect(replacePath).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("dismisses a shell overlay before replacing a detail route", () => {
    const dismissShellOverlay = vi.fn(() => true)
    const replacePath = vi.fn()
    const renderer = render(createElement(Harness, {
      dismissShellOverlay,
      parentPath: "/c/me",
      replacePath,
    }))

    expect(dispatchBack().defaultPrevented).toBe(true)
    expect(dismissShellOverlay).toHaveBeenCalledOnce()
    expect(replacePath).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("replaces a detail route and consumes back at a root route", () => {
    const dismissShellOverlay = vi.fn(() => false)
    const replacePath = vi.fn()
    const renderer = render(createElement(Harness, {
      dismissShellOverlay,
      parentPath: "/c/channels/s1",
      replacePath,
    }))

    expect(dispatchBack().defaultPrevented).toBe(true)
    expect(replacePath).toHaveBeenCalledWith("/c/channels/s1")

    renderer.rerender(createElement(Harness, {
      dismissShellOverlay,
      parentPath: null,
      replacePath,
    }))
    expect(dispatchBack().defaultPrevented).toBe(true)
    renderer.unmount()
    expect(dispatchBack().defaultPrevented).toBe(false)
  })
})

function touch(type: string, x: number, y = 100, count = 1, cancelable = true) {
  const points = Array.from({ length: count }, (_, identifier) => ({ identifier, clientX: x, clientY: y }))
  const event = new Event(type, { bubbles: true, cancelable })
  Object.defineProperties(event, {
    touches: { value: type === "touchend" ? [] : points },
    changedTouches: { value: points },
  })
  document.dispatchEvent(event)
  return event
}

function mobileHarness(parentPath: string | null = "/c/channels/s1") {
  const props = { mobile: true, gestureKey: "channel-1", parentPath, replacePath: vi.fn(), dismissShellOverlay: vi.fn(() => false) }
  return { props, renderer: render(createElement(Harness, props)) }
}

describe("mobile edge parent gesture", () => {
  it("replaces the parent once at the shared edge boundary, on release only", () => {
    const { props, renderer } = mobileHarness()
    touch("touchstart", 24)
    expect(touch("touchmove", 100).defaultPrevented).toBe(true)
    expect(props.replacePath).not.toHaveBeenCalled()
    touch("touchend", 100)
    touch("touchend", 100)
    expect(props.replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
    renderer.unmount()
  })

  it.each([
    [25, 110, 100, 110, 100],
    [0, 63, 100, 63, 100],
    [12, 8, 125, 100, 130],
    [12, 0, 100, 100, 100],
    [12, 100, 100, 20, 100],
    [12, 100, 100, 100, 220],
  ])("rejects outside/short/vertical/left/reversed/diagonal (%s,%s,%s,%s,%s)", (start, moveX, moveY, endX, endY) => {
    const { props, renderer } = mobileHarness()
    touch("touchstart", start)
    touch("touchmove", moveX, moveY)
    touch("touchend", endX, endY)
    expect(props.replacePath).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("leaves vertical edge scrolling and taps uncancelled", () => {
    const { props, renderer } = mobileHarness()
    expect(touch("touchstart", 10).defaultPrevented).toBe(false)
    expect(touch("touchmove", 12, 130).defaultPrevented).toBe(false)
    expect(touch("touchend", 12, 150).defaultPrevented).toBe(false)
    expect(props.replacePath).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it.each(["touchcancel", "multitouch", "browser-scroll", "route", "desktop", "unmount"])("cancels on %s", (reason) => {
    const { props, renderer } = mobileHarness()
    touch("touchstart", 10)
    touch("touchmove", 100)
    if (reason === "touchcancel") touch("touchcancel", 100)
    if (reason === "browser-scroll") touch("touchmove", 110, 100, 1, false)
    if (reason === "multitouch") touch("touchmove", 100, 100, 2)
    if (reason === "route") renderer.rerender(createElement(Harness, { ...props, gestureKey: "channel-2" }))
    if (reason === "desktop") renderer.rerender(createElement(Harness, { ...props, mobile: false }))
    if (reason === "unmount") renderer.unmount()
    touch("touchend", 120)
    expect(props.replacePath).not.toHaveBeenCalled()
    if (reason !== "unmount") renderer.unmount()
  })

  it("rejects a multi-finger start and consumes native back at the picker", () => {
    const { props, renderer } = mobileHarness(null)
    touch("touchstart", 10, 100, 2)
    expect(touch("touchmove", 100).defaultPrevented).toBe(false)
    touch("touchend", 100)
    touch("touchstart", 10)
    touch("touchmove", 100)
    touch("touchend", 100)
    expect(dispatchBack().defaultPrevented).toBe(true)
    expect(props.replacePath).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("dismisses overlays before a parent navigation", () => {
    const { props, renderer } = mobileHarness()
    props.dismissShellOverlay.mockReturnValue(true)
    touch("touchstart", 10)
    touch("touchmove", 100)
    touch("touchend", 100)
    expect(props.dismissShellOverlay).toHaveBeenCalledOnce()
    expect(props.replacePath).not.toHaveBeenCalled()
    renderer.unmount()
  })
})
