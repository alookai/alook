import { describe, expect, it, vi } from "vitest"
import { createSessionTransport } from "./session-transport"
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const origin = "https://alook.test"
describe("session transport sign-out ordering", () => {
  it("drains actual headers even when a query consumer has already cancelled", async () => {
    const response = deferred<Response>()
    const native = vi.fn<typeof fetch>().mockReturnValue(response.promise)
    const transport = createSessionTransport(native, origin)
    const controller = new AbortController()
    const consumer = transport.fetch("/api/community/friends/pending", { signal: controller.signal })
    controller.abort()
    await expect(consumer).rejects.toMatchObject({ name: "AbortError" })
    expect(native.mock.calls[0][1]?.signal?.aborted).toBe(false)
    const lease = transport.beginSignOut(() => {})
    let drained = false
    const drain = lease.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    response.resolve(new Response("{}"))
    await drain
    expect(drained).toBe(true)
    lease.release()
  })
  it("blocks business, SDK, WS and raw requests but admits only the owner's cleanup", async () => {
    const native = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"))
    const transport = createSessionTransport(native, origin)
    const lease = transport.beginSignOut(() => {})
    for (const path of ["/api/community/friends/pending", "/api/auth/get-session", "/api/ws/token", "/api/community/notifications/devices"]) {
      await expect(transport.fetch(path)).rejects.toMatchObject({ name: "AbortError" })
    }
    expect(native).not.toHaveBeenCalled()
    await lease.drain()
    await lease.fetch("/api/auth/sign-out", { method: "POST" })
    expect(native).toHaveBeenCalledTimes(1)
    lease.release()
    await transport.fetch("/api/auth/get-session")
    expect(native).toHaveBeenCalledTimes(2)
  })
  it("does not cancel accepted mutations when sign-out begins", async () => {
    const response = deferred<Response>()
    const transport = createSessionTransport(() => response.promise, origin)
    const mutation = transport.fetch("/api/community/messages", { method: "POST", body: "accepted" })
    const lease = transport.beginSignOut(() => {})
    const drain = lease.drain()
    response.resolve(new Response("accepted"))
    expect(await (await mutation).text()).toBe("accepted")
    await drain
    lease.release()
  })
  it("keeps cancellation after headers connected to the response body", async () => {
    const native = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"))
    const transport = createSessionTransport(native, origin)
    const controller = new AbortController()
    await transport.fetch("/api/auth/get-session", { signal: controller.signal })
    controller.abort()
    expect(native.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })
  it("does not admit stale cleanup or let an old release unlock another logout", async () => {
    let current = true
    const native = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"))
    const transport = createSessionTransport(native, origin)
    const lease = transport.beginSignOut(() => { if (!current) throw new DOMException("Old account", "AbortError") })
    expect(() => transport.beginSignOut(() => {})).toThrow()
    current = false
    await expect(lease.drain()).rejects.toMatchObject({ name: "AbortError" })
    expect(() => lease.fetch("/api/auth/sign-out")).toThrow()
    lease.release()
    const replacement = transport.beginSignOut(() => {})
    lease.release()
    await expect(transport.fetch("/api/auth/get-session")).rejects.toMatchObject({ name: "AbortError" })
    replacement.release()
  })
  it("leaves external and credential-omitting requests alone", async () => {
    const native = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"))
    const transport = createSessionTransport(native, origin)
    const lease = transport.beginSignOut(() => {})
    const controller = new AbortController()
    await transport.fetch("https://other.test/image", { signal: controller.signal })
    await transport.fetch("/public", { credentials: "omit", signal: controller.signal })
    expect(native.mock.calls.map(call => call[1]?.signal)).toEqual([controller.signal, controller.signal])
    lease.release()
  })
  it("a failed drain does not pretend that the pending transport finished", async () => {
    const response = deferred<Response>()
    const transport = createSessionTransport(() => response.promise, origin)
    const consumer = transport.fetch("/api/auth/get-session")
    const lease = transport.beginSignOut(() => {})
    const controller = new AbortController()
    const drain = lease.drain(controller.signal)
    const rejection = expect(drain).rejects.toMatchObject({ name: "AbortError" })
    controller.abort()
    await rejection
    lease.release()
    const retry = transport.beginSignOut(() => {})
    let drained = false
    const retryDrain = retry.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    response.resolve(new Response("{}"))
    await Promise.all([consumer, retryDrain])
    retry.release()
  })
  it("preserves a login intent until logout headers have settled", async () => {
    const logout = deferred<Response>()
    const native = vi.fn<typeof fetch>().mockImplementation(input =>
      String(input).endsWith("sign-out") ? logout.promise : Promise.resolve(Response.json({ user: "B" })))
    const transport = createSessionTransport(native, origin)
    const lease = transport.beginSignOut(() => {})
    const exiting = lease.fetch("/api/auth/sign-out", { method: "POST" })
    const login = transport.fetch("/api/auth/sign-in/email", { method: "POST", body: "B intent" })
    expect(transport.identityGeneration()).toBe(1)
    expect(native).toHaveBeenCalledTimes(1)
    lease.release()
    await Promise.resolve()
    expect(native).toHaveBeenCalledTimes(1)
    logout.resolve(Response.json({ success: true }))
    await exiting
    expect(await (await login).json()).toEqual({ user: "B" })
    expect(native.mock.calls[1][1]?.body).toBe("B intent")
  })

  it("honors cancellation of a queued login without sending it later", async () => {
    const native = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}))
    const transport = createSessionTransport(native, origin)
    const lease = transport.beginSignOut(() => {})
    const controller = new AbortController()
    const login = transport.fetch("/api/auth/sign-in/email-otp", { method: "POST", signal: controller.signal })
    controller.abort()
    await expect(login).rejects.toMatchObject({ name: "AbortError" })
    lease.release()
    await Promise.resolve()
    expect(native).not.toHaveBeenCalled()
  })

  it("does not pause public same-origin resources", async () => {
    const native = vi.fn<typeof fetch>().mockResolvedValue(new Response("public"))
    const transport = createSessionTransport(native, origin)
    const lease = transport.beginSignOut(() => {})
    const controller = new AbortController()
    await transport.fetch("/images/logo.svg", { signal: controller.signal })
    expect(native.mock.calls[0][1]?.signal).toBe(controller.signal)
    lease.release()
  })

  it("a cancelled login still fences session checks until its real cookie response arrives", async () => {
    const response = deferred<Response>()
    const native = vi.fn<typeof fetch>().mockImplementation(input =>
      String(input).endsWith("sign-in/email") ? response.promise : Promise.resolve(Response.json({ user: "B" })))
    const transport = createSessionTransport(native, origin)
    const controller = new AbortController()
    const login = transport.fetch("/api/auth/sign-in/email", { method: "POST", signal: controller.signal })
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(1))
    controller.abort()
    await expect(login).rejects.toMatchObject({ name: "AbortError" })
    const session = transport.fetch("/api/auth/get-session")
    await Promise.resolve()
    expect(native).toHaveBeenCalledTimes(1)
    response.resolve(Response.json({ success: true }))
    expect(await (await session).json()).toEqual({ user: "B" })
    expect(native).toHaveBeenCalledTimes(2)
  })

  it("does not start an old-account logout over an already accepted identity request", async () => {
    const response = deferred<Response>()
    const transport = createSessionTransport(() => response.promise, origin)
    const login = transport.fetch("/api/auth/sign-in/email", { method: "POST" })
    expect(() => transport.beginSignOut(() => {})).toThrow()
    response.resolve(Response.json({ user: "B" }))
    await login
    transport.beginSignOut(() => {}).release()
  })

  it("drains a recovery response before a later login and fences new reads and writes", async () => {
    const old = deferred<Response>(), loginResponse = deferred<Response>()
    const native = vi.fn<typeof fetch>().mockImplementation(input => String(input).includes("get-session") ? old.promise : String(input).includes("sign-in") ? loginResponse.promise : Promise.resolve(Response.json({ fresh: true })))
    const transport = createSessionTransport(native, origin)
    const recovery = transport.fetch("/api/auth/get-session")
    const login = transport.fetch("/api/auth/sign-in/email", { method: "POST" })
    const pageRead = transport.fetch("/api/community/users/me/read-state")
    await expect(transport.fetch("/api/community/messages", { method: "POST", body: "A intent" })).rejects.toMatchObject({ name: "AbortError" })
    expect(native).toHaveBeenCalledTimes(1)
    old.resolve(Response.json({ user: "A" }))
    await recovery
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(2))
    expect(native.mock.calls[1][0]).toBe("/api/auth/sign-in/email")
    loginResponse.resolve(Response.json({ user: "B" }))
    await login
    expect(await (await pageRead).json()).toEqual({ fresh: true })
    expect(native.mock.calls[2][0]).toBe("/api/community/users/me/read-state")
  })

  it("resumes waiting reads after a failed identity and cancels a waiting read promptly", async () => {
    const response = deferred<Response>()
    const native = vi.fn<typeof fetch>().mockImplementation(input => String(input).includes("sign-in") ? response.promise : Promise.resolve(Response.json({ user: "A" })))
    const transport = createSessionTransport(native, origin), controller = new AbortController()
    const login = transport.fetch("/api/auth/sign-in/email", { method: "POST" })
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(1))
    const canceled = transport.fetch("/api/community/servers", { signal: controller.signal })
    controller.abort()
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" })
    const reader = transport.fetch("/api/community/users/me/attention")
    response.resolve(Response.json({ error: "bad credentials" }, { status: 401 }))
    await login
    expect(await (await reader).json()).toEqual({ user: "A" })
    expect(native).toHaveBeenCalledTimes(2)
  })

})
