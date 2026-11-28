import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const mocks = vi.hoisted(() => ({
  env: { DB: {}, ALOOK_PAGE_ORIGIN: "https://pages.example.invalid", ALOOK_PAGE_SERVICE_KEY: "a-private-test-key-that-is-long-enough" },
  userId: "reader" as string | null,
  read: vi.fn(), register: vi.fn(), consume: vi.fn(), access: vi.fn(), communication: vi.fn(), user: vi.fn(), thread: vi.fn(), send: vi.fn(), rate: vi.fn(),
}))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: async () => ({ env: mocks.env }) }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({}) }))
vi.mock("@/lib/middleware/auth", () => ({ humanAuthPolicy: {
  resolve: async () => mocks.userId ? { context: { env: mocks.env, userId: mocks.userId } }
    : NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
} }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: (...args: unknown[]) => mocks.rate(...args) }))
vi.mock("@/lib/community/permissions", () => ({ requireMessageSurfaceCommunicationAccess: (...args: unknown[]) => mocks.communication(...args) }))
vi.mock("@/lib/community/message-send.server", () => ({ handleHumanSend: (...args: unknown[]) => mocks.send(...args) }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: { ...actual.queries,
    communityPage: {
      getReadablePage: (...args: unknown[]) => mocks.read(...args),
      createPageViewerTicket: (...args: unknown[]) => mocks.register(...args),
      consumePageViewerTicket: (...args: unknown[]) => mocks.consume(...args),
      getReadablePageForArtifact: (...args: unknown[]) => mocks.access(...args),
      getReadableResource: (...args: unknown[]) => mocks.access(...args),
      listReadablePageChannels: async () => [{ channelId: "channel" }],
    },
    user: { getUserPublic: (...args: unknown[]) => mocks.user(...args) },
    communityChannel: { getThreadChannelByParentMessage: (...args: unknown[]) => mocks.thread(...args) },
  } }
})

import { POST as viewer } from "./[id]/viewer-token/route"
import { POST as exchange } from "./viewer-exchange/route"
import { POST as access } from "./access/route"
import { POST as nativeComment } from "./artifact-comment/route"
import { POST as comment } from "./[id]/comments/route"

const page = { id: "page", artifactId: "art_page", messageId: "source", sourceBotId: "bot", botId: "bot", channelId: "channel", channelType: "text", createdAt: "now" }
const route = { params: Promise.resolve({ id: "page" }) }
function request(body: unknown = {}, credential?: string) {
  return new NextRequest("https://alook.invalid/api/community/pages/page", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.env.ALOOK_PAGE_ORIGIN = "https://pages.example.invalid"
  mocks.env.ALOOK_PAGE_SERVICE_KEY = "a-private-test-key-that-is-long-enough"
  mocks.userId = "reader"
  mocks.read.mockResolvedValue(page)
  mocks.register.mockResolvedValue(undefined)
  mocks.consume.mockResolvedValue({ page, userId: "reader" })
  mocks.access.mockResolvedValue(page)
  mocks.communication.mockResolvedValue({ ok: true })
  mocks.user.mockResolvedValue({ id: "reader", name: "A person", discriminator: "1234" })
  mocks.thread.mockResolvedValue({ id: "forum-thread" })
  mocks.send.mockResolvedValue(NextResponse.json({ message: { id: "comment-message" } }, { status: 201 }))
  mocks.rate.mockResolvedValue({ allowed: true })
})

describe("Page viewer authentication", () => {
  it("issues a one-minute opaque ticket in the fragment and stores only its hash for the current account", async () => {
    const response = await viewer(request(), route)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    const result = await response.json()
    const url = new URL(result.embedUrl)
    expect(url.origin).toBe(mocks.env.ALOOK_PAGE_ORIGIN)
    expect(url.pathname).toBe("/alook/open/art_page")
    expect(url.search).toBe("")
    const token = new URLSearchParams(url.hash.slice(1)).get("ticket")!
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(result.allowedOrigins).toEqual([url.origin])
    expect(mocks.read).toHaveBeenCalledWith({}, "page", "reader", undefined)
    const registered = mocks.register.mock.calls[0]![1]
    expect(registered).toMatchObject({ userId: "reader", pageId: "page", origin: url.origin, hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(JSON.stringify(registered)).not.toContain(token)
    expect(Date.parse(registered.expiresAt) - Date.parse(registered.now)).toBe(60_000)
  })

  it("does not mint for an anonymous account, denied Page, missing host or rate-limited account", async () => {
    mocks.userId = null
    expect((await viewer(request(), route)).status).toBe(401)
    mocks.userId = "reader"
    mocks.read.mockResolvedValue(null)
    expect((await viewer(request(), route)).status).toBe(404)
    mocks.env.ALOOK_PAGE_ORIGIN = "http://untrusted.invalid"
    expect((await viewer(request(), route)).status).toBe(503)
    mocks.env.ALOOK_PAGE_ORIGIN = "https://pages.example.invalid"
    mocks.rate.mockResolvedValue({ allowed: false, retryAfterSec: 12 })
    const limited = await viewer(request(), route)
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("12")
    expect(mocks.register).not.toHaveBeenCalled()
  })

  it("permits only the dedicated host to exchange a ticket for the current live account", async () => {
    const body = { ticket: "a".repeat(43), origin: mocks.env.ALOOK_PAGE_ORIGIN }
    expect((await exchange(request(body))).status).toBe(401)
    expect(mocks.consume).not.toHaveBeenCalled()
    const response = await exchange(request(body, mocks.env.ALOOK_PAGE_SERVICE_KEY))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ subject: "reader", name: "A person", pageId: "page", artifactId: "art_page", sourceMessageId: "source" })
    expect(mocks.consume).toHaveBeenCalledWith({}, expect.stringMatching(/^[0-9a-f]{64}$/), body.origin, expect.any(String))
    mocks.consume.mockResolvedValue(null)
    expect((await exchange(request(body, mocks.env.ALOOK_PAGE_SERVICE_KEY))).status).toBe(404)
  })

  it("rejects changed audience and injected claims without consuming the ticket", async () => {
    for (const body of [
      { ticket: "a".repeat(43), origin: "https://evil.invalid" },
      { ticket: "a".repeat(43), origin: mocks.env.ALOOK_PAGE_ORIGIN, subject: "owner" },
    ]) expect((await exchange(request(body, mocks.env.ALOOK_PAGE_SERVICE_KEY))).status).toBe(400)
    expect(mocks.consume).not.toHaveBeenCalled()
  })

  it("returns a fail-closed live role only to the trusted host", async () => {
    const body = { subject: "reader", artifactId: "art_page" }
    expect((await access(request(body))).status).toBe(401)
    expect(mocks.access).not.toHaveBeenCalled()
    expect(await (await access(request(body, mocks.env.ALOOK_PAGE_SERVICE_KEY))).json()).toEqual({ role: "editor" })
    expect(mocks.access).toHaveBeenCalledWith({}, "art_page", "reader", "artifactId")
    mocks.communication.mockResolvedValue({ ok: false, status: 403 })
    expect(await (await access(request(body, mocks.env.ALOOK_PAGE_SERVICE_KEY))).json()).toEqual({ role: "viewer" })
    mocks.access.mockResolvedValue(null)
    expect(await (await access(request(body, mocks.env.ALOOK_PAGE_SERVICE_KEY))).json()).toEqual({ role: null })
  })
})

describe("Page feedback is an ordinary human message", () => {
  it("uses the logged-in person, source conversation, original message and publishing bot", async () => {
    const response = await comment(request({ text: "Change this", location: "section=2" }), route)
    expect(response.status).toBe(201)
    expect(mocks.send).toHaveBeenCalledWith({}, "reader", mocks.env, { id: "channel" }, {
      content: expect.stringContaining("@A person#1234"), replyToId: "source",
    }, expect.any(Number))
    expect(mocks.send.mock.calls[0]![4].content).toContain("section=2")
    expect(mocks.send.mock.calls[0]![4].content).toContain("Change this")
    expect(mocks.thread).not.toHaveBeenCalled()
  })

  it("uses the existing post thread for a forum Page without creating another post", async () => {
    mocks.read.mockResolvedValue({ ...page, channelType: "forum" })
    await comment(request({ text: "Change this" }), route)
    expect(mocks.send).toHaveBeenCalledWith({}, "reader", mocks.env, { id: "forum-thread" }, {
      content: expect.any(String),
    }, expect.any(Number))
  })

  it("refuses forged authors/targets, missing access and anonymous requests", async () => {
    for (const key of ["authorId", "botId", "channelId"]) {
      expect((await comment(request({ text: "Hello", [key]: "other" }), route)).status).toBe(400)
    }
    mocks.read.mockResolvedValue(null)
    expect((await comment(request({ text: "Hello" }), route)).status).toBe(404)
    mocks.userId = null
    expect((await comment(request({ text: "Hello" }), route)).status).toBe(401)
    expect(mocks.send).not.toHaveBeenCalled()
  })
})

it("native feedback requires the service credential, resolves live source access, and preserves the real author and nonce", async () => {
  const body = { subject: "reader", artifactId: "art_page", text: "Fix this", nonce: "native-request" }
  expect((await nativeComment(request(body))).status).toBe(401)
  expect(mocks.send).not.toHaveBeenCalled()
  expect((await nativeComment(request(body, mocks.env.ALOOK_PAGE_SERVICE_KEY))).status).toBe(201)
  expect(mocks.access).toHaveBeenCalledWith({}, "art_page", "reader", undefined)
  expect(mocks.send).toHaveBeenCalledWith({}, "reader", mocks.env, { id: "channel" }, expect.objectContaining({ nonce: "native-request", replyToId: "source" }), expect.any(Number))
  mocks.access.mockResolvedValue(null)
  expect((await nativeComment(request(body, mocks.env.ALOOK_PAGE_SERVICE_KEY))).status).toBe(404)
})
