import { createElement, StrictMode } from "react"
import { act, render } from "@/test/react-dom-harness"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useNativeBackMessages } from "./use-native-back-messages"

const backEvent = "test-native-back-message"
const progressEvent = "test-native-progress-message"
function Harness() { useNativeBackMessages(backEvent, progressEvent); return null }

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function setup(strict = false) {
  const bridge = { postMessage: vi.fn(), onmessage: null as ((event: MessageEvent<string>) => void) | null }
  vi.stubGlobal("AlookBack", bridge)
  const progress = vi.fn()
  const back = vi.fn()
  window.addEventListener(progressEvent, progress)
  window.addEventListener(backEvent, back)
  const renderer = render(strict ? createElement(StrictMode, null, createElement(Harness)) : createElement(Harness))
  const token = () => JSON.parse(bridge.postMessage.mock.calls.filter(([message]) =>
    JSON.parse(message).type === "subscribe").at(-1)![0]).document as string
  const send = (type: string, generation: number, rest: Record<string, unknown> = {}) => {
    act(() => { bridge.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      type, generation, href: location.href, document: token(), progress: type === "start" ? 0 : null, ...rest,
    }) })) })
  }
  return { bridge, progress, back, renderer, token, send, dispose: () => {
    renderer.unmount()
    window.removeEventListener(progressEvent, progress)
    window.removeEventListener(backEvent, back)
  } }
}

describe("document-scoped Android Back messages", () => {
  it("forwards one started gesture and progress to the existing terminal owner once", () => {
    const test = setup()
    test.send("start", 1)
    test.send("progress", 1, { progress: 0.4 })
    expect(test.progress.mock.calls.map(([event]) => event.detail)).toEqual([
      { progress: 0, started: true }, { progress: 0.4 },
    ])
    expect(test.back).not.toHaveBeenCalled()
    test.send("complete", 1)
    test.send("complete", 1)
    test.send("progress", 1, { progress: 0.9 })
    expect(test.back).toHaveBeenCalledOnce()
    expect(test.back.mock.calls[0][0].cancelable).toBe(true)
    expect(test.progress).toHaveBeenCalledTimes(2)
    test.dispose()
  })

  it("keeps direct button Back without a progress gesture", () => {
    const test = setup()
    test.send("complete", 1)
    test.send("complete", 3)
    expect(test.back).toHaveBeenCalledTimes(2)
    expect(test.progress.mock.calls.map(([event]) => event.detail.progress)).toEqual([null, null])
    test.dispose()
  })

  it("cancels without a navigation and rejects the cancelled or older completion", () => {
    const test = setup()
    test.send("start", 3)
    test.send("cancel", 3)
    test.send("complete", 3)
    test.send("start", 1)
    test.send("complete", 1)
    expect(test.back).not.toHaveBeenCalled()
    expect(test.progress.mock.calls.map(([event]) => event.detail.progress)).toEqual([0, null])
    test.send("start", 5)
    test.send("complete", 5)
    expect(test.back).toHaveBeenCalledOnce()
    test.dispose()
  })

  it("retires a native-consumed stale gesture before forwarding a fresh button completion", () => {
    const test = setup()
    test.send("start", 3)
    test.send("progress", 3, { progress: .5 })
    act(() => window.dispatchEvent(new Event("resize")))
    test.send("complete", 5)
    expect(test.progress.mock.calls.map(([event]) => event.detail.progress)).toEqual([0, .5, null])
    expect(test.back).toHaveBeenCalledOnce()
    test.send("complete", 3)
    expect(test.back).toHaveBeenCalledOnce()
    test.dispose()
  })

  it("rejects foreign documents, other URLs, malformed and out-of-session progress", () => {
    const test = setup()
    test.send("start", 1, { document: "old" })
    test.send("complete", 1, { href: `${location.href}#other` })
    act(() => { test.bridge.onmessage?.(new MessageEvent("message", { data: "not json" })) })
    test.send("progress", 1, { progress: 0.5 })
    test.send("start", 1)
    test.send("progress", 1, { progress: 2 })
    test.send("progress", 1, { progress: -1 })
    test.send("progress", 2, { progress: 0.5 })
    expect(test.back).not.toHaveBeenCalled()
    expect(test.progress).toHaveBeenCalledOnce()
    test.dispose()
  })

  it("retires pagehide and creates a fresh document token for BFCache restoration", () => {
    const test = setup()
    const first = test.token()
    test.send("start", 1)
    act(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })))
    test.send("complete", 1)
    expect(test.back).not.toHaveBeenCalled()
    act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
    expect(test.token()).not.toBe(first)
    test.send("complete", 1, { document: first })
    expect(test.back).not.toHaveBeenCalled()
    test.send("complete", 1)
    expect(test.back).toHaveBeenCalledOnce()
    test.dispose()
  })

  it("keeps retired StrictMode subscriptions inert and unsubscribes the current document", () => {
    const test = setup(true)
    const subscriptions = test.bridge.postMessage.mock.calls.map(([message]) => JSON.parse(message))
    expect(subscriptions.map((entry) => entry.type)).toEqual(["subscribe", "unsubscribe", "subscribe"])
    test.send("complete", 1, { document: subscriptions[0].document })
    expect(test.back).not.toHaveBeenCalled()
    const receive = test.bridge.onmessage!
    test.dispose()
    expect(test.bridge.onmessage).toBeNull()
    receive(new MessageEvent("message", { data: JSON.stringify({
      type: "complete", generation: 3, document: test.token(), href: location.href,
    }) }))
    expect(test.back).not.toHaveBeenCalled()
  })

  it("leaves existing Back inputs available without a native message object", () => {
    render(createElement(Harness))
    expect(window).not.toHaveProperty("AlookBack")
  })
})
