import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import type { AuthenticatedHandler } from "@/lib/middleware/auth"

const mocks = vi.hoisted(() => ({
  user: { isBot: false } as { isBot: boolean } | undefined,
  ai: { run: vi.fn() }, rate: vi.fn(), read: vi.fn(), transcribe: vi.fn(),
}))
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: AuthenticatedHandler) => (request: NextRequest) => handler(request, {
    env: { AI: mocks.ai } as Env, userId: "human", email: "human@test.invalid", user: mocks.user,
  }),
}))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.rate }))
vi.mock("@/lib/audio/transcription", async () => ({
  ...await vi.importActual<typeof import("@/lib/audio/transcription")>("@/lib/audio/transcription"),
  readTranscriptionAudio: mocks.read, transcribeAudio: mocks.transcribe,
}))
import { AudioError } from "@/lib/audio/http"
import { POST } from "./route"
const request = () => new NextRequest("https://alook.test/api/audio/transcriptions", { method: "POST" })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user = { isBot: false }
  mocks.rate.mockResolvedValue({ allowed: true })
  mocks.read.mockResolvedValue(new Uint8Array([1, 2]))
  mocks.transcribe.mockResolvedValue("完整文本")
})
afterEach(() => vi.unstubAllEnvs())

describe("generic human transcription route", () => {
  it.each(["development", "production"])("uses AI options compatible with the %s transport", async mode => {
    vi.stubEnv("NODE_ENV", mode)
    const req = request()
    expect((await POST(req)).status).toBe(200)
    expect(mocks.transcribe).toHaveBeenCalledWith(mocks.ai, new Uint8Array([1, 2]), mode === "development" ? undefined : req.signal)
  })
  it("does not invoke AI after the caller has already cancelled", async () => {
    vi.stubEnv("NODE_ENV", "development")
    const controller = new AbortController()
    const req = new NextRequest(request(), { signal: controller.signal })
    controller.abort()
    expect((await POST(req)).status).toBe(503)
    expect(mocks.transcribe).not.toHaveBeenCalled()
  })
  it("rejects bot and machine credentials before reading audio or calling the model", async () => {
    for (const user of [{ isBot: true }, undefined]) {
      mocks.user = user
      expect((await POST(request())).status).toBe(403)
    }
    expect(mocks.rate).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.transcribe).not.toHaveBeenCalled()
  })

  it("applies the independent account rate limit before consuming audio", async () => {
    mocks.rate.mockResolvedValue({ allowed: false, retryAfterSec: 41 })
    const response = await POST(request())
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("41")
    expect(mocks.rate).toHaveBeenCalledWith(expect.anything(), "audio:transcriptions", "human")
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it("returns only the full transcript without a message mutation", async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ text: "完整文本" })
    expect(mocks.transcribe).toHaveBeenCalledOnce()
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0")
    expect(response.headers.get("Vary")).toContain("Cookie")
    expect(response.headers.get("Vary")).toContain("Authorization")
  })

  it("does not invoke the model on invalid audio", async () => {
    mocks.read.mockRejectedValue(new AudioError("invalid WAV", 400))
    expect((await POST(request())).status).toBe(400)
    expect(mocks.transcribe).not.toHaveBeenCalled()
  })

  it("hides provider failures and audio from the error response", async () => {
    mocks.transcribe.mockRejectedValue(new Error("credential-or-private-audio"))
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect(response.headers.get("Cache-Control")).toContain("no-store")
    expect(await response.text()).not.toContain("credential-or-private-audio")
  })
})
