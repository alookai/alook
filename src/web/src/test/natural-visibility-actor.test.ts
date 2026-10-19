import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserType } from "@playwright/test"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createNaturalVisibilityActor, type NaturalActorReceipt } from "./e2e-ui/_fixtures/natural-visibility-actor"
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }))
let root: string
let child: EventEmitter & { pid: number; stderr: EventEmitter }
let alive: boolean
let killed: (() => void) | undefined
let calls: string[]
let receipts: NaturalActorReceipt[]
const initialCookies = [{ name: "synthetic-session", value: "node-control-only", domain: "localhost", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax", partitionKey: "https://example.test" }]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "217-natural-actor-node-"))
  child = Object.assign(new EventEmitter(), { pid: 421217, stderr: new EventEmitter() })
  mocks.spawn.mockReset().mockReturnValue(child)
  alive = true; killed = undefined; calls = []; receipts = []
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    expect(pid).toBe(-child.pid)
    if (signal === 0) {
      if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" })
      return true
    }
    calls.push(String(signal)); alive = false
    queueMicrotask(() => { killed?.(); child.emit("close", 0, signal) })
    return true
  })
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
function setup(options: { connect?: Promise<unknown>; state?: Promise<void>; noContext?: boolean; closeError?: Error; registerError?: Error; initialState?: unknown; stateText?: string; missingFile?: boolean; cookieError?: Error } = {}) {
  let connected = true
  const page = { setViewportSize: vi.fn(async () => { calls.push("viewport") }) }
  const context = { addCookies: vi.fn(async () => { calls.push("initial-state"); await options.state; if (options.cookieError) throw options.cookieError }), pages: vi.fn(() => [page]) }
  const storageState = join(root, "initial-state.json")
  if (!options.missingFile) writeFileSync(storageState, options.stateText ?? JSON.stringify(options.initialState ?? { cookies: initialCookies, origins: [] }))
  const connection = { contexts: () => options.noContext ? [] : [context], isConnected: () => connected,
    close: vi.fn(async () => { calls.push("disconnect"); connected = false }) }
  const browserType = { name: () => "chromium", executablePath: () => "/owned/test-chromium",
    connectOverCDP: vi.fn(async () => { calls.push("connect"); if (options.connect) await options.connect; return connection }) }
  const resource = createNaturalVisibilityActor({ browserType: browserType as unknown as BrowserType, profileRoot: root,
    storageState, viewport: { width: 1280, height: 900 },
    registerContext: () => { if (options.registerError) throw options.registerError; calls.push("register") },
    closeContext: async () => { calls.push("close-context"); if (options.closeError) throw options.closeError },
    receipt: async receipt => { receipts.push(receipt) },
  })
  const endpoint = () => child.stderr.emit("data", Buffer.from("DevTools listening on ws://127.0.0.1:42121/devtools/browser/owned\n"))
  return { resource, browserType, context, connection, page, endpoint }
}
it("uses initial state in the default context and retires resources once", async () => {
  const h = setup(); h.endpoint(); await h.resource.ready
  expect(h.browserType.connectOverCDP).toHaveBeenCalledWith("ws://127.0.0.1:42121/devtools/browser/owned", { noDefaults: true })
  expect(h.context.addCookies).toHaveBeenCalledExactlyOnceWith(initialCookies)
  expect(h.context.addCookies.mock.invocationCallOrder[0]).toBeLessThan(h.context.pages.mock.invocationCallOrder[0]!)
  expect(h.page.setViewportSize).toHaveBeenCalledExactlyOnceWith({ width: 1280, height: 900 })
  await h.resource.close(); await h.resource.close()
  expect(calls).toEqual(["connect", "register", "initial-state", "viewport", "close-context", "disconnect", "SIGTERM"])
  expect(receipts).toHaveLength(1)
  expect(receipts[0]).toMatchObject({ processGroupReleased: true, profileRemoved: true, cleanupErrors: 0 })
  expect(existsSync(receipts[0]!.profile)).toBe(false)
})
it("cleans up a process which exits before publishing its endpoint", async () => {
  const h = setup(); alive = false; child.emit("close", 1, null)
  await expect(h.resource.ready).rejects.toThrow("closed before its debugging endpoint")
  await h.resource.close()
  expect(calls).toEqual([])
  expect(receipts[0]).toMatchObject({ processGroupReleased: true, profileRemoved: true, cleanupErrors: 0 })
})
it("retirement during connection never registers a late context", async () => {
  let reject!: (error: Error) => void
  const connect = new Promise((_, no) => { reject = no })
  const h = setup({ connect }); h.endpoint(); await Promise.resolve()
  killed = () => reject(new Error("Owned transport ended"))
  await h.resource.close()
  await expect(h.resource.ready).rejects.toThrow("Owned transport ended")
  expect(calls).toEqual(["connect", "SIGTERM"])
  expect(receipts[0]).toMatchObject({ processGroupReleased: true, profileRemoved: true })
})
it("retirement during state setup closes the registered owner and never opens its page", async () => {
  let reject!: (error: Error) => void
  const state = new Promise<void>((_, no) => { reject = no })
  const h = setup({ state }); h.endpoint()
  await vi.waitFor(() => expect(calls).toContain("initial-state"))
  killed = () => reject(new Error("Initial setup retired"))
  await h.resource.close()
  await expect(h.resource.ready).rejects.toThrow("Initial setup retired")
  expect(calls).not.toContain("viewport")
  expect(calls.indexOf("close-context")).toBeLessThan(calls.indexOf("SIGTERM"))
  expect(receipts[0]).toMatchObject({ processGroupReleased: true, profileRemoved: true })
})
it("keeps a context-close failure while still releasing its process and profile", async () => {
  const h = setup({ closeError: new Error("Trace flush failed") }); h.endpoint(); await h.resource.ready
  await expect(h.resource.close()).rejects.toThrow("Natural visibility actor cleanup failed")
  expect(receipts[0]).toMatchObject({ processGroupReleased: true, profileRemoved: true, cleanupErrors: 1 })
  expect(calls).toContain("SIGTERM")
})
it("does not report an unregistered context as owned when registration rejects", async () => {
  const h = setup({ registerError: new Error("Original case is exiting") }); h.endpoint()
  await expect(h.resource.ready).rejects.toThrow("Original case is exiting")
  await h.resource.close()
  expect(calls).not.toContain("close-context")
  expect(receipts[0]).toMatchObject({ processGroupReleased: true, profileRemoved: true, cleanupErrors: 0 })
})

it("waits for the single native cookie application before inspecting or publishing the page", async () => {
  let resolve!: () => void
  const state = new Promise<void>(yes => { resolve = yes })
  const h = setup({ state }); h.endpoint()
  let published = false
  void h.resource.ready.then(() => { published = true })
  await vi.waitFor(() => expect(h.context.addCookies).toHaveBeenCalledExactlyOnceWith(initialCookies))
  expect(h.context.pages).not.toHaveBeenCalled()
  expect(h.page.setViewportSize).not.toHaveBeenCalled()
  expect(published).toBe(false)
  resolve()
  const actor = await h.resource.ready
  expect(actor.page).toBe(h.page)
  expect(h.context.pages).toHaveBeenCalledOnce()
  expect(h.context.addCookies).toHaveBeenCalledExactlyOnceWith(initialCookies)
  await h.resource.close()
  expect(receipts[0]).toMatchObject({ processGroupReleased: true, profileRemoved: true, cleanupErrors: 0 })
})
it("passes an empty cookie list unchanged to the native setter once", async () => {
  const h = setup({ initialState: { cookies: [], origins: [] } }); h.endpoint(); await h.resource.ready
  expect(h.context.addCookies).toHaveBeenCalledExactlyOnceWith([])
  await h.resource.close()
})
it.each([
  ["local storage origin", { cookies: initialCookies, origins: [{ origin: "https://example.test", localStorage: [] }] }],
  ["empty credentials field", { cookies: initialCookies, origins: [], credentials: [] }],
  ["nonempty credentials field", { cookies: initialCookies, origins: [], credentials: [{ synthetic: true }] }],
  ["unknown field", { cookies: initialCookies, origins: [], extra: true }],
  ["missing cookies", { origins: [] }],
  ["missing origins", { cookies: initialCookies }],
  ["nonarray cookies", { cookies: {}, origins: [] }],
  ["nonarray origins", { cookies: initialCookies, origins: {} }],
  ["array root", []],
  ["string root", "invalid"],
])("rejects %s and closes the registered owner, connection, process and actual profile", async (_label, initialState) => {
  const h = setup({ initialState }); h.endpoint()
  await expect(h.resource.ready).rejects.toThrow("must contain only cookies and an empty origins array")
  expect(h.context.addCookies).not.toHaveBeenCalled()
  expect(h.context.pages).not.toHaveBeenCalled()
  await h.resource.close()
  expect(calls).toEqual(["connect", "register", "close-context", "disconnect", "SIGTERM"])
  expect(h.connection.close).toHaveBeenCalledOnce()
  expect(receipts).toHaveLength(1)
  expect(receipts[0]).toMatchObject({ processGroupReleased: true, profileRemoved: true, cleanupErrors: 0 })
  expect(existsSync(receipts[0]!.profile)).toBe(false)
})
it.each(["null", "42", "{invalid-json"])("rejects malformed state text %s and releases all owned resources", async stateText => {
  const h = setup({ stateText }); h.endpoint()
  await expect(h.resource.ready).rejects.toThrow()
  expect(h.context.addCookies).not.toHaveBeenCalled()
  expect(h.context.pages).not.toHaveBeenCalled()
  await h.resource.close()
  expect(calls).toEqual(["connect", "register", "close-context", "disconnect", "SIGTERM"])
  expect(receipts[0]).toMatchObject({ processGroupReleased: true, profileRemoved: true, cleanupErrors: 0 })
  expect(existsSync(receipts[0]!.profile)).toBe(false)
})
it("preserves a missing state file error and releases the registered owner's actual profile", async () => {
  const h = setup({ missingFile: true }); h.endpoint()
  await expect(h.resource.ready).rejects.toMatchObject({ code: "ENOENT" })
  expect(h.context.addCookies).not.toHaveBeenCalled()
  await h.resource.close()
  expect(calls).toEqual(["connect", "register", "close-context", "disconnect", "SIGTERM"])
  expect(receipts[0]).toMatchObject({ processGroupReleased: true, profileRemoved: true, cleanupErrors: 0 })
  expect(existsSync(receipts[0]!.profile)).toBe(false)
})
it("preserves native cookie validation failure without publishing a page, then releases ownership", async () => {
  const error = new Error("Native cookie validation rejected input")
  const h = setup({ cookieError: error }); h.endpoint()
  await expect(h.resource.ready).rejects.toBe(error)
  expect(h.context.addCookies).toHaveBeenCalledExactlyOnceWith(initialCookies)
  expect(h.context.pages).not.toHaveBeenCalled()
  await h.resource.close()
  expect(calls).toEqual(["connect", "register", "initial-state", "close-context", "disconnect", "SIGTERM"])
  expect(receipts[0]).toMatchObject({ processGroupReleased: true, profileRemoved: true, cleanupErrors: 0 })
  expect(existsSync(receipts[0]!.profile)).toBe(false)
})
