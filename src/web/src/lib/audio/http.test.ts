import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import type { AuthenticatedHandler } from "@/lib/middleware/auth"
const mocks = vi.hoisted(() => ({ mode: "human", rate: vi.fn(), run: vi.fn(), handler: vi.fn() }))
vi.mock("@/lib/middleware/auth", () => ({ withAuth: (handler: AuthenticatedHandler) => async (request: NextRequest) => {
  if (mocks.mode === "anonymous") return new Response("unauthorized", { status: 401, headers: { ETag: "auth", "Last-Modified": "yesterday" } })
  if (mocks.mode === "failed") throw new Error("private auth detail")
  return handler(request, { userId: "human", email: "fixture@invalid", user: mocks.mode === "machine" ? undefined : { isBot: mocks.mode === "bot" }, env: { AI: { run: mocks.run } } as Env })
} }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.rate }))
import { audioPost, AudioError, readAudioBytes } from "./http"
const request = () => new NextRequest("https://fixture.invalid/api/audio/speech", { method: "POST" })
beforeEach(() => { vi.clearAllMocks(); mocks.mode = "human"; mocks.rate.mockResolvedValue({ allowed: true }); mocks.handler.mockResolvedValue(Response.json({ ok: true })) })
describe("audio HTTP ownership and privacy", () => {
  it.each(["human", "anonymous", "bot", "machine", "failed"])("keeps %s responses private including authentication failures", async mode => {
    mocks.mode = mode
    const response = await audioPost("audio:speech", mocks.handler)(request())
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0")
    expect(response.headers.get("Vary")).toContain("Cookie")
    expect(response.headers.get("Vary")).toContain("Authorization")
    expect(response.headers.has("ETag")).toBe(false)
    expect(response.headers.has("Last-Modified")).toBe(false)
    if (mode !== "human") expect(mocks.handler).not.toHaveBeenCalled()
    expect(await response.text()).not.toContain("private auth detail")
  })
  it("rate limits the account before reading/model work and preserves Retry-After", async () => {
    mocks.rate.mockResolvedValue({ allowed: false, retryAfterSec: 31 })
    const response = await audioPost("audio:speech", mocks.handler)(request())
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("31")
    expect(mocks.rate).toHaveBeenCalledWith(expect.anything(), "audio:speech", "human")
    expect(mocks.handler).not.toHaveBeenCalled()
  })
  it("redacts unknown provider errors while retaining public input failures", async () => {
    mocks.handler.mockRejectedValueOnce(new Error("private-provider-response"))
    expect(await (await audioPost("audio:speech", mocks.handler)(request())).text()).not.toContain("private-provider-response")
    mocks.handler.mockRejectedValueOnce(new AudioError("Invalid input", 400))
    const response = await audioPost("audio:speech", mocks.handler)(request())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Invalid input" })
  })
  it("bounds actual bytes when the declared length lies and cancels the stream", async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(1)) }, cancel })
    const input = new Request("https://fixture.invalid", { method: "POST", headers: { "Content-Length": "1" }, body: stream, duplex: "half" } as RequestInit)
    await expect(readAudioBytes(input, 8)).rejects.toMatchObject({ status: 413 })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
