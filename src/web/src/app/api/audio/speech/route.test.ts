import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import type { AuthenticatedHandler } from "@/lib/middleware/auth"
const mocks = vi.hoisted(() => ({ anonymous: false, run: vi.fn(), rate: vi.fn() }))
vi.mock("@/lib/middleware/auth", () => ({ withAuth: (handler: AuthenticatedHandler) => (request: NextRequest) => mocks.anonymous ? Promise.resolve(new Response("unauthorized", { status: 401 })) : handler(request, { env: { AI: { run: mocks.run } } as Env, userId: "human", email: "fixture@invalid", user: { isBot: false } }) }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.rate }))
import { POST } from "./route"
const request = (body: unknown = { text: "Hello", lang: "en" }) => new NextRequest("https://fixture.invalid/api/audio/speech", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0])
beforeEach(() => { vi.clearAllMocks(); mocks.anonymous = false; mocks.rate.mockResolvedValue({ allowed: true }); mocks.run.mockImplementation(async () => new Response(mp3, { headers: { "Content-Type": "audio/mpeg" } })) })
describe("generic speech endpoint", () => {
  it("returns only native audio with private headers", async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg")
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(mp3)
    expect(mocks.rate).toHaveBeenCalledWith(expect.anything(), "audio:speech", "human")
  })
  it("preserves a base64 WAV result and advertises its actual media type", async () => {
    const audio = new Uint8Array(48)
    audio.set(new TextEncoder().encode("RIFF"))
    audio.set(new TextEncoder().encode("WAVE"), 8)
    new DataView(audio.buffer).setUint32(4, audio.length - 8, true)
    mocks.run.mockResolvedValueOnce(Response.json({ audio: Buffer.from(audio).toString("base64") }))
    const response = await POST(request({ text: "你好", lang: "zh" }))
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("audio/wav")
    expect(response.headers.get("Cache-Control")).toContain("no-store")
    expect(response.headers.get("Vary")).toContain("Authorization")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(audio)
  })
  it("does not call the model for anonymous, limited or invalid requests", async () => {
    mocks.anonymous = true
    expect((await POST(request())).status).toBe(401)
    mocks.anonymous = false
    mocks.rate.mockResolvedValueOnce({ allowed: false, retryAfterSec: 9 })
    expect((await POST(request())).status).toBe(429)
    expect((await POST(request({ text: "" }))).status).toBe(400)
    expect(mocks.run).not.toHaveBeenCalled()
  })
  it("never disguises a provider error as audio or shares its private detail", async () => {
    mocks.run.mockResolvedValueOnce({ error: "private-prompt" })
    const response = await POST(request())
    expect(response.status).toBe(502)
    expect(response.headers.get("Content-Type")).toContain("application/json")
    expect(response.headers.get("Cache-Control")).toContain("no-store")
    expect(await response.text()).not.toContain("private-prompt")
  })
  it("keeps streaming through the private response wrapper before the model has finished", async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>
    const cancel = vi.fn()
    mocks.run.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller }, cancel }), { headers: { "Content-Type": "audio/mpeg" } }))
    const pending = POST(request())
    upstream.enqueue(mp3)
    const response = await pending
    expect(response.headers.get("Cache-Control")).toContain("no-store")
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toEqual(mp3)
    await reader.cancel()
    expect(cancel).toHaveBeenCalledOnce()
    expect(mocks.run).toHaveBeenCalledWith(expect.anything(), { prompt: "Hello", lang: "en" }, expect.objectContaining({ returnRawResponse: true }))
  })
})
