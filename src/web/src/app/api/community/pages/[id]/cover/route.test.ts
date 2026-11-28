import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
const m = vi.hoisted(() => ({ actor: { kind: "bot", userId: "creator" }, readable: vi.fn(), own: vi.fn(), get: vi.fn(), put: vi.fn(), remove: vi.fn(), host: vi.fn() }))
const env = { DB: {}, COMMUNITY_MEDIA: { get: m.get, put: m.put, delete: m.remove }, ALOOK_PAGE_HOST: { fetch: m.host } }
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({}) }))
vi.mock("@/lib/middleware/auth", () => ({ humanAuthPolicy: { resolve: async () => ({ context: { userId: "reader", env } }) } }))
vi.mock("@/lib/middleware/community-actor", () => ({ communityActorPolicy: () => ({ resolve: async () => ({ context: { actor: m.actor, env } }) }), requireBot: (a: { kind: string }) => a.kind === "bot" ? { ok: true, bot: m.actor } : { ok: false, response: NextResponse.json({}, { status: 403 }) } }))
vi.mock("@alook/shared", async () => { const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared"); return { ...actual, queries: { ...actual.queries, communityPage: { getReadablePage: (...a: unknown[]) => m.readable(...a), getOwnedPage: (...a: unknown[]) => m.own(...a) } } } })
import { GET, PUT } from "./route"
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lqkAAAAASUVORK5CYII=", "base64")
const context = { params: Promise.resolve({ id: "page_cover" }) }
const read = (etag?: string, query = "?sourceMessageId=source") => new NextRequest(`https://alook.invalid/api/community/pages/page_cover/cover${query}`, { headers: etag ? { "if-none-match": etag } : {} })
const put = (data: Uint8Array = png, type = "image/png") => new NextRequest(read().url, { method: "PUT", headers: { "content-type": type }, body: new Uint8Array(data) })
beforeEach(() => { vi.clearAllMocks(); m.actor.kind = "bot"; m.readable.mockResolvedValue({ id: "page_cover" }); m.own.mockResolvedValue({ id: "page_cover" }); m.get.mockImplementation(async () => ({ body: new Response(png).body, customMetadata: { sha256: "revision" }, httpMetadata: { contentType: "image/png" } })) })
it("reads source-authorized R2 bytes with private revalidation and no host request", async () => {
 const result = await GET(read(), context)
 expect(m.readable).toHaveBeenCalledWith({}, "page_cover", "reader", "source"); expect(m.get).toHaveBeenCalledWith("page-covers/page_cover")
 expect(Buffer.from(await result.arrayBuffer())).toEqual(png); expect(result.headers.get("cache-control")).toBe("private, no-cache"); expect(result.headers.get("content-type")).toBe("image/png"); expect(result.headers.get("x-content-type-options")).toBe("nosniff"); expect(m.host).not.toHaveBeenCalled()
})
it("checks revocation before 304 and refuses inaccessible or missing covers", async () => {
 expect((await GET(read('W/"revision"'), context)).status).toBe(304)
 m.readable.mockResolvedValue(null); m.get.mockClear()
 expect((await GET(read('"revision"'), context)).status).toBe(404); expect(m.get).not.toHaveBeenCalled()
 expect((await GET(read(undefined, "?sourceMessageId=wrong"), context)).status).toBe(404)
 expect((await GET(read(undefined, "?unknown=x"), context)).status).toBe(400)
 m.readable.mockResolvedValue({ id: "page_cover" }); m.get.mockResolvedValue(null); expect((await GET(read(), context)).status).toBe(404)
})
it("stores creator raster bytes with stable content revisions and rejects other actors", async () => {
 const first = await (await PUT(put(), context)).json(); expect(await (await PUT(put(), context)).json()).toEqual(first)
 expect(first.etag).toMatch(/^"[a-f0-9]{64}"$/)
 expect(m.put).toHaveBeenCalledWith("page-covers/page_cover", new Uint8Array(png), { httpMetadata: { contentType: "image/png" }, customMetadata: { ownerId: "creator", sha256: first.etag.slice(1, -1) } })
 m.put.mockClear(); m.own.mockResolvedValue(null); expect((await PUT(put(), context)).status).toBe(404); expect(m.put).not.toHaveBeenCalled()
 m.actor.kind = "human"; expect((await PUT(put(), context)).status).toBe(403)
})
it("bounds streamed bytes and refuses scriptable, mislabeled and empty images", async () => {
 for (const [data, type] of [[new TextEncoder().encode("<svg/>"), "image/svg+xml"], [png, "image/jpeg"], [new Uint8Array(), "image/png"]] as const) expect((await PUT(put(data, type), context)).status).toBe(415)
 expect((await PUT(put(new Uint8Array(2 * 1024 * 1024 + 1)), context)).status).toBe(413); expect(m.put).not.toHaveBeenCalled()
})
it("cleans a cover uploaded concurrently with Page deletion", async () => {
 m.own.mockResolvedValueOnce({ id: "page_cover" }).mockResolvedValueOnce(null)
 expect((await PUT(put(), context)).status).toBe(404); expect(m.remove).toHaveBeenCalledWith("page-covers/page_cover")
 expect(m.put.mock.invocationCallOrder[0]).toBeLessThan(m.remove.mock.invocationCallOrder[0]!)
})
