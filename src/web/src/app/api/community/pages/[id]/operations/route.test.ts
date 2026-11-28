import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
const mocks = vi.hoisted(() => ({ actor: { kind: "bot", userId: "bot" }, published: vi.fn(), communicate: vi.fn(), fetch: vi.fn(), env: { DB: {}, ALOOK_PAGE_ORIGIN: "https://pages.invalid", ALOOK_PAGE_SERVICE_KEY: "test-secret-at-least-32-characters", ALOOK_PAGE_HOST: {} } }))
vi.mock("@/lib/community/page-access.server", () => ({ pageAccessRole: (...args: unknown[]) => mocks.communicate(...args) }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({}) }))
vi.mock("@/lib/middleware/community-actor", () => ({
  communityActorPolicy: () => ({ resolve: async () => ({ context: { actor: mocks.actor, env: mocks.env } }) }),
  requireBot: (actor: { kind: string }) => actor.kind === "bot" ? { ok: true, bot: mocks.actor } : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) },
}))
vi.mock("@alook/shared", async () => { const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared"); return { ...actual, queries: { ...actual.queries, communityPage: { getPublishedPage: (...args: unknown[]) => mocks.published(...args) } } } })
import { POST } from "./route"
const context = { params: Promise.resolve({ id: "page" }) }
const request = (body: unknown) => new NextRequest("https://alook.invalid/api/community/pages/page/operations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
beforeEach(() => { vi.clearAllMocks(); mocks.actor.kind = "bot"; mocks.env.ALOOK_PAGE_HOST = { fetch: mocks.fetch }; mocks.communicate.mockResolvedValue("editor"); mocks.published.mockResolvedValue({ channelId: "source-channel", artifactId: "art_native1234567890" }); mocks.fetch.mockImplementation(async () => Response.json({ files: {} })) })
it("resolves the publishing bot and live source access before calling the Page host", async () => {
  expect((await POST(request({ kind: "manifest" }), context)).status).toBe(200)
  expect(mocks.published).toHaveBeenCalledWith({}, "page", "bot")
  const forwarded = mocks.fetch.mock.calls[0]![0] as Request
  expect(forwarded.url).toBe("https://pages.invalid/alook/operate/art_native1234567890")
  expect(forwarded.headers.get("x-alook-subject")).toBe("bot")
  mocks.published.mockResolvedValue(null)
  expect((await POST(request({ kind: "manifest" }), context)).status).toBe(404)
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})
it("refuses human callers and unconditional writes without contacting the host", async () => {
  mocks.actor.kind = "human"
  expect((await POST(request({ kind: "manifest" }), context)).status).toBe(403)
  mocks.actor.kind = "bot"
  expect((await POST(request({ kind: "write", writes: [{ path: "index.html", content: "YQ==" }] }), context)).status).toBe(400)
  expect(mocks.fetch).not.toHaveBeenCalled()
})

it("does not let a publisher write after source communication access is revoked", async () => {
  mocks.communicate.mockResolvedValue("viewer")
  expect((await POST(request({ kind: "write", writes: [{ path: "index.html", content: "YQ==", if_match: "etag" }] }), context)).status).toBe(403)
  expect(mocks.communicate).toHaveBeenCalledWith({}, "art_native1234567890", "bot")
  expect(mocks.fetch).not.toHaveBeenCalled()
})
