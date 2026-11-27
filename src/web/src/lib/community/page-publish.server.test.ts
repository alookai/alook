import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ owned: vi.fn(), binding: vi.fn(), resource: vi.fn(), create: vi.fn() }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: { ...actual.queries,
    communityAttachment: { getOwnedAttachmentById: (...args: unknown[]) => mocks.owned(...args) },
    communityPage: { pageBindingStatement: (...args: unknown[]) => mocks.binding(...args), getReadableResource: (...args: unknown[]) => mocks.resource(...args), createPage: (...args: unknown[]) => mocks.create(...args) },
  } }
})
import { preparePagePublication, registerPageArchive } from "./page-publish.server"
const host = vi.fn(async (request: Request) => Response.json({ artifactId: new URL(request.url).pathname.split("/").at(-1), type: "page", title: "My Page" }))
const media = vi.fn(async () => ({ body: new Blob(["archive"]).stream(), size: 7 }))
const env = { ALOOK_PAGE_ORIGIN: "https://pages.invalid", ALOOK_PAGE_SERVICE_KEY: "test-key-that-is-at-least-32-bytes", ALOOK_PAGE_HOST: { fetch: host }, COMMUNITY_MEDIA: { get: media } } as unknown as RuntimeEnv
beforeEach(() => { vi.clearAllMocks(); mocks.resource.mockResolvedValue(null); mocks.create.mockImplementation(async (_db, value) => value); mocks.owned.mockResolvedValue({ r2Key: "uploaded", contentType: "application/zip", size: 7 }); mocks.binding.mockReturnValue("binding") })
it("registers an owned archive independently and repeats registration without reimport or overwriting edits", async () => {
  const result = await registerPageArchive({} as never, env, "bot", "attachment")
  expect(result.ok).toBe(true)
  expect(mocks.owned).toHaveBeenCalledWith({}, "attachment", "bot")
  if (!result.ok) return
  expect(result.page).toEqual({ kind: "alook_page", id: expect.stringMatching(/^page_[0-9a-f]{32}$/), type: "page", title: "My Page" })
  expect(mocks.create).toHaveBeenCalledWith({}, expect.objectContaining({ id: result.page.id, archiveAttachmentId: "attachment", botId: "bot" }))
  expect(mocks.binding).not.toHaveBeenCalled()
  mocks.resource.mockResolvedValue({ ...result.page, botId: "bot" })
  expect(await registerPageArchive({} as never, env, "bot", "attachment")).toEqual(result)
  expect(host).toHaveBeenCalledOnce()
  expect(media).toHaveBeenCalledOnce()
  expect(host.mock.calls[0]![0].headers.get("x-alook-subject")).toBe("bot")
})
it("links an authorized reader's existing resource with no archive read or import", async () => {
  mocks.resource.mockResolvedValue({ id: "page_existing", artifactId: "art_live", botId: "original-bot", type: "docs", title: "Shared" })
  const result = await preparePagePublication({} as never, "forwarding-bot", "page_existing")
  expect(mocks.resource).toHaveBeenCalledWith({}, "page_existing", "forwarding-bot")
  expect(result.ok && JSON.parse(result.embeds)).toEqual([{ kind: "alook_page", id: "page_existing", type: "docs", title: "Shared" }])
  expect(result.ok && result.statements("new-message")).toEqual(["binding"])
  expect(mocks.binding).toHaveBeenCalledWith({}, { id: "page_existing", messageId: "new-message", authorId: "forwarding-bot" })
  expect(media).not.toHaveBeenCalled(); expect(host).not.toHaveBeenCalled()
  mocks.resource.mockResolvedValue(null)
  expect(await preparePagePublication({} as never, "outsider", "page_existing")).toMatchObject({ ok: false, status: 404 })
})
it("does not register when ownership or host publication fails", async () => {
  mocks.owned.mockResolvedValueOnce(null)
  expect(await registerPageArchive({} as never, env, "bot", "foreign")).toMatchObject({ ok: false, status: 400 })
  expect(host).not.toHaveBeenCalled()
  host.mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }))
  expect(await registerPageArchive({} as never, env, "bot", "attachment")).toMatchObject({ ok: false, status: 503 })
  expect(mocks.create).not.toHaveBeenCalled()
})
