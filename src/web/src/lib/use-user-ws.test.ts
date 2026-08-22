import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  COMMUNITY_BROWSER_EVENT_BATCH_MAX_BYTES,
  type WsMessage,
} from "@alook/shared"
import type { UseUserWsOptions } from "./use-user-ws"

// --- Mock WebSocket ---
class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: MockWebSocket[] = []
  url: string
  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  sent: string[] = []

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }
  send(data: string) { this.sent.push(data) }
  close() { this.closed = true; this.readyState = MockWebSocket.CLOSED; this.onclose?.() }

  // Helpers for tests
  simulateOpen() { this.readyState = MockWebSocket.OPEN; this.onopen?.() }
  simulateMessage(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }) }
  simulateRawMessage(data: string) { this.onmessage?.({ data }) }
  simulateClose() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }
}

vi.stubGlobal("WebSocket", MockWebSocket)

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

const mockDocument = Object.assign(new MockEventTarget(), { visibilityState: "visible" })
const mockWindow = Object.assign(new MockEventTarget(), { location: { origin: "http://localhost:3000" } })
vi.stubGlobal("document", mockDocument)
vi.stubGlobal("window", mockWindow)

// Mock fetch for /api/ws/token
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// Mock process.env
vi.stubEnv("NODE_ENV", "development")
vi.stubEnv("NEXT_PUBLIC_WS_DO_PORT", "8789")

// --- Minimal React hooks mock ---
// We simulate React's useRef, useCallback, useEffect to test the hook logic directly
let effectCleanup: (() => void) | null = null
let refs: Map<string, { current: unknown }> = new Map()
let refCounter = 0
let callbackMemo: Map<string, { fn: Function; deps: unknown[] }> = new Map()
let callbackCounter = 0
let effectMemo: Map<string, {
  deps: unknown[]
  setup: () => (() => void) | void
  cleanup?: () => void
}> = new Map()
let effectCounter = 0
let latestHookResult: ReturnType<typeof import("./use-user-ws")["useUserWs"]> | null = null

function depsEqual(left: unknown[], right: unknown[]) {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}

vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const id = `ref-${refCounter++}`
    if (!refs.has(id)) {
      refs.set(id, { current: initial })
    }
    return refs.get(id)!
  },
  useCallback: (fn: Function, deps: unknown[]) => {
    const id = `cb-${callbackCounter++}`
    const existing = callbackMemo.get(id)
    if (existing && JSON.stringify(existing.deps) === JSON.stringify(deps)) {
      return existing.fn
    }
    callbackMemo.set(id, { fn, deps })
    return fn
  },
  useEffect: (fn: () => (() => void) | void, deps: unknown[]) => {
    const id = `effect-${effectCounter++}`
    const existing = effectMemo.get(id)
    if (existing && depsEqual(existing.deps, deps)) return
    const cleanup = fn()
    effectMemo.set(id, { deps, setup: fn, cleanup: cleanup || undefined })
    if (cleanup) effectCleanup = cleanup
  },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function replayEffects() {
  for (const effect of effectMemo.values()) effect.cleanup?.()
  for (const effect of effectMemo.values()) {
    const cleanup = effect.setup()
    effect.cleanup = cleanup || undefined
    if (cleanup) effectCleanup = cleanup
  }
}

function setupTokenFetch() {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ userId: "user-1", token: "tok-123" }),
  })
}

function resetMockState() {
  MockWebSocket.instances = []
  mockFetch.mockReset()
  effectCleanup = null
  refs = new Map()
  refCounter = 0
  callbackMemo = new Map()
  callbackCounter = 0
  effectMemo = new Map()
  effectCounter = 0
  latestHookResult = null
  mockDocument.visibilityState = "visible"
  mockDocument.reset()
  mockWindow.reset()
}

describe("useUserWs", () => {
  beforeEach(() => {
    resetMockState()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function mountHook(
    onMessage: (msg: WsMessage) => void,
    options?: UseUserWsOptions,
  ) {
    // Re-import to get fresh module with fresh mocks
    const mod = await import("./use-user-ws")
    latestHookResult = mod.useUserWs(onMessage, options)
    // Wait for async connect to complete
    await flushPromises()
    return mod
  }

  it("connect memo is stable — changing onMessage does NOT create a new connect reference", async () => {
    setupTokenFetch()

    const cb1 = vi.fn()
    const cb2 = vi.fn()

    // First mount
    const mod = await import("./use-user-ws")

    // Simulate first render
    resetMockState()
    setupTokenFetch()
    refCounter = 0
    callbackCounter = 0
    effectCounter = 0

    mod.useUserWs(cb1)
    const firstCallbackId = Array.from(callbackMemo.keys()).find(k => k.startsWith("cb-"))
    const firstConnect = callbackMemo.get(firstCallbackId!)?.fn

    // Simulate second render with different callback
    refCounter = 0
    callbackCounter = 0
    effectCounter = 0

    mod.useUserWs(cb2)
    const secondConnect = callbackMemo.get(firstCallbackId!)?.fn

    // connect should be the same reference since deps are []
    expect(firstConnect).toBe(secondConnect)
  })

  it.each<[string, UseUserWsOptions | undefined]>([
    ["the option is omitted", undefined],
    ["the option is explicitly true", { requestDaemonStatusOnAuth: true }],
  ])("auth.ok sends the complete daemon-status frame when %s", async (_label, options) => {
    setupTokenFetch()

    const onMsg = vi.fn()
    await mountHook(onMsg, options)

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    ws.simulateMessage({ type: "auth.ok" })

    expect(ws.sent).toEqual([
      JSON.stringify({ type: "auth", token: "tok-123" }),
      JSON.stringify({ type: "check_daemon_status" }),
    ])
    expect(onMsg).not.toHaveBeenCalled()
  })

  it("auth.ok suppresses daemon status and remains consumed when the option is false", async () => {
    setupTokenFetch()

    const onMsg = vi.fn()
    await mountHook(onMsg, { requestDaemonStatusOnAuth: false })

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    ws.simulateMessage({ type: "auth.ok" })

    expect(ws.sent).toEqual([
      JSON.stringify({ type: "auth", token: "tok-123" }),
    ])
    expect(onMsg).not.toHaveBeenCalled()
  })

  it("uses the web websocket route with the token response's local port", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ userId: "user-1", token: "tok-123", wsPort: 3000 }),
    } as Response)

    await mountHook(vi.fn(), { requestDaemonStatusOnAuth: false })

    expect(MockWebSocket.instances[0]?.url).toBe("ws://localhost:3000/api/ws/user?userId=user-1")
  })

  it("opens the access gate only after auth.ok", async () => {
    setupTokenFetch()

    const onAuthenticated = vi.fn()
    await mountHook(vi.fn(), { onAuthenticated, requestDaemonStatusOnAuth: false })

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    expect(onAuthenticated).not.toHaveBeenCalled()

    ws.simulateMessage({ type: "auth.ok" })
    expect(onAuthenticated).toHaveBeenCalledTimes(1)
  })

  it("does not reopen access when a stale socket delivers auth.ok after cleanup", async () => {
    setupTokenFetch()

    const onAuthenticated = vi.fn()
    await mountHook(vi.fn(), { onAuthenticated, requestDaemonStatusOnAuth: false })
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    effectCleanup?.()

    ws.simulateMessage({ type: "auth.ok" })

    expect(onAuthenticated).not.toHaveBeenCalled()
  })

  it("uses the latest option on the original socket without changing connect identity", async () => {
    setupTokenFetch()

    const onMsg = vi.fn()
    const mod = await mountHook(onMsg, { requestDaemonStatusOnAuth: false })
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    const firstConnect = callbackMemo.get("cb-1")?.fn

    refCounter = 0
    callbackCounter = 0
    effectCounter = 0
    mod.useUserWs(onMsg, { requestDaemonStatusOnAuth: true })
    const secondConnect = callbackMemo.get("cb-1")?.fn

    expect(secondConnect).toBe(firstConnect)
    expect(MockWebSocket.instances).toEqual([ws])

    ws.simulateMessage({ type: "auth.ok" })
    expect(ws.sent).toEqual([
      JSON.stringify({ type: "auth", token: "tok-123" }),
      JSON.stringify({ type: "check_daemon_status" }),
    ])
    expect(onMsg).not.toHaveBeenCalled()
  })

  it("effect cleanup nullifies wsRef.current and calls .close() — subsequent onclose skips reconnect", async () => {
    setupTokenFetch()

    const onMsg = vi.fn()
    await mountHook(onMsg)
    await flushPromises()

    const ws = MockWebSocket.instances[0]
    expect(ws).toBeDefined()

    // Run cleanup (simulates React unmount)
    effectCleanup?.()

    // The WebSocket should be closed
    expect(ws.closed).toBe(true)

    // No new connections should be created from the onclose handler
    const instanceCountBefore = MockWebSocket.instances.length
    // onclose was already called by .close() → but ownership check should skip reconnect
    await vi.advanceTimersByTimeAsync(5000)

    expect(MockWebSocket.instances.length).toBe(instanceCountBefore)
  })

  it("onMessageRef.current is updated — ws.onmessage dispatches to latest callback", async () => {
    setupTokenFetch()

    const cb1 = vi.fn()
    await mountHook(cb1)
    await flushPromises()

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    ws.simulateMessage({ type: "auth.ok" })

    // Deliver a message — should go to cb1
    ws.simulateMessage({ type: "test", data: "hello" })
    expect(cb1).toHaveBeenCalledWith({ type: "test", data: "hello" })

    // Now simulate a re-render with a new callback by updating the ref directly
    // In real React, the hook body runs `onMessageRef.current = onMessage` on each render
    const onMessageRef = Array.from(refs.values()).find(r =>
      typeof r.current === "function"
    )
    const cb2 = vi.fn()
    if (onMessageRef) onMessageRef.current = cb2

    ws.simulateMessage({ type: "test", data: "world" })
    expect(cb2).toHaveBeenCalledWith({ type: "test", data: "world" })
    expect(cb1).toHaveBeenCalledTimes(1) // cb1 not called again
  })

  it("server-initiated close (ws IS current) still triggers reconnect with backoff", async () => {
    setupTokenFetch()

    const onMsg = vi.fn()
    await mountHook(onMsg)
    await flushPromises()

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()

    const instancesBefore = MockWebSocket.instances.length

    // Simulate server-initiated close (ws is still current, not cleaned up by React)
    ws.onclose?.()

    // Advance past reconnect delay
    setupTokenFetch()
    await vi.advanceTimersByTimeAsync(2000)

    // A new connection should have been attempted
    expect(MockWebSocket.instances.length).toBeGreaterThan(instancesBefore)
  })

  it("publishes reconnecting, authenticated, and suspended lifecycle phases", async () => {
    setupTokenFetch()
    const onConnectionStateChange = vi.fn()
    await mountHook(vi.fn(), {
      onConnectionStateChange,
      requestDaemonStatusOnAuth: false,
    })
    const ws = MockWebSocket.instances[0]!

    expect(onConnectionStateChange).toHaveBeenLastCalledWith("reconnecting")
    ws.simulateOpen()
    ws.simulateMessage({ type: "auth.ok" })
    expect(onConnectionStateChange).toHaveBeenLastCalledWith("authenticated")

    mockDocument.visibilityState = "hidden"
    ws.simulateClose()
    expect(onConnectionStateChange).toHaveBeenLastCalledWith("suspended")
  })

  it("publishes suspended without fetching during a hidden cold start and resumes once visible", async () => {
    setupTokenFetch()
    mockDocument.visibilityState = "hidden"
    const onConnectionStateChange = vi.fn()

    await mountHook(vi.fn(), {
      onConnectionStateChange,
      requestDaemonStatusOnAuth: false,
    })
    expect(onConnectionStateChange).toHaveBeenLastCalledWith("suspended")
    expect(mockFetch).not.toHaveBeenCalled()

    mockDocument.dispatch("visibilitychange")
    expect(onConnectionStateChange).toHaveBeenLastCalledWith("suspended")
    expect(mockFetch).not.toHaveBeenCalled()

    mockDocument.visibilityState = "visible"
    mockDocument.dispatch("visibilitychange")
    await flushPromises()
    expect(mockFetch).toHaveBeenCalledOnce()
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it("manual reconnect retires the current socket and starts exactly one fresh generation", async () => {
    setupTokenFetch()
    const onAuthenticated = vi.fn()
    await mountHook(vi.fn(), {
      onAuthenticated,
      requestDaemonStatusOnAuth: false,
    })
    const first = MockWebSocket.instances[0]!
    first.simulateOpen()
    first.simulateMessage({ type: "auth.ok" })
    expect(onAuthenticated).toHaveBeenCalledOnce()

    latestHookResult!.reconnectNow()
    await flushPromises()

    expect(first.closed).toBe(true)
    expect(MockWebSocket.instances).toHaveLength(2)
    const replacement = MockWebSocket.instances[1]!
    first.simulateMessage({ type: "auth.ok" })
    expect(onAuthenticated).toHaveBeenCalledOnce()

    replacement.simulateOpen()
    replacement.simulateMessage({ type: "auth.ok" })
    expect(onAuthenticated).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it("manual reconnect invalidates an older pending token before it can create a socket", async () => {
    const firstTokenResponse = deferred<{
      ok: boolean
      json: () => Promise<{ userId: string; token: string }>
    }>()
    const secondTokenResponse = deferred<{
      ok: boolean
      json: () => Promise<{ userId: string; token: string }>
    }>()
    mockFetch
      .mockReturnValueOnce(firstTokenResponse.promise)
      .mockReturnValueOnce(secondTokenResponse.promise)

    await mountHook(vi.fn(), { requestDaemonStatusOnAuth: false })
    latestHookResult!.reconnectNow()
    expect(mockFetch).toHaveBeenCalledTimes(2)

    firstTokenResponse.resolve({
      ok: true,
      json: () => Promise.resolve({ userId: "stale-user", token: "stale-token" }),
    })
    await flushPromises()
    expect(MockWebSocket.instances).toHaveLength(0)

    secondTokenResponse.resolve({
      ok: true,
      json: () => Promise.resolve({ userId: "latest-user", token: "latest-token" }),
    })
    await flushPromises()
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0]?.url).toContain("latest-user")
  })

  it("manual reconnect clears a scheduled automatic retry before opening one replacement", async () => {
    setupTokenFetch()
    await mountHook(vi.fn(), { requestDaemonStatusOnAuth: false })
    const first = MockWebSocket.instances[0]!
    first.simulateOpen()
    first.simulateClose()

    latestHookResult!.reconnectNow()
    await flushPromises()
    expect(MockWebSocket.instances).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it("manual reconnect while hidden invalidates the generation and remains suspended", async () => {
    setupTokenFetch()
    const onConnectionStateChange = vi.fn()
    await mountHook(vi.fn(), {
      onConnectionStateChange,
      requestDaemonStatusOnAuth: false,
    })
    const first = MockWebSocket.instances[0]!
    first.simulateOpen()
    first.simulateMessage({ type: "auth.ok" })
    const fetchCount = mockFetch.mock.calls.length

    mockDocument.visibilityState = "hidden"
    onConnectionStateChange.mockClear()
    latestHookResult!.reconnectNow()

    expect(first.closed).toBe(true)
    expect(onConnectionStateChange).toHaveBeenLastCalledWith("suspended")
    expect(mockFetch).toHaveBeenCalledTimes(fetchCount)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(MockWebSocket.instances).toEqual([first])
  })

  it("passes an AbortSignal to the token fetch and aborts it at the hard timeout", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted")
        error.name = "AbortError"
        reject(error)
      })
    }))

    const mod = await import("./use-user-ws")
    mod.useUserWs(vi.fn())
    const signal = (mockFetch.mock.calls[0]?.[1] as RequestInit | undefined)?.signal

    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    await flushPromises()
    expect(signal?.aborted).toBe(true)

    effectCleanup?.()
  })

  it("suppresses reconnect while hidden and reconnects immediately when visible", async () => {
    setupTokenFetch()
    await mountHook(vi.fn(), { requestDaemonStatusOnAuth: false })
    const first = MockWebSocket.instances[0]!
    first.simulateOpen()
    first.simulateMessage({ type: "auth.ok" })

    mockDocument.visibilityState = "hidden"
    mockDocument.dispatch("visibilitychange")
    first.simulateClose()
    const fetchesWhileHidden = mockFetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockFetch).toHaveBeenCalledTimes(fetchesWhileHidden)

    mockDocument.visibilityState = "visible"
    mockDocument.dispatch("visibilitychange")
    await flushPromises()

    expect(mockFetch.mock.calls.length).toBe(fetchesWhileHidden + 1)
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it("keeps a fresh authenticated socket across pageshow and online", async () => {
    setupTokenFetch()
    await mountHook(vi.fn(), { requestDaemonStatusOnAuth: false })
    const ws = MockWebSocket.instances[0]!
    ws.simulateOpen()
    ws.simulateMessage({ type: "auth.ok" })
    const fetchCount = mockFetch.mock.calls.length

    mockWindow.dispatch("pageshow")
    mockWindow.dispatch("online")
    await flushPromises()

    expect(mockFetch).toHaveBeenCalledTimes(fetchCount)
    expect(MockWebSocket.instances).toEqual([ws])
    expect(ws.closed).toBe(false)
  })

  it("keeps cached UI ownership but replaces a stale authenticated socket on foreground", async () => {
    setupTokenFetch()
    const onDisconnect = vi.fn()
    await mountHook(vi.fn(), { onDisconnect, requestDaemonStatusOnAuth: false })
    const first = MockWebSocket.instances[0]!
    first.simulateOpen()
    first.simulateMessage({ type: "auth.ok" })

    vi.setSystemTime(Date.now() + 31_000)
    mockWindow.dispatch("pageshow")
    await flushPromises()

    expect(onDisconnect).toHaveBeenCalledTimes(1)
    expect(first.closed).toBe(true)
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it("coalesces visible, pageshow, and online while one replacement token request is pending", async () => {
    setupTokenFetch()
    await mountHook(vi.fn(), { requestDaemonStatusOnAuth: false })
    const first = MockWebSocket.instances[0]!
    first.simulateOpen()
    first.simulateMessage({ type: "auth.ok" })

    mockDocument.visibilityState = "hidden"
    mockDocument.dispatch("visibilitychange")
    first.simulateClose()

    const replacement = deferred<Response>()
    mockFetch.mockReturnValueOnce(replacement.promise)
    mockDocument.visibilityState = "visible"
    mockDocument.dispatch("visibilitychange")
    mockWindow.dispatch("pageshow")
    mockWindow.dispatch("online")

    expect(mockFetch).toHaveBeenCalledTimes(2)
    replacement.resolve({
      ok: true,
      json: () => Promise.resolve({ userId: "user-1", token: "tok-456" }),
    } as Response)
    await flushPromises()
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it("failed connect (fetch rejects) retries with backoff and cleanup prevents further reconnects", async () => {
    // All connects will fail
    mockFetch.mockRejectedValue(new Error("network error"))

    const onMsg = vi.fn()
    // Mount without runAllTimersAsync to avoid infinite reconnect loop
    const mod = await import("./use-user-ws")
    mod.useUserWs(onMsg)
    // Let initial connect resolve (microtask) + advance past one reconnect
    await vi.advanceTimersByTimeAsync(2000)

    // No WebSocket should have been created (fetch keeps failing)
    expect(MockWebSocket.instances.length).toBe(0)
    // Fetch was retried at least once via the reconnect timer
    expect(mockFetch.mock.calls.length).toBeGreaterThan(1)

    // Cleanup should clear the pending reconnect timer and not throw
    expect(() => effectCleanup?.()).not.toThrow()

    // After cleanup, no further reconnect attempts should happen
    const callsAfterCleanup = mockFetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockFetch.mock.calls.length).toBe(callsAfterCleanup)
  })

  it("send() delivers message when WS is open", async () => {
    setupTokenFetch()

    const onMsg = vi.fn()
    const mod = await import("./use-user-ws")
    const { send } = mod.useUserWs(onMsg)
    await flushPromises()

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()

    send({ type: "check_daemon_status" })
    expect(ws.sent).toContain(JSON.stringify({ type: "check_daemon_status" }))
  })

  it("send() is a no-op when WS is not connected", async () => {
    mockFetch.mockRejectedValue(new Error("network error"))

    const onMsg = vi.fn()
    const mod = await import("./use-user-ws")
    const { send } = mod.useUserWs(onMsg)
    await vi.advanceTimersByTimeAsync(100)

    // No WS created, send should not throw
    expect(() => send({ type: "test" })).not.toThrow()
    expect(MockWebSocket.instances.length).toBe(0)
  })

  it("effect cleanup clears pending reconnect timer", async () => {
    setupTokenFetch()

    const onMsg = vi.fn()
    await mountHook(onMsg)
    await flushPromises()

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()

    // Simulate server-initiated close — this schedules a reconnect timer
    // But we need to call onclose without triggering close() (which would also null wsRef)
    // Manually trigger the onclose handler
    const instancesBefore = MockWebSocket.instances.length
    ws.onclose?.()

    // Now immediately run cleanup (React unmounts before timer fires)
    effectCleanup?.()

    // Advance past all timers
    setupTokenFetch()
    await vi.advanceTimersByTimeAsync(60_000)

    // No new connection should have been created because the timer was cleared
    expect(MockWebSocket.instances.length).toBe(instancesBefore)
  })

  it("cleanup invalidates a pending successful token request before socket creation", async () => {
    const tokenResponse = deferred<{
      ok: boolean
      json: () => Promise<{ userId: string; token: string }>
    }>()
    mockFetch.mockReturnValue(tokenResponse.promise)

    const mod = await import("./use-user-ws")
    mod.useUserWs(vi.fn())
    expect(mockFetch).toHaveBeenCalledTimes(1)

    effectCleanup?.()
    tokenResponse.resolve({
      ok: true,
      json: () => Promise.resolve({ userId: "stale-user", token: "stale-token" }),
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(MockWebSocket.instances).toHaveLength(0)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("StrictMode replay keeps only the latest socket when token requests resolve out of order", async () => {
    const firstTokenResponse = deferred<{
      ok: boolean
      json: () => Promise<{ userId: string; token: string }>
    }>()
    const secondTokenResponse = deferred<{
      ok: boolean
      json: () => Promise<{ userId: string; token: string }>
    }>()
    mockFetch
      .mockReturnValueOnce(firstTokenResponse.promise)
      .mockReturnValueOnce(secondTokenResponse.promise)

    const mod = await import("./use-user-ws")
    mod.useUserWs(vi.fn())
    replayEffects()
    expect(mockFetch).toHaveBeenCalledTimes(2)

    secondTokenResponse.resolve({
      ok: true,
      json: () => Promise.resolve({ userId: "latest-user", token: "latest-token" }),
    })
    await flushPromises()
    firstTokenResponse.resolve({
      ok: true,
      json: () => Promise.resolve({ userId: "stale-user", token: "stale-token" }),
    })
    await flushPromises()

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0]?.url).toContain("latest-user")
  })

  it("cleanup invalidates a pending failed token request before reconnect scheduling", async () => {
    const tokenResponse = deferred<never>()
    mockFetch.mockReturnValue(tokenResponse.promise)

    const mod = await import("./use-user-ws")
    mod.useUserWs(vi.fn())
    expect(mockFetch).toHaveBeenCalledTimes(1)

    effectCleanup?.()
    tokenResponse.reject(new Error("stale token failure"))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(MockWebSocket.instances).toHaveLength(0)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("drops application frames until auth.ok commits the connection generation", async () => {
    setupTokenFetch()
    const onMessage = vi.fn()
    await mountHook(onMessage, { requestDaemonStatusOnAuth: false })
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()

    ws.simulateMessage({ type: "task.updated", taskId: "before" })
    expect(onMessage).not.toHaveBeenCalled()

    ws.simulateMessage({ type: "auth.ok" })
    ws.simulateMessage({ type: "task.updated", taskId: "after" })
    expect(onMessage).toHaveBeenCalledWith({ type: "task.updated", taskId: "after" })
  })

  it("does not report an access disconnect for a socket that never authenticated", async () => {
    setupTokenFetch()
    const onDisconnect = vi.fn()
    await mountHook(vi.fn(), { onDisconnect, requestDaemonStatusOnAuth: false })
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()

    ws.simulateClose()

    expect(onDisconnect).not.toHaveBeenCalled()
  })

  it("does not classify a replacement for an unauthenticated failed generation as reconnect", async () => {
    setupTokenFetch()
    const onReconnect = vi.fn()
    await mountHook(vi.fn(), { onReconnect, requestDaemonStatusOnAuth: false })
    const first = MockWebSocket.instances[0]
    first.simulateOpen()
    first.simulateClose()
    setupTokenFetch()
    await vi.advanceTimersByTimeAsync(2_000)
    const replacement = MockWebSocket.instances.at(-1)!
    replacement.simulateOpen()
    replacement.simulateMessage({ type: "auth.ok" })

    expect(onReconnect).not.toHaveBeenCalled()
  })

  it("drops malformed envelopes without logging frame contents and stays usable", async () => {
    setupTokenFetch()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const onMessage = vi.fn()
    await mountHook(onMessage, { requestDaemonStatusOnAuth: false })
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()

    ws.simulateRawMessage('{"sentinel-token":"private"')
    ws.simulateMessage(null)
    ws.simulateMessage([])
    ws.simulateMessage({})
    ws.simulateMessage({ type: "" })
    expect(onMessage).not.toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sentinel-token")
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private")

    ws.simulateMessage({ type: "auth.ok" })
    const valid = { type: "email.received", agentId: "agent-1" }
    ws.simulateMessage(valid)
    expect(onMessage).toHaveBeenCalledWith(valid)
  })

  it("consumes the raw pong liveness response without reporting a dropped frame", async () => {
    setupTokenFetch()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const onMessage = vi.fn()
    await mountHook(onMessage, { requestDaemonStatusOnAuth: false })
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    warn.mockClear()

    ws.simulateRawMessage("pong")

    expect(onMessage).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it("refreshes the liveness deadline when a raw pong arrives", async () => {
    setupTokenFetch()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await mountHook(vi.fn(), { requestDaemonStatusOnAuth: false })
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    ws.simulateMessage({ type: "auth.ok" })
    warn.mockClear()

    await vi.advanceTimersByTimeAsync(29_000)
    ws.simulateRawMessage("pong")
    await vi.advanceTimersByTimeAsync(29_000)

    expect(ws.closed).toBe(false)
    expect(warn).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(ws.closed).toBe(true)
  })

  it("consumes duplicate auth.ok frames once per generation", async () => {
    setupTokenFetch()
    const onAuthenticated = vi.fn()
    await mountHook(vi.fn(), { onAuthenticated, requestDaemonStatusOnAuth: false })
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()

    ws.simulateMessage({ type: "auth.ok" })
    ws.simulateMessage({ type: "auth.ok" })

    expect(onAuthenticated).toHaveBeenCalledTimes(1)
  })

  it("fires reconnect only after replacement authentication and passes gap duration", async () => {
    setupTokenFetch()
    const onReconnect = vi.fn()
    await mountHook(vi.fn(), { onReconnect, requestDaemonStatusOnAuth: false })
    const first = MockWebSocket.instances[0]
    first.simulateOpen()
    first.simulateMessage({ type: "auth.ok" })
    expect(onReconnect).not.toHaveBeenCalled()

    vi.setSystemTime(new Date("2026-08-11T08:00:00.000Z"))
    first.simulateClose()
    setupTokenFetch()
    await vi.advanceTimersByTimeAsync(2_000)
    const replacement = MockWebSocket.instances.at(-1)!
    replacement.simulateOpen()
    expect(onReconnect).not.toHaveBeenCalled()

    replacement.simulateMessage({ type: "auth.ok" })
    expect(onReconnect).toHaveBeenCalledTimes(1)
    expect(onReconnect).toHaveBeenCalledWith({ reconnectDurationMs: 2_000 })
  })

  it("commits auth before callbacks and preserves authenticated → reconnect → status order", async () => {
    setupTokenFetch()
    const trace: string[] = []
    const onMessage = vi.fn(() => trace.push("message"))
    const onAuthenticated = vi.fn(() => trace.push("authenticated"))
    const onReconnect = vi.fn(() => trace.push("reconnect"))
    await mountHook(onMessage, { onAuthenticated, onReconnect })
    const first = MockWebSocket.instances[0]
    first.simulateOpen()
    first.simulateMessage({ type: "auth.ok" })
    trace.length = 0
    first.simulateClose()
    setupTokenFetch()
    await vi.advanceTimersByTimeAsync(2_000)
    const replacement = MockWebSocket.instances.at(-1)!
    const originalSend = replacement.send.bind(replacement)
    replacement.send = (data: string) => {
      originalSend(data)
      if (data === JSON.stringify({ type: "check_daemon_status" })) trace.push("status")
    }
    replacement.simulateOpen()
    replacement.simulateMessage({ type: "auth.ok" })
    replacement.simulateMessage({ type: "task.updated", taskId: "after-auth" })

    expect(trace).toEqual(["authenticated", "reconnect", "status", "message"])
  })

  it("isolates synchronous throws and asynchronous rejections from lifecycle callbacks", async () => {
    setupTokenFetch()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const onAuthenticated = vi.fn(() => { throw new Error("secret sync error") })
    const onDisconnect = vi.fn(() => Promise.reject(new Error("secret async error")))
    const onReconnect = vi.fn(() => Promise.reject(new Error("secret reconnect error")))
    await mountHook(vi.fn(), {
      onAuthenticated,
      onDisconnect,
      onReconnect,
      requestDaemonStatusOnAuth: true,
    })
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()

    expect(() => ws.simulateMessage({ type: "auth.ok" })).not.toThrow()
    expect(ws.sent).toContain(JSON.stringify({ type: "check_daemon_status" }))
    expect(() => ws.simulateClose()).not.toThrow()
    setupTokenFetch()
    await vi.advanceTimersByTimeAsync(2_000)
    const replacement = MockWebSocket.instances.at(-1)!
    replacement.simulateOpen()
    expect(() => replacement.simulateMessage({ type: "auth.ok" })).not.toThrow()
    expect(replacement.sent).toContain(JSON.stringify({ type: "check_daemon_status" }))
    await flushPromises()
    expect(warn.mock.calls.flat()).not.toContain("secret sync error")
    expect(warn.mock.calls.flat()).not.toContain("secret async error")
    expect(warn.mock.calls.flat()).not.toContain("secret reconnect error")
  })

  it("caps community frames without imposing the cap on generic frames", async () => {
    setupTokenFetch()
    const onMessage = vi.fn()
    await mountHook(onMessage, { requestDaemonStatusOnAuth: false })
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    ws.simulateMessage({ type: "auth.ok" })

    const oversizedCommunity = JSON.stringify({
      type: "community:message.create",
      payload: "x".repeat(65_536),
    })
    ws.simulateRawMessage(oversizedCommunity)
    expect(onMessage).not.toHaveBeenCalled()

    const legalLargeBatch = {
      type: "community:events.batch",
      payload: "x".repeat(70_000),
    }
    ws.simulateMessage(legalLargeBatch)
    expect(onMessage).toHaveBeenCalledWith(legalLargeBatch)

    onMessage.mockClear()
    ws.simulateRawMessage(JSON.stringify({
      type: "community:events.batch",
      payload: "x".repeat(COMMUNITY_BROWSER_EVENT_BATCH_MAX_BYTES),
    }))
    expect(onMessage).not.toHaveBeenCalled()

    const generic = { type: "task.updated", payload: "x".repeat(65_536) }
    ws.simulateMessage(generic)
    expect(onMessage).toHaveBeenCalledWith(generic)
  })
})
