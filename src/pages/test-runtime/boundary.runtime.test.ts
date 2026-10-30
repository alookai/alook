import { createExecutionContext } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { drizzle } from "drizzle-orm/d1"
import { beforeEach, describe, expect, it, vi } from "vitest"
import driver from "../dev/driver"
import { ownership } from "../src/cloudflare"
import { dispatch } from "../src/dispatch"
import { PageManager } from "../src/index"
import { Registry } from "../src/registry"
import { pages } from "../src/schema"
import { config, manifest, upload } from "./fixtures"

beforeEach(async () => { await drizzle(env.REGISTRY).delete(pages) })

describe("public forwarding and loopback management driver", () => {
  it("cancels an oversized native multipart stream before any reservation", async () => {
    const manager = new PageManager(createExecutionContext(), { ...env, UPLOAD_MAX_BYTES: "10" })
    const response = await manager.create(upload())
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: "body_too_large" })
    expect(await drizzle(env.REGISTRY).select().from(pages)).toEqual([])
  })
  it("forwards the recorded release with current native ceilings and streams the response", async () => {
    const registry = new Registry(env.REGISTRY, config.namespace, config.account)
    const row = await registry.create("stream", "d", { cpuMs: 2000, subRequests: 3 })
    await registry.patch(row, { active: row.operation, phase: "ready", currentOp: null })
    const get = vi.fn<DispatchNamespace["get"]>(() => env.TEST_APPLICATION)
    const response = await dispatch(new Request("https://stream.alook.page/somewhere?q=yes", { method: "POST", body: "streamed bytes" }), { ...env, DISPATCHER: { get } })
    expect(get).toHaveBeenCalledWith(row.operation.target, {}, { limits: { cpuMs: 1000, subRequests: 3 } })
    expect(response.headers.get("x-test-application")).toBe("/somewhere")
    expect(await response.text()).toBe("streamed bytes")
    expect((await registry.get(row.id)).phase).toBe("ready")
    const unavailable = await dispatch(new Request("https://stream.alook.page/"), { ...env, DISPATCHER: { get: () => { throw new Error("private provider data") } } })
    expect(await unavailable.json()).toEqual({ error: "application_unavailable" })
    expect(await dispatch(new Request("https://stream.alook.page/"), { ...env, BASE_DOMAIN: "bad" }).then(response => response.json())).toEqual({ error: "invalid_operator_config" })
  })
  it("runs the actual management driver through the named private RPC binding", async () => {
    const bound = { MANAGER: exports.PageManager }
    const call = (path: string, method = "GET", body?: BodyInit) => driver.fetch(new Request(`http://127.0.0.1:8793${path}`, { method, body }), bound)
    expect((await driver.fetch(new Request("https://public.invalid/pages"), bound)).status).toBe(403)
    expect((await call("/unknown")).status).toBe(404)
    expect((await call("/pages", "GET")).status).toBe(404)
    expect((await call("/pages/bad")).status).toBe(404)
    expect((await call("/pages", "POST", "bad")).status).toBe(400)
    const registry = new Registry(env.REGISTRY, config.namespace, config.account)
    const row = await registry.create("driver", "d", config.limits)
    expect(await (await call(`/pages/${row.id}`)).json()).toMatchObject({ id: row.id })
    expect((await call(`/pages/${row.id}`, "PUT", "bad")).status).toBe(400)
    expect((await call(`/pages/${row.id}`, "DELETE")).status).toBe(409)
    expect((await call(`/pages/${row.id}/unknown`, "POST")).status).toBe(404)
    expect((await call(`/pages/${row.id}/recover`, "GET")).status).toBe(404)
    expect((await call(`/pages/${row.id}/limits`, "POST", "bad")).status).toBe(400)
    expect((await call(`/pages/${row.id}/limits`, "POST", "x".repeat(1025))).status).toBe(400)
    expect((await call(`/pages/${row.id}/limits`, "POST", JSON.stringify({ cpuMs: 10, subRequests: 1 }))).status).toBe(409)
    expect((await call(`/pages/${row.id}/recover`, "POST")).status).toBe(200)
    expect((await call(`/pages/${row.id}/limits`, "POST", JSON.stringify({ cpuMs: 10, subRequests: 1 }))).status).toBe(200)
    await registry.patch(await registry.get(row.id), { releases: [] })
    expect(await (await call(`/pages/${row.id}`, "DELETE")).json()).toEqual({ id: row.id, state: "deleted" })
    expect((await call(`/pages/${row.id}`)).status).toBe(404)
    expect((await call(`/pages/${row.id}`, "PATCH")).status).toBe(404)
  })
  it("preserves a native application WebSocket upgrade", async () => {
    const registry = new Registry(env.REGISTRY, config.namespace, config.account)
    const row = await registry.create("socket", "d", config.limits)
    await registry.patch(row, { active: row.operation, phase: "ready", currentOp: null })
    const response = await dispatch(new Request("https://socket.alook.page/", { headers: { upgrade: "websocket" } }), { ...env, DISPATCHER: { get: () => env.TEST_APPLICATION } })
    expect(response.status).toBe(101)
    const socket = response.webSocket
    if (!socket) throw new Error("missing upgrade")
    socket.accept()
    const closed = new Promise<void>(resolve => socket.addEventListener("close", () => resolve()))
    socket.close()
    await closed
  })
  it("qualifies the entrypoint publication probe with a native fetcher and controlled management API", async () => {
    const scripts = new Map<string, string[]>()
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const target = String(input).split("/").at(-1)!
      if (init?.method === "GET") return scripts.has(target) ? Response.json({ success: true, result: { script: { tags: scripts.get(target) } } }) : new Response(null, { status: 404 })
      if (init?.method === "PUT") {
        if (!(init.body instanceof FormData)) throw new Error("expected multipart")
        const part = init.body.get("metadata")
        if (!(part instanceof Blob)) throw new Error("expected metadata")
        const metadata = JSON.parse(await part.text())
        scripts.set(target, metadata.tags)
        return Response.json({ success: true, result: {} })
      }
      if (init?.method === "DELETE") { scripts.delete(target); return new Response(null, { status: 204 }) }
      throw new Error("unexpected operation")
    })
    try {
      const get = vi.fn<DispatchNamespace["get"]>(() => env.TEST_APPLICATION)
      const manager = new PageManager(createExecutionContext(), { ...env, PAGES_API_TOKEN: "control-only", DISPATCHER: { get } })
      const body = upload({ ...manifest("probe"), entry: { path: "main.mjs", format: "module" }, files: [{ role: "module", part: "code", path: "main.mjs", type: "application/javascript+module" }] }, { code: new Blob(["export default{}"] ) })
      const response = await manager.create(body)
      expect(response.status).toBe(200)
      const value = await response.json<{ id: string; state: string }>()
      expect(value.state).toBe("ready")
      const row = await new Registry(env.REGISTRY, config.namespace, config.account).get(value.id)
      expect(scripts.get(row.active!.target)).toEqual(ownership(row.id, row.active!))
      expect(get).toHaveBeenCalledWith(row.active!.target, {}, { limits: config.limits })
      expect(request).toHaveBeenCalledTimes(3)
    } finally { request.mockRestore() }
  })
})
