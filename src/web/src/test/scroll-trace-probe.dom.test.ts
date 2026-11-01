import type { Page, TestInfo } from "@playwright/test"
import { communityBrowserEventBatchType } from "@alook/shared"
import { createElement } from "react"
import { expect, it, vi } from "vitest"
import { mockElementGeometry, render } from "@/test/react-dom-harness"
import { createScrollTraceIdentity, readScrollTraceProbe, startAnalyzedScrollTrace, validateScrollTrace } from "./e2e-ui/_fixtures/scroll-trace"

it("reinstalls and validates consecutive real probe captures with their analysis window and write cleanup", async () => {
  vi.useFakeTimers()
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id) })
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  const view = render(createElement("div", { "data-testid": "community-message-scroller" },
    createElement("div", { "data-message-list-content": "" },
      createElement("div", { "data-index": 0 }, createElement("div", { "data-msg-id": "m1" }, "row")),
    ),
  ))
  const root = view.getByTestId("community-message-scroller")
  const restoreGeometry = mockElementGeometry(root, { scrollHeight: 1000, clientHeight: 400 })
  const page = {
    addScriptTag: async ({ content }: { content: string }) => { new Function(content)() },
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
  } as unknown as Page
  const attach = vi.fn(async () => {})
  const info = { attach } as unknown as TestInfo
  const advance = async (count: number) => {
    for (let i = 0; i < count; i++) {
      await vi.advanceTimersByTimeAsync(16)
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(performance.now())
      await Promise.resolve()
    }
  }
  try {
    const dispatchDescriptor = Object.getOwnPropertyDescriptor(EventTarget.prototype, "dispatchEvent")
    for (const scenario of ["local-history-submission", "passive-append-position-admission"]) {
      const finish = await startAnalyzedScrollTrace(page, {
        scenario,
        identity: createScrollTraceIdentity({ account: "fixture", channel: "fixture", viewport: { width: 1280, height: 800 } }),
        dataTransitionSource: "overlay-ws",
      })
      expect(Object.getOwnPropertyDescriptor(EventTarget.prototype, "dispatchEvent")).toEqual(dispatchDescriptor)
      await advance(3)
      root.scrollTop = 599
      await advance(2)
      const finished = finish(info)
      await advance(12)
      const result = (await finished)!
      expect(validateScrollTrace(result)).toEqual([])
      expect(result.writes).toEqual(expect.arrayContaining([expect.objectContaining({ method: "scrollTop", args: [599] })]))
      expect(result.marks.map(mark => mark.name)).toEqual(expect.arrayContaining([`analysis-start:${scenario}`, `analysis-end:${scenario}`, "final-stimulus"]))
      expect(Reflect.get(globalThis, "__alookScrollTrace")).toBeUndefined()
      expect(Object.hasOwn(root, "scrollTop")).toBe(false)
      expect(frames.size).toBe(0)
      await expect(finish(info)).resolves.toBeUndefined()
    }
    expect(attach).toHaveBeenCalledTimes(4)
  } finally {
    Reflect.get(globalThis, "__alookScrollTrace")?.abort()
    restoreGeometry()
    view.unmount()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})

it("records only the current target reaction dispatch without payloads and restores dispatch on finish and abort", async () => {
  vi.useFakeTimers()
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id) })
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  class RoutedSocket extends EventTarget {
    constructor(readonly url: string) { super() }
  }
  vi.stubGlobal("WebSocket", RoutedSocket)
  const view = render(createElement("div", { "data-testid": "community-message-scroller" },
    createElement("div", { "data-message-list-content": "" },
      createElement("div", { "data-index": 0 }, createElement("div", { "data-msg-id": "m1" }, "row")),
    ),
  ))
  const root = view.getByTestId("community-message-scroller")
  const restoreGeometry = mockElementGeometry(root, { scrollHeight: 1000, clientHeight: 400 })
  const original = Object.getOwnPropertyDescriptor(EventTarget.prototype, "dispatchEvent")!
  const failures = new WeakSet<Event>()
  const failure = new Error("original dispatch failed")
  Object.defineProperty(EventTarget.prototype, "dispatchEvent", {
    ...original,
    value: function (this: EventTarget, event: Event) {
      if (failures.has(event)) throw failure
      return Reflect.apply(original.value, this, [event])
    },
  })
  const baseline = Object.getOwnPropertyDescriptor(EventTarget.prototype, "dispatchEvent")
  const advance = async (count: number) => {
    for (let i = 0; i < count; i++) {
      await vi.advanceTimersByTimeAsync(16)
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(performance.now())
      await Promise.resolve()
    }
  }
  const install = async () => {
    new Function(readScrollTraceProbe().source)()
    const api = Reflect.get(globalThis, "__alookScrollTrace")
    const capabilities = await api.start({
      scrollerTestId: "community-message-scroller",
      scenario: "measured-reactions-backward-growth",
      maxEvents: 8,
      identity: createScrollTraceIdentity({ account: "fixture", channel: "fixture", viewport: { width: 390, height: 800 } }),
    })
    expect(capabilities.wsDispatch.supported).toBe(true)
    return api
  }
  const reaction = (messageId: string) => ({ type: "community:reaction.add", messageId, emoji: "👍" })
  const message = (data: unknown) => new MessageEvent("message", { data: JSON.stringify(data), cancelable: true })
  const socket = new RoutedSocket("wss://fixture.test/api/ws/user?access_token=private-only")
  const delivered: Array<{ receiver: EventTarget; event: Event; timestamp: number }> = []
  socket.addEventListener("message", function (this: EventTarget, event) {
    delivered.push({ receiver: this, event, timestamp: Math.round(performance.now() * 1000) / 1000 })
    event.preventDefault()
  })
  try {
    const api = await install()
    api.mark("analysis-start:target-dispatch")
    await advance(3)
    expect(socket.dispatchEvent(message(reaction("m1")))).toBe(false)
    api.mark("stimulus:reactions-0", { detail: { messageId: "m1" } })
    expect(new RoutedSocket("wss://fixture.test/api/ws/other").dispatchEvent(message(reaction("m1")))).toBe(true)
    const otherTarget = Object.assign(new EventTarget(), { url: socket.url })
    expect(otherTarget.dispatchEvent(message(reaction("m1")))).toBe(true)
    for (const data of [reaction("m2"), { type: "auth", token: "private-only" },
      { type: "unrelated", events: [reaction("m1")] }, { ...reaction("m1"), type: "community:reaction.remove" }, null]) {
      expect(socket.dispatchEvent(message(data))).toBe(false)
    }
    expect(socket.dispatchEvent(new MessageEvent("message", { data: "not-json" }))).toBe(true)
    expect(socket.dispatchEvent(new MessageEvent("message", { data: new ArrayBuffer(2) }))).toBe(true)
    const first = message({ ...reaction("m1"), authorization: "private-only" })
    expect(socket.dispatchEvent(first)).toBe(false)
    const firstHandler = delivered.at(-1)!
    expect(firstHandler.receiver).toBe(socket)
    expect(firstHandler.event).toBe(first)
    expect(socket.dispatchEvent(message({
      type: communityBrowserEventBatchType(),
      events: [reaction("m2"), reaction("m1"), reaction("m1")],
    }))).toBe(false)
    const throwing = message(reaction("m1"))
    failures.add(throwing)
    expect(() => socket.dispatchEvent(throwing)).toThrow(failure)
    api.mark("stimulus:reactions-1", { detail: {} })
    expect(socket.dispatchEvent(message(reaction("m1")))).toBe(false)
    api.mark("stimulus:reactions-2", { detail: { messageId: "m2" } })
    expect(socket.dispatchEvent(message(reaction("m1")))).toBe(false)
    expect(socket.dispatchEvent(message(reaction("m2")))).toBe(false)
    expect(socket.dispatchEvent(message(reaction("m2")))).toBe(false)
    api.mark("analysis-end:target-dispatch")
    api.mark("final-stimulus")
    const finished = api.finish()
    await advance(12)
    const result = await finished
    expect(validateScrollTrace(result)).toEqual([])
    expect(result.externalEvents).toHaveLength(8)
    expect(result.externalEvents.map((event: { type: string }) => event.type)).toEqual([
      "ws-dispatch-enter", "ws-dispatch-return", "ws-dispatch-enter", "ws-dispatch-return",
      "ws-dispatch-enter", "ws-dispatch-return", "ws-dispatch-enter", "ws-dispatch-return",
    ])
    for (const [index, count] of [1, 2, 1, 1].entries()) {
      const [enter, returned] = result.externalEvents.slice(index * 2, index * 2 + 2)
      const detail = { sequence: index + 1, stimulus: `stimulus:reactions-${index === 3 ? 2 : 0}`, messageId: index === 3 ? "m2" : "m1", reactionCount: count }
      expect(enter.detail).toEqual(detail)
      expect(returned.detail).toEqual({ ...detail, outcome: index === 2 ? "threw" : "returned" })
      expect(enter.timestamp).toBeLessThanOrEqual(returned.timestamp)
    }
    expect(result.externalEvents[0].timestamp).toBeLessThanOrEqual(firstHandler.timestamp)
    expect(result.externalEvents[1].timestamp).toBeGreaterThanOrEqual(firstHandler.timestamp)
    expect(JSON.stringify(result)).not.toMatch(/private-only|access_token|authorization/)
    expect(Object.getOwnPropertyDescriptor(EventTarget.prototype, "dispatchEvent")).toEqual(baseline)
    expect(Reflect.get(globalThis, "__alookScrollTrace")).toBeUndefined()
    expect(Object.hasOwn(root, "scrollTop")).toBe(false)
    expect(frames.size).toBe(0)
    const next = await install()
    next.mark("stimulus:reactions-0", { detail: { messageId: "m1" } })
    next.abort()
    expect(Object.getOwnPropertyDescriptor(EventTarget.prototype, "dispatchEvent")).toEqual(baseline)
    expect(Reflect.get(globalThis, "__alookScrollTrace")).toBeUndefined()
    expect(Object.hasOwn(root, "scrollTop")).toBe(false)
    expect(frames.size).toBe(0)
    expect(() => socket.dispatchEvent(throwing)).toThrow(failure)
  } finally {
    Reflect.get(globalThis, "__alookScrollTrace")?.abort()
    Object.defineProperty(EventTarget.prototype, "dispatchEvent", original)
    restoreGeometry()
    view.unmount()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})
