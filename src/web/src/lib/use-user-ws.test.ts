import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { WsMessage } from "@alook/shared"
import type { UseUserWsOptions } from "./use-user-ws"

// --- Mock WebSocket ---
class MockWebSocket {
  static instances: MockWebSocket[] = []
  url: string
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
  close() { this.closed = true; this.onclose?.() }

  // Helpers for tests
  simulateOpen() { this.onopen?.() }
  simulateMessage(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }) }
  simulateClose() { this.onclose?.() }
}

vi.stubGlobal("WebSocket", MockWebSocket)

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
    mod.useUserWs(onMessage, options)
    // Wait for async connect to complete
    await vi.runAllTimersAsync()
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
    await vi.runAllTimersAsync()

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
    await vi.runAllTimersAsync()

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()

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
    await vi.runAllTimersAsync()

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
    await vi.runAllTimersAsync()

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
    await vi.runAllTimersAsync()

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
})
