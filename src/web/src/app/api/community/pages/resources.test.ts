import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
const mocks = vi.hoisted(() => ({ actor: { kind: "bot", userId: "creator" }, list: vi.fn(), own: vi.fn(), remove: vi.fn(), register: vi.fn(), fetch: vi.fn(), coverDelete: vi.fn(), coverHead: vi.fn(), env: { DB: {}, ALOOK_PAGE_ORIGIN: "https://pages.invalid", ALOOK_PAGE_SERVICE_KEY: "test-secret-at-least-32-characters", ALOOK_PAGE_HOST: {}, COMMUNITY_MEDIA: {} } }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({}) }))
vi.mock("@/lib/middleware/community-actor", () => ({
  communityActorPolicy: () => ({ resolve: async () => ({ context: { actor: mocks.actor, env: mocks.env } }) }),
  requireBot: (actor: { kind: string }) => actor.kind === "bot" ? { ok: true, bot: mocks.actor } : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) },
}))
vi.mock("@/lib/community/page-publish.server", () => ({ registerPageArchive: (...args: unknown[]) => mocks.register(...args) }))
vi.mock("@alook/shared", async () => { const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared"); return { ...actual, queries: { ...actual.queries, communityPage: { listOwnedPages: (...args: unknown[]) => mocks.list(...args), getOwnedPage: (...args: unknown[]) => mocks.own(...args), deleteOwnedPage: (...args: unknown[]) => mocks.remove(...args) } } } })
import { GET, POST } from "./route"
import { DELETE } from "./[id]/route"
const context = { params: Promise.resolve({ id: "page_resource" }) }
const request = (query = "") => new NextRequest(`https://alook.invalid/api/community/pages${query}`)
beforeEach(() => { vi.clearAllMocks(); mocks.actor.kind = "bot"; mocks.coverDelete.mockReset(); mocks.coverHead.mockReset(); mocks.env.COMMUNITY_MEDIA = { delete: mocks.coverDelete, head: mocks.coverHead }; mocks.env.ALOOK_PAGE_HOST = { fetch: mocks.fetch }; mocks.list.mockResolvedValue({ total: 2, pages: [], nextCursor: { createdAt: "now", id: "page_last" } }); mocks.own.mockResolvedValue({ id: "page_resource", artifactId: "art_resource12345" }); mocks.fetch.mockResolvedValue(Response.json({ deleted: true })); mocks.remove.mockResolvedValue({ id: "page_resource" }); mocks.register.mockResolvedValue({ ok: true, page: { id: "page_resource" } }) })
it("lists only the authenticated bot's own resources and round-trips bounded opaque cursors", async () => {
  const result = await (await GET(request(), context)).json()
  expect(result.total).toBe(2)
  expect(mocks.list).toHaveBeenCalledWith({}, "creator", { limit: 50, cursor: undefined })
  await GET(request(`?limit=100&cursor=${result.nextCursor}`), context)
  expect(mocks.list).toHaveBeenLastCalledWith({}, "creator", { limit: 100, cursor: { createdAt: "now", id: "page_last" } })
  for (const query of ["?limit=101", "?limit=0", "?cursor=bad", "?botId=other"]) expect((await GET(request(query), context)).status).toBe(400)
  mocks.actor.kind = "human"; expect((await GET(request(), context)).status).toBe(403)
})
it("registers an archive using the bot credential and refuses caller-selected ownership", async () => {
  const post = (body: unknown) => new NextRequest(request().url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  expect((await POST(post({ archiveAttachmentId: "archive" }), context)).status).toBe(201)
  expect(mocks.register).toHaveBeenCalledWith({}, mocks.env, "creator", "archive")
  expect((await POST(post({ archiveAttachmentId: "archive", botId: "other" }), context)).status).toBe(400)
})
it("refuses reader deletion before contacting the host and retains retry authority on cloud failure", async () => {
  mocks.own.mockResolvedValueOnce(null)
  expect((await DELETE(request(), context)).status).toBe(404)
  expect(mocks.fetch).not.toHaveBeenCalled()
  mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }))
  expect((await DELETE(request(), context)).status).toBe(503)
  expect(mocks.remove).not.toHaveBeenCalled()
})
it("removes database associations only after successful cloud destruction", async () => {
  expect(await (await DELETE(request(), context)).json()).toEqual({ deleted: true })
  expect(mocks.own).toHaveBeenCalledWith({}, "page_resource", "creator")
  expect(mocks.remove).toHaveBeenCalledWith({}, "page_resource", "creator")
  expect(mocks.fetch.mock.invocationCallOrder[0]).toBeLessThan(mocks.remove.mock.invocationCallOrder[0]!)
  const forwarded = mocks.fetch.mock.calls[0]![0] as Request
  expect(forwarded.method).toBe("DELETE"); expect(forwarded.url).toBe("https://pages.invalid/alook/resources/art_resource12345")
  expect(forwarded.headers.get("x-alook-subject")).toBe("creator")
})

it("keeps database retry authority when cover cleanup fails", async () => {
 mocks.coverDelete.mockRejectedValueOnce(new Error("R2 unavailable"))
 expect((await DELETE(request(), context)).status).toBe(503); expect(mocks.remove).not.toHaveBeenCalled()
})
it("cleans concurrent cover writes after database removal and allows creator-only cleanup retries", async () => {
 expect((await DELETE(request(), context)).status).toBe(200); expect(mocks.coverDelete).toHaveBeenCalledTimes(2)
 expect(mocks.coverDelete.mock.invocationCallOrder[0]).toBeLessThan(mocks.remove.mock.invocationCallOrder[0]!)
 expect(mocks.remove.mock.invocationCallOrder[0]).toBeLessThan(mocks.coverDelete.mock.invocationCallOrder[1]!)
 mocks.own.mockResolvedValue(null); mocks.coverHead.mockResolvedValue({ customMetadata: { ownerId: "creator" } })
 expect((await DELETE(request(), context)).status).toBe(200)
 mocks.coverHead.mockResolvedValue({ customMetadata: { ownerId: "other" } }); mocks.coverDelete.mockClear()
 expect((await DELETE(request(), context)).status).toBe(404); expect(mocks.coverDelete).not.toHaveBeenCalled()
})
