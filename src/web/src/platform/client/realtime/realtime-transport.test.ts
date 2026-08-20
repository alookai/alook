import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RealtimeTransportOptions } from "./realtime-transport"

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  readonly sent: string[] = []
  closed = false

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.closed = true
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }

  open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  message(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  raw(data: unknown) {
    this.onmessage?.({ data })
  }
}

class MockEventTarget {
  listeners = new Map<string, Set<() => void>>()

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }

  reset() {
    this.listeners.clear()
  }
}

const mockDocument = Object.assign(new MockEventTarget(), {
  visibilityState: "visible",
})
const mockWindow = Object.assign(new MockEventTarget(), {
  location: { origin: "http://localhost:3000", hostname: "localhost" },
})
const mockFetch = vi.fn()

vi.stubGlobal("WebSocket", MockWebSocket)
vi.stubGlobal("document", mockDocument)
vi.stubGlobal("window", mockWindow)
vi.stubGlobal("location", mockWindow.location)
vi.stubGlobal("fetch", mockFetch)
vi.stubEnv("NODE_ENV", "development")
vi.stubEnv("NEXT_PUBLIC_WS_DO_PORT", "8789")

let refs = new Map<string, { current: unknown }>()
let refCounter = 0
let callbacks = new Map<string, { fn: Function; deps: unknown[] }>()
let callbackCounter = 0
let effects = new Map<string, {
  deps: unknown[]
  setup: () => (() => void) | void
  cleanup?: () => void
}>()
let effectCounter = 0

function depsEqual(left: unknown[], right: unknown[]) {
  return left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]))
}

vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const id = `ref-${refCounter++}`
    if (!refs.has(id)) {
      refs.set(id, {
        current: typeof initial === "function"
          ? (initial as () => unknown)()
          : initial,
      })
    }
    return [refs.get(id)!.current, vi.fn()]
  },
  useRef: (initial: unknown) => {
    const id = `ref-${refCounter++}`
    if (!refs.has(id)) refs.set(id, { current: initial })
    return refs.get(id)!
  },
  useCallback: (fn: Function, deps: unknown[]) => {
    const id = `callback-${callbackCounter++}`
    const existing = callbacks.get(id)
    if (existing && depsEqual(existing.deps, deps)) return existing.fn
    callbacks.set(id, { fn, deps })
    return fn
  },
  useEffect: (setup: () => (() => void) | void, deps: unknown[]) => {
    const id = `effect-${effectCounter++}`
    const existing = effects.get(id)
    if (existing && depsEqual(existing.deps, deps)) return
    existing?.cleanup?.()
    const cleanup = setup()
    effects.set(id, { deps, setup, cleanup: cleanup || undefined })
  },
}))

type Frame = Record<string, unknown>
type PolicyReason = "bounded-frame"
type Options = RealtimeTransportOptions<Frame, PolicyReason>

function tokenResponse(token = "token-1", userId = "user-1", wsPort?: number) {
  return {
    ok: true,
    json: () => Promise.resolve({ userId, token, wsPort }),
  } as Response
}

function resetHarness() {
  MockWebSocket.instances = []
  mockFetch.mockReset()
  refs = new Map()
  refCounter = 0
  callbacks = new Map()
  callbackCounter = 0
  effects = new Map()
  effectCounter = 0
  mockDocument.visibilityState = "visible"
  mockDocument.reset()
  mockWindow.reset()
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function mount(options: Options) {
  const transportModule = await import("./realtime-transport")
  const handle = transportModule.useRealtimeTransport(options)
  await flushPromises()
  return { transportModule, handle }
}

function cleanupEffects() {
  for (const effect of effects.values()) effect.cleanup?.()
}

function replayEffects() {
  cleanupEffects()
  for (const effect of effects.values()) {
    const cleanup = effect.setup()
    effect.cleanup = cleanup || undefined
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe("useRealtimeTransport", () => {
  beforeEach(() => {
    resetHarness()
    vi.useFakeTimers()
    mockFetch.mockResolvedValue(tokenResponse())
  })

  afterEach(() => {
    cleanupEffects()
    vi.useRealTimers()
  })

  it("builds the local URL, authenticates, then sends caller-owned authenticated frames", async () => {
    mockFetch.mockResolvedValue(tokenResponse("token-local", "user-local", 3000))
    const trace: string[] = []
    const onMessage = vi.fn(() => trace.push("message"))
    await mount({
      onMessage,
      onAuthenticated: () => trace.push("authenticated"),
      authenticatedFrames: [{ type: "caller.ready" }],
    })

    const ws = MockWebSocket.instances[0]!
    expect(ws.url).toBe("ws://localhost:3000/api/ws/user?userId=user-local")
    ws.open()
    expect(ws.sent).toEqual([JSON.stringify({ type: "auth", token: "token-local" })])
    ws.message({ type: "auth.ok" })
    ws.message({ type: "work.updated", id: "w1" })

    expect(trace).toEqual(["authenticated", "message"])
    expect(ws.sent.at(-1)).toBe(JSON.stringify({ type: "caller.ready" }))
    expect(onMessage).toHaveBeenCalledWith({ type: "work.updated", id: "w1" })
  })

  it("uses the latest callbacks and authenticated frames without replacing the transport", async () => {
    const firstMessage = vi.fn()
    const first = await mount({ onMessage: firstMessage, authenticatedFrames: [] })
    const ws = MockWebSocket.instances[0]!
    ws.open()

    const latestMessage = vi.fn()
    refCounter = 0
    callbackCounter = 0
    effectCounter = 0
    const second = first.transportModule.useRealtimeTransport({
      onMessage: latestMessage,
      authenticatedFrames: [{ type: "latest.ready" }],
    })

    expect(second.send).toBe(first.handle.send)
    expect(MockWebSocket.instances).toEqual([ws])
    ws.message({ type: "auth.ok" })
    ws.message({ type: "latest.event" })
    expect(ws.sent.at(-1)).toBe(JSON.stringify({ type: "latest.ready" }))
    expect(latestMessage).toHaveBeenCalledWith({ type: "latest.event" })
    expect(firstMessage).not.toHaveBeenCalled()
  })

  it("rejects malformed and pre-auth frames, then remains usable", async () => {
    const onMessage = vi.fn()
    const dropped: string[] = []
    await mount({
      onMessage,
      onFrameDropped: ({ reason }) => dropped.push(reason),
    })
    const ws = MockWebSocket.instances[0]!
    ws.open()

    ws.raw('{"private-sentinel"')
    ws.message(null)
    ws.message([])
    ws.message({})
    ws.message({ type: "" })
    ws.message({ type: "before.auth" })
    ws.message({ type: "auth.ok" })
    ws.message({ type: "after.auth" })

    expect(dropped).toEqual([
      "invalid-json",
      "non-object",
      "non-object",
      "missing-type",
      "missing-type",
      "pre-auth-frame",
    ])
    expect(onMessage).toHaveBeenCalledOnce()
    expect(onMessage).toHaveBeenCalledWith({ type: "after.auth" })
  })

  it("applies a caller policy without imposing its limit on other frames", async () => {
    const onMessage = vi.fn()
    const onFrameDropped = vi.fn()
    await mount({
      onMessage,
      onFrameDropped,
      framePolicy: ({ frame, rawData }) => {
        if (frame.type === "bounded.event" && rawData.length > 100) {
          return {
            accepted: false,
            reason: "bounded-frame",
            byteCount: rawData.length,
          }
        }
        return { accepted: true, frame }
      },
    })
    const ws = MockWebSocket.instances[0]!
    ws.open()
    ws.message({ type: "auth.ok" })
    ws.message({ type: "bounded.event", payload: "x".repeat(200) })
    ws.message({ type: "generic.event", payload: "x".repeat(200) })

    expect(onFrameDropped).toHaveBeenCalledWith(expect.objectContaining({
      reason: "bounded-frame",
      frame: expect.objectContaining({ type: "bounded.event" }),
    }))
    expect(onMessage).toHaveBeenCalledOnce()
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "generic.event",
    }))
  })

  it("passes an AbortSignal to token fetch and aborts at the hard timeout", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted")
          error.name = "AbortError"
          reject(error)
        })
      }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await mount({ onMessage: vi.fn() })
    const signal = (mockFetch.mock.calls[0]?.[1] as RequestInit).signal

    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    await flushPromises()
    expect(signal?.aborted).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      "[ws] token fetch error:",
      expect.objectContaining({ name: "AbortError" }),
    )
  })

  it("does not connect while the page starts hidden", async () => {
    mockDocument.visibilityState = "hidden"

    await mount({ onMessage: vi.fn() })

    expect(mockFetch).not.toHaveBeenCalled()
    expect(MockWebSocket.instances).toEqual([])
  })

  it("cancels an in-flight token request when the page becomes hidden", async () => {
    let signal: AbortSignal | undefined
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })
    })
    await mount({ onMessage: vi.fn() })

    mockDocument.visibilityState = "hidden"
    mockDocument.dispatch("visibilitychange")
    await flushPromises()

    expect(signal?.aborted).toBe(true)
    expect(MockWebSocket.instances).toEqual([])
  })

  it("treats a caller-aborted token request as intentional", async () => {
    const NativeAbortController = globalThis.AbortController
    class CapturedAbortController extends NativeAbortController {
      static latest: CapturedAbortController | undefined

      constructor() {
        super()
        CapturedAbortController.latest = this
      }
    }
    vi.stubGlobal("AbortController", CapturedAbortController)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    warn.mockClear()
    mockFetch.mockImplementation((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      }))

    try {
      await mount({ onMessage: vi.fn() })
      const signal = (mockFetch.mock.calls[0]?.[1] as RequestInit).signal
      expect(CapturedAbortController.latest).toBeDefined()
      expect(signal).toBe(CapturedAbortController.latest?.signal)
      CapturedAbortController.latest!.abort()
      expect(signal?.aborted).toBe(true)
      await flushPromises()

      expect(mockFetch).toHaveBeenCalledOnce()
      expect(warn).not.toHaveBeenCalled()
      expect(MockWebSocket.instances).toEqual([])
    } finally {
      vi.stubGlobal("AbortController", NativeAbortController)
    }
  })

  it("retries HTTP and WebSocket construction failures", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce(tokenResponse())
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    class ThrowingWebSocket {
      static OPEN = MockWebSocket.OPEN

      constructor() {
        throw new Error("constructor unavailable")
      }
    }

    await mount({ onMessage: vi.fn() })
    expect(warn).toHaveBeenCalledWith("[ws] token fetch failed:", 503)

    vi.stubGlobal("WebSocket", ThrowingWebSocket)
    try {
      await vi.advanceTimersByTimeAsync(2_000)
      await flushPromises()

      expect(warn).toHaveBeenCalledWith(
        "[ws] WebSocket creation failed:",
        expect.objectContaining({ message: "constructor unavailable" }),
      )
    } finally {
      vi.stubGlobal("WebSocket", MockWebSocket)
    }
  })

  it("generation-fences the constructor boundary after token resolution", async () => {
    const originalOrigin = mockWindow.location.origin
    const originalHostname = mockWindow.location.hostname
    mockWindow.location.hostname = "alook.ai"
    vi.stubEnv("NODE_ENV", "production")
    Object.defineProperty(mockWindow.location, "origin", {
      configurable: true,
      get: () => {
        cleanupEffects()
        return "https://alook.ai"
      },
    })

    try {
      await mount({ onMessage: vi.fn() })
      await flushPromises()

      expect(MockWebSocket.instances).toEqual([])
    } finally {
      Object.defineProperty(mockWindow.location, "origin", {
        configurable: true,
        value: originalOrigin,
        writable: true,
      })
      mockWindow.location.hostname = originalHostname
      vi.stubEnv("NODE_ENV", "development")
    }
  })

  it("connect timeout closes the socket and stale handlers stay inert", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const onFrameDropped = vi.fn(() => {
      throw new Error("drop observer unavailable")
    })
    await mount({ onMessage: vi.fn(), onFrameDropped })
    const ws = MockWebSocket.instances[0]!

    expect(() => ws.onerror?.()).not.toThrow()
    ws.raw(new Uint8Array([1, 2, 3]))
    expect(onFrameDropped).toHaveBeenCalledWith(expect.objectContaining({
      reason: "invalid-json",
    }))
    expect(warn).toHaveBeenCalledWith(
      "[ws] frame-drop callback threw",
      { reason: "invalid-json" },
    )

    await vi.advanceTimersByTimeAsync(10_000)
    expect(ws.closed).toBe(true)
    expect(ws.sent).toEqual([])

    cleanupEffects()
    ws.open()
    expect(ws.sent).toEqual([])
  })

  it("ignores a reconnect timer after its generation is retired", async () => {
    await mount({ onMessage: vi.fn() })
    const ws = MockWebSocket.instances[0]!
    ws.close()
    const clearTimeoutSpy = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(() => {})

    try {
      cleanupEffects()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(mockFetch).toHaveBeenCalledOnce()
    } finally {
      clearTimeoutSpy.mockRestore()
    }
  })

  it("generation-fences cleanup and StrictMode token races", async () => {
    const firstToken = deferred<Response>()
    const secondToken = deferred<Response>()
    mockFetch
      .mockReturnValueOnce(firstToken.promise)
      .mockReturnValueOnce(secondToken.promise)
    await mount({ onMessage: vi.fn() })

    replayEffects()
    expect(mockFetch).toHaveBeenCalledTimes(2)
    secondToken.resolve(tokenResponse("latest-token", "latest-user"))
    await flushPromises()
    firstToken.resolve(tokenResponse("stale-token", "stale-user"))
    await flushPromises()

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0]?.url).toContain("latest-user")

    const pending = deferred<Response>()
    mockFetch.mockReturnValueOnce(pending.promise)
    mockDocument.dispatch("visibilitychange")
    cleanupEffects()
    pending.resolve(tokenResponse("retired-token", "retired-user"))
    await flushPromises()
    expect(MockWebSocket.instances.some((ws) => ws.url.includes("retired-user"))).toBe(false)
  })

  it("generation-fences a stale HTTP failure before retry scheduling", async () => {
    const firstToken = deferred<Response>()
    const secondToken = deferred<Response>()
    mockFetch
      .mockReturnValueOnce(firstToken.promise)
      .mockReturnValueOnce(secondToken.promise)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    warn.mockClear()
    await mount({ onMessage: vi.fn() })

    replayEffects()
    secondToken.resolve(tokenResponse("latest-token", "latest-user"))
    await flushPromises()
    firstToken.resolve({ ok: false, status: 503 } as Response)
    await flushPromises()

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0]?.url).toContain("latest-user")
    expect(warn).not.toHaveBeenCalledWith("[ws] token fetch failed:", 503)
  })

  it("generation-fences a constructor failure that retires its own attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    warn.mockClear()
    class RetiringWebSocket {
      static OPEN = MockWebSocket.OPEN

      constructor() {
        cleanupEffects()
        throw new Error("retired constructor")
      }
    }
    vi.stubGlobal("WebSocket", RetiringWebSocket)

    try {
      await mount({ onMessage: vi.fn() })
      await vi.advanceTimersByTimeAsync(60_000)

      expect(mockFetch).toHaveBeenCalledOnce()
      expect(warn).not.toHaveBeenCalledWith(
        "[ws] WebSocket creation failed:",
        expect.anything(),
      )
    } finally {
      vi.stubGlobal("WebSocket", MockWebSocket)
    }
  })

  it("generation-fences a retired connection timeout", async () => {
    await mount({ onMessage: vi.fn() })
    const ws = MockWebSocket.instances[0]!
    const close = vi.spyOn(ws, "close")
    const clearTimeoutSpy = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(() => {})

    try {
      cleanupEffects()
      expect(close).toHaveBeenCalledOnce()
      close.mockClear()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(close).not.toHaveBeenCalled()
    } finally {
      clearTimeoutSpy.mockRestore()
    }
  })

  it("reconnects with backoff only after replacement auth and reports the gap", async () => {
    const onDisconnect = vi.fn()
    const onReconnect = vi.fn()
    await mount({ onMessage: vi.fn(), onDisconnect, onReconnect })
    const first = MockWebSocket.instances[0]!
    first.open()
    first.message({ type: "auth.ok" })

    vi.setSystemTime(new Date("2026-08-20T08:00:00.000Z"))
    first.close()
    expect(onDisconnect).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2_000)
    const replacement = MockWebSocket.instances.at(-1)!
    replacement.open()
    expect(onReconnect).not.toHaveBeenCalled()
    replacement.message({ type: "auth.ok" })

    expect(onReconnect).toHaveBeenCalledWith({ reconnectDurationMs: 2_000 })
  })

  it("suppresses reconnect while hidden and resumes immediately when visible", async () => {
    await mount({ onMessage: vi.fn() })
    const first = MockWebSocket.instances[0]!
    first.open()
    first.message({ type: "auth.ok" })

    mockDocument.visibilityState = "hidden"
    mockDocument.dispatch("visibilitychange")
    first.close()
    const hiddenFetchCount = mockFetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockFetch).toHaveBeenCalledTimes(hiddenFetchCount)

    mockDocument.visibilityState = "visible"
    mockDocument.dispatch("visibilitychange")
    await flushPromises()
    expect(mockFetch).toHaveBeenCalledTimes(hiddenFetchCount + 1)
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it("keeps a fresh socket on foreground and replaces it after the stale deadline", async () => {
    const onDisconnect = vi.fn()
    await mount({ onMessage: vi.fn(), onDisconnect })
    const first = MockWebSocket.instances[0]!
    first.open()
    first.message({ type: "auth.ok" })
    const fetchCount = mockFetch.mock.calls.length

    mockWindow.dispatch("pageshow")
    mockWindow.dispatch("online")
    await flushPromises()
    expect(mockFetch).toHaveBeenCalledTimes(fetchCount)

    vi.setSystemTime(Date.now() + 31_000)
    mockWindow.dispatch("pageshow")
    await flushPromises()
    expect(first.closed).toBe(true)
    expect(onDisconnect).toHaveBeenCalledOnce()
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it("raw pong refreshes liveness while duplicate auth is consumed once", async () => {
    const onAuthenticated = vi.fn()
    const onFrameDropped = vi.fn()
    await mount({ onMessage: vi.fn(), onAuthenticated, onFrameDropped })
    const ws = MockWebSocket.instances[0]!
    ws.open()
    ws.message({ type: "auth.ok" })
    ws.message({ type: "auth.ok" })
    expect(onAuthenticated).toHaveBeenCalledOnce()
    expect(onFrameDropped).toHaveBeenCalledWith(expect.objectContaining({
      reason: "duplicate-auth-ok",
    }))

    await vi.advanceTimersByTimeAsync(29_000)
    ws.raw("pong")
    await vi.advanceTimersByTimeAsync(29_000)
    expect(ws.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(ws.closed).toBe(true)
  })

  it("send is open-only and cleanup cancels reconnect ownership", async () => {
    const { handle } = await mount({ onMessage: vi.fn() })
    const ws = MockWebSocket.instances[0]!
    handle.send({ type: "before.open" })
    expect(ws.sent).toEqual([])
    ws.open()
    handle.send({ type: "after.open" })
    expect(ws.sent).toContain(JSON.stringify({ type: "after.open" }))

    ws.close()
    const instanceCount = MockWebSocket.instances.length
    cleanupEffects()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(MockWebSocket.instances).toHaveLength(instanceCount)
  })

  it("isolates synchronous throws and async lifecycle rejections", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await mount({
      onMessage: () => { throw new Error("private message error") },
      onAuthenticated: () => { throw new Error("private auth error") },
      onDisconnect: () => Promise.reject(new Error("private disconnect error")),
    })
    const ws = MockWebSocket.instances[0]!
    ws.open()
    expect(() => ws.message({ type: "auth.ok" })).not.toThrow()
    expect(() => ws.message({ type: "safe.event" })).not.toThrow()
    expect(() => ws.message({ type: "unsafe event" })).not.toThrow()
    expect(() => ws.close()).not.toThrow()
    await flushPromises()

    expect(warn).toHaveBeenCalledWith(
      "[ws] lifecycle callback threw",
      { callback: "authenticated" },
    )
    expect(warn).toHaveBeenCalledWith(
      "[ws] lifecycle callback rejected",
      { callback: "disconnect" },
    )
    expect(warn).toHaveBeenCalledWith(
      "[ws] message callback threw",
      { type: "unknown" },
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private auth error")
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private message error")
  })
})
