import { afterEach, describe, expect, it, vi } from "vitest"
import { createNativeOauthController, nativeOauthBrowserDeps, type NativeOauthDeps, type NativeOauthSnapshot, type NativeOauthView } from "./native-oauth-client"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup() {
  let snapshot: NativeOauthSnapshot | null = null
  let pending: { attemptId: string; state: string; verifier: string; candidateId: string; code: string | null; status: string | null; wasDispatched: boolean }[] = []
  let ready = () => {}
  let count = 0
  const events: string[] = []
  const views: NativeOauthView[] = []
  const stop = vi.fn()
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    events.push(command)
    if (command === "native_oauth_snapshot") return snapshot && { ...snapshot }
    if (command === "native_oauth_prepare") {
      snapshot = { attemptId: `attempt_${String(++count).padStart(24, "0")}`, provider: args!.provider as "github" | "google", redirectPath: args!.redirectPath as string, expiresAt: Date.now() + 600_000, waiting: false }
      pending = []
      return { attemptId: snapshot.attemptId, provider: snapshot.provider, redirectPath: snapshot.redirectPath, platform: "macos", stateHash: "a".repeat(64), codeChallenge: "b".repeat(43), instanceKeyHash: "c".repeat(64) }
    }
    if (command === "native_oauth_open_start") { snapshot!.waiting = true; return }
    if (command === "native_oauth_pending_exchange") {
      if (!pending.length) return null
      const result = { ...pending[0] }; pending[0].wasDispatched = true; return result
    }
    if (command === "native_oauth_reject_candidate") { pending = pending.filter(c => c.candidateId !== args!.candidateId); return }
    if (command === "native_oauth_finish") { if (snapshot?.attemptId === args!.attemptId) { snapshot = null; pending = [] }; return }
    if (command === "native_oauth_cancel") {
      if (!snapshot || (args?.attemptId && snapshot.attemptId !== args.attemptId)) return null
      const proof = { attemptId: snapshot.attemptId, state: "s".repeat(43), verifier: "v".repeat(43) }
      snapshot = null; pending = []; return proof
    }
    throw new Error("unexpected command")
  })
  const post = vi.fn(async (endpoint: string): Promise<{ ok: boolean; data: unknown }> => {
    events.push(endpoint)
    if (endpoint === "attempt") return { ok: true, data: { startUrl: `https://alook.ai/auth/native/start?attempt=${snapshot!.attemptId}` } }
    if (endpoint === "exchange") return { ok: true, data: { redirectPath: "/c/me" } }
    if (endpoint === "status") return { ok: true, data: { status: "ready" } }
    return { ok: true, data: { status: "cancelled" } }
  })
  const listen = vi.fn(async (callback: () => void) => { events.push("listen"); ready = callback; return stop })
  const hasSession = vi.fn(async () => false)
  const navigate = vi.fn()
  const deps: NativeOauthDeps = { invoke: invoke as NativeOauthDeps["invoke"], post, listen, hasSession, navigate }
  const make = () => createNativeOauthController(deps, view => { views.push(view) })
  const controller = make()
  return { controller, make, deps, invoke, post, listen, stop, hasSession, navigate, events, views,
    view: () => views.at(-1)!, wake: () => ready(), snapshot: () => snapshot,
    queue: (code: string | null = "k".repeat(32), status: string | null = null, wasDispatched = false) => {
      pending.push({ attemptId: snapshot!.attemptId, candidateId: `candidate-${pending.length}`, state: "s".repeat(43), verifier: "v".repeat(43), code, status, wasDispatched })
    },
  }
}
const controllers: ReturnType<typeof createNativeOauthController>[] = []
function fixture() { const f = setup(); controllers.push(f.controller); return f }
afterEach(() => { for (const c of controllers.splice(0)) c.dispose(); vi.unstubAllGlobals(); vi.useRealTimers() })

 describe("native OAuth controller", () => {
  it("registers the listener before reading pending, opens only the registered start, and keeps proofs out of view state", async () => {
    const f = fixture(); await f.controller.connect(); await f.controller.start("github", "/c/me")
    expect(f.events.indexOf("listen")).toBeLessThan(f.events.indexOf("native_oauth_pending_exchange"))
    expect(f.events.indexOf("attempt")).toBeLessThan(f.events.indexOf("native_oauth_open_start"))
    expect(f.view().phase).toBe("waiting")
    f.queue(); f.wake(); f.wake()
    await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledWith("/c/me"))
    expect(f.post.mock.calls.filter(([endpoint]) => endpoint === "exchange")).toHaveLength(1)
    const text = JSON.stringify(f.views)
    expect(text).not.toContain("s".repeat(43)); expect(text).not.toContain("v".repeat(43)); expect(text).not.toContain("k".repeat(32))
    expect(f.invoke).toHaveBeenCalledWith("native_oauth_finish", expect.anything())
  })
  it("rejects only a forged candidate and processes a later real code after durable retirement", async () => {
    const f = fixture(); await f.controller.connect(); await f.controller.start("google", "/c/me")
    const normal = f.post.getMockImplementation()!
    let exchanges = 0
    f.post.mockImplementation(async endpoint => endpoint === "exchange" && ++exchanges === 1 ? { ok: false, data: { error: "invalid_handoff" } } : normal(endpoint))
    f.queue("x".repeat(32)); f.queue(); f.wake()
    await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledOnce())
    expect(f.events.indexOf("native_oauth_reject_candidate")).toBeLessThan(f.events.lastIndexOf("exchange"))
    expect(f.invoke.mock.calls.filter(([name]) => name === "native_oauth_reject_candidate")).toHaveLength(1)
  })
  it("retires a known-invalid code even with status offline, then exchanges a genuine callback after reload", async () => {
    const f = fixture(); await f.controller.connect(); await f.controller.start("google", "/c/me")
    const normal = f.post.getMockImplementation()!
    let exchanges = 0
    f.post.mockImplementation(async endpoint => {
      if (endpoint === "status") throw new Error("offline")
      if (endpoint === "exchange" && ++exchanges === 1) return { ok: false, data: { error: "invalid_handoff" } }
      return normal(endpoint)
    })
    const attempt = f.snapshot()?.attemptId
    f.queue("x".repeat(32)); f.wake()
    await vi.waitFor(() => expect(f.view().message).toBe("invalid_callback"))
    expect(f.snapshot()?.attemptId).toBe(attempt)
    expect(f.hasSession).not.toHaveBeenCalled()
    expect(f.post.mock.calls.some(([endpoint]) => endpoint === "status")).toBe(false)
    f.controller.dispose()
    const restored = f.make(); controllers.push(restored); await restored.connect()
    f.queue(); f.wake()
    await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledOnce())
    expect(exchanges).toBe(2)
    expect(f.invoke.mock.calls.filter(([command]) => command === "native_oauth_reject_candidate")).toHaveLength(1)
  })
  it("does not claim durable retirement or exchange later codes when native rejection fails", async () => {
    const f = fixture(); await f.controller.connect(); await f.controller.start("github", "/c/me")
    const original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation((command, args) => command === "native_oauth_reject_candidate" ? Promise.reject("store_unavailable") : original(command, args))
    f.post.mockResolvedValue({ ok: false, data: { error: "invalid_handoff" } })
    f.queue("x".repeat(32)); f.queue(); f.wake()
    await vi.waitFor(() => expect(f.view().message).toBe("retry_required"))
    expect(f.snapshot()).not.toBeNull()
    expect(f.navigate).not.toHaveBeenCalled()
    f.wake(); await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.post.mock.calls.filter(([endpoint]) => endpoint === "exchange")).toHaveLength(1)
  })
  it.each([false, true])("ignores an old rejection completion after cancel (replace=%s)", async replace => {
    const f = fixture(); await f.controller.connect(); await f.controller.start("github", "/c/me")
    const original = f.invoke.getMockImplementation()!
    const retired = deferred<void>()
    f.invoke.mockImplementation(async (command, args) => {
      const result = await original(command, args)
      if (command === "native_oauth_reject_candidate") await retired.promise
      return result
    })
    const normal = f.post.getMockImplementation()!
    f.post.mockImplementation(endpoint => endpoint === "exchange" ? Promise.resolve({ ok: false, data: { error: "invalid_handoff" } }) : normal(endpoint))
    f.queue(); f.wake()
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledWith("native_oauth_reject_candidate", expect.anything()))
    await f.controller.cancel()
    if (replace) await f.controller.start("google", "/c/me")
    retired.resolve(); await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.navigate).not.toHaveBeenCalled()
    expect(f.view().phase).toBe(replace ? "waiting" : "idle")
    expect(f.view().message).toBeUndefined()
    expect(f.snapshot()?.provider ?? null).toBe(replace ? "google" : null)
  })
  it("does not trust a status URL that disagrees with the proof-protected server", async () => {
    const f = fixture(); await f.controller.connect(); await f.controller.start("github", "/c/me")
    f.queue(null, "access_denied"); f.wake()
    await vi.waitFor(() => expect(f.view().message).toBe("invalid_callback"))
    expect(f.snapshot()).not.toBeNull()
    expect(f.invoke.mock.calls.some(([name]) => name === "native_oauth_finish")).toBe(false)
    f.post.mockResolvedValue({ ok: true, data: { status: "failed", failure: "access_denied" } })
    f.queue(null, "provider_error"); f.wake()
    await vi.waitFor(() => expect(f.view().message).toBe("denied"))
    expect(f.snapshot()).toBeNull()
  })
  it.each([true, false])("checks session after ambiguous exchange (session=%s) without replaying the code", async signedIn => {
    const f = fixture(); await f.controller.connect(); await f.controller.start("github", "/c/me")
    f.post.mockRejectedValue(new Error("network")); f.hasSession.mockResolvedValue(signedIn)
    f.queue(); f.wake()
    await vi.waitFor(() => expect(f.hasSession).toHaveBeenCalled())
    if (signedIn) await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledOnce())
    else await vi.waitFor(() => expect(f.view().message).toBe("retry_required"))
    f.wake(); await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.post.mock.calls.filter(([endpoint]) => endpoint === "exchange")).toHaveLength(1)
  })
  it("recovers a cold candidate after listener setup, and never replays an already-dispatched persisted code", async () => {
    const f = fixture(); await f.controller.connect(); await f.controller.start("github", "/c/me")
    f.queue("k".repeat(32), null, true); f.controller.dispose()
    const restored = f.make(); controllers.push(restored); await restored.connect()
    expect(f.hasSession).toHaveBeenCalledOnce()
    expect(f.post.mock.calls.some(([endpoint]) => endpoint === "exchange")).toBe(false)
    expect(f.view().message).toBe("retry_required")
  })
  it("clears natively before offline cancel, and prevents an old exchange from navigating a newer attempt", async () => {
    const f = fixture(); await f.controller.connect(); await f.controller.start("github", "/c/me")
    const exchange = deferred<{ ok: boolean; data: unknown }>()
    const normal = f.post.getMockImplementation()!
    f.post.mockImplementation(endpoint => endpoint === "exchange" ? exchange.promise : endpoint === "cancel" ? Promise.reject(new Error("offline")) : normal(endpoint))
    f.queue(); f.wake(); await vi.waitFor(() => expect(f.view().phase).toBe("exchanging"))
    await f.controller.cancel(); expect(f.snapshot()).toBeNull(); expect(f.view().phase).toBe("idle")
    await f.controller.start("google", "/c/me")
    exchange.resolve({ ok: true, data: { redirectPath: "/c/me" } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.navigate).not.toHaveBeenCalled(); expect(f.snapshot()?.provider).toBe("google")
  })
  it("serializes registrations so the newest queued attempt commits last", async () => {
    const f = fixture(); await f.controller.connect()
    const response = deferred<{ ok: boolean; data: unknown }>()
    f.post.mockReturnValueOnce(response.promise)
    const first = f.controller.start("github", "/c/me")
    await vi.waitFor(() => expect(f.post).toHaveBeenCalled())
    const second = f.controller.start("google", "/c/me")
    expect(f.invoke.mock.calls.filter(([command]) => command === "native_oauth_prepare")).toHaveLength(1)
    response.resolve({ ok: true, data: { startUrl: "old" } }); await first; await second
    expect(f.snapshot()?.provider).toBe("google")
    expect(f.invoke.mock.calls.filter(([command]) => command === "native_oauth_open_start")).toHaveLength(1)
  })
  it("fails closed on unavailable native bridge, registration failure and unsafe redirect", async () => {
    const f = fixture(); f.listen.mockRejectedValue(new Error("unknown command")); await f.controller.connect()
    expect(f.view().phase).toBe("unsupported"); await f.controller.start("github", "/c/me"); expect(f.post).not.toHaveBeenCalled()
    const g = fixture(); await g.controller.connect(); await g.controller.start("google", "//evil.test"); expect(g.post).not.toHaveBeenCalled()
    g.post.mockResolvedValue({ ok: false, data: { error: "rate_limited" } }); await g.controller.start("google", "/c/me")
    expect(g.view().message).toBe("start_failed"); expect(g.snapshot()).toBeNull()
    expect(g.invoke.mock.calls.some(([name]) => name === "native_oauth_open_start")).toBe(false)
  })
  it("checks an already-dispatched cold callback against a successful session", async () => {
    const f = fixture(); await f.controller.connect(); await f.controller.start("google", "/c/me")
    f.queue("k".repeat(32), null, true); f.controller.dispose(); f.hasSession.mockResolvedValue(true)
    const restored = f.make(); controllers.push(restored); await restored.connect()
    expect(f.navigate).toHaveBeenCalledWith("/c/me")
    expect(f.post.mock.calls.some(([endpoint]) => endpoint === "exchange")).toBe(false)
  })
  it("keeps persistence failure bounded without claiming cancellation or opening a browser", async () => {
    const f = fixture(); f.listen.mockRejectedValue("store_unavailable"); await f.controller.connect()
    expect(f.view().message).toBe("unavailable")
    const g = fixture(); await g.controller.connect(); await g.controller.start("github", "/c/me")
    const original = g.invoke.getMockImplementation()!
    g.invoke.mockImplementation((command, args) => command === "native_oauth_cancel" ? Promise.reject("store_unavailable") : original(command, args))
    await g.controller.cancel(); expect(g.view().message).toBe("unavailable"); expect(g.snapshot()).not.toBeNull()
  })
  it("fails closed on malformed native proof and does not send it to the server", async () => {
    const f = fixture(); await f.controller.connect(); await f.controller.start("google", "/c/me")
    const original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation((command, args) => command === "native_oauth_pending_exchange" ? Promise.resolve({ state: "malformed" }) : original(command, args))
    f.wake(); await vi.waitFor(() => expect(f.view().message).toBe("unavailable"))
    expect(f.post.mock.calls.some(([endpoint]) => endpoint === "exchange")).toBe(false)
  })
  it("recovers a candidate arriving during registration of the new document listener", async () => {
    const f = fixture(); await f.controller.connect(); await f.controller.start("google", "/c/me"); f.controller.dispose()
    f.listen.mockImplementation(async ready => { f.queue(); ready(); return f.stop })
    const restored = f.make(); controllers.push(restored); await restored.connect()
    expect(f.navigate).toHaveBeenCalledOnce()
    expect(f.post.mock.calls.filter(([endpoint]) => endpoint === "exchange")).toHaveLength(1)
  })
  it("retires a late subscription after disposal and expires waiting UI", async () => {
    const f = fixture(); const listen = deferred<() => void>(); f.listen.mockReturnValue(listen.promise)
    const connected = f.controller.connect(); f.controller.dispose(); listen.resolve(f.stop); await connected
    expect(f.stop).toHaveBeenCalledOnce(); expect(f.invoke).not.toHaveBeenCalled()
    vi.useFakeTimers(); const g = fixture(); await g.controller.connect(); await g.controller.start("github", "/c/me")
    await vi.advanceTimersByTimeAsync(600_000); expect(g.view().message).toBe("expired")
  })
})

describe("native browser adapter", () => {
  it("navigates with the verified local destination", () => {
    const assign = vi.fn(); vi.stubGlobal("window", { location: { assign } })
    nativeOauthBrowserDeps.navigate("/c/me"); expect(assign).toHaveBeenCalledWith("/c/me")
  })
  it("uses a payload-free Channel with registration-scoped cleanup, not event/deep-link listeners", async () => {
    const invoke = vi.fn().mockResolvedValue(7)
    class Channel { onmessage = () => {} }
    vi.stubGlobal("window", { __TAURI__: { core: { Channel, invoke } } })
    const ready = vi.fn(); const stop = await nativeOauthBrowserDeps.listen(ready)
    const channel = invoke.mock.calls[0][1].channel as Channel
    channel.onmessage(); expect(ready).toHaveBeenCalledOnce(); stop()
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["native_oauth_listen", "native_oauth_unlisten"])
    expect(invoke.mock.calls[1][1]).toEqual({ registrationId: 7 })
  })
  it("posts proofs only to same-origin JSON and confirms ordinary session without exposing tokens", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ session: { id: "normal-session" } })))
    vi.stubGlobal("fetch", fetcher)
    expect(await nativeOauthBrowserDeps.hasSession()).toBe(true)
    expect(fetcher.mock.calls[0][0]).toBe("/api/auth/get-session?disableCookieCache=true")
    fetcher.mockResolvedValue(new Response(JSON.stringify({ status: "cancelled" })))
    await nativeOauthBrowserDeps.post("cancel", { attemptId: "id", state: "proof", verifier: "pkce" })
    expect(fetcher.mock.calls[1][1]).toMatchObject({ credentials: "same-origin", cache: "no-store", method: "POST", headers: { "Content-Type": "application/json" } })
  })
})
