import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ owned: vi.fn(), binding: vi.fn() }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: { ...actual.queries,
    communityAttachment: { getOwnedAttachmentById: (...args: unknown[]) => mocks.owned(...args) },
    communityPage: { pageBindingStatement: (...args: unknown[]) => mocks.binding(...args) },
  } }
})
import { preparePagePublication } from "./page-publish.server"
const host = vi.fn(async (request: Request) => Response.json({ artifactId: new URL(request.url).pathname.split("/").at(-1), type: "page", title: "My Page" }))
const media = vi.fn(async () => ({ body: new Blob(["archive"]).stream(), size: 7 }))
const env = { ALOOK_PAGE_ORIGIN: "https://pages.invalid", ALOOK_PAGE_SERVICE_KEY: "test-key-that-is-at-least-32-bytes", ALOOK_PAGE_HOST: { fetch: host }, COMMUNITY_MEDIA: { get: media } } as unknown as RuntimeEnv
beforeEach(() => { vi.clearAllMocks(); mocks.owned.mockResolvedValue({ r2Key: "uploaded", contentType: "application/zip", size: 7 }); mocks.binding.mockReturnValue("binding") })
it("imports a bot-owned archive before returning the trusted embed and atomic message binding", async () => {
  const result = await preparePagePublication({} as never, env, "bot", "nonce", "attachment")
  expect(result.ok).toBe(true)
  expect(mocks.owned).toHaveBeenCalledWith({}, "attachment", "bot")
  if (!result.ok) return
  const [embed] = JSON.parse(result.embeds)
  expect(embed).toEqual({ kind: "alook_page", id: expect.stringMatching(/^page_[0-9a-f]{32}$/), type: "page", title: "My Page" })
  expect(result.statements("message")).toEqual(["binding"])
  expect(mocks.binding).toHaveBeenCalledWith({}, expect.objectContaining({ id: embed.id, messageId: "message", botId: "bot" }))
  const first = host.mock.calls[0]![0]
  const retry = await preparePagePublication({} as never, env, "bot", "nonce", "attachment")
  expect(retry.ok && retry.embeds).toBe(result.embeds)
  expect(host.mock.calls[1]![0].url).toBe(first.url)
  expect(first.headers.get("x-alook-subject")).toBe("bot")
})
it("does not advertise a card when ownership or host publication fails", async () => {
  mocks.owned.mockResolvedValueOnce(null)
  expect(await preparePagePublication({} as never, env, "bot", "nonce", "foreign")).toMatchObject({ ok: false, status: 400 })
  expect(host).not.toHaveBeenCalled()
  host.mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }))
  expect(await preparePagePublication({} as never, env, "bot", "nonce", "attachment")).toMatchObject({ ok: false, status: 503 })
  expect(mocks.binding).not.toHaveBeenCalled()
})
