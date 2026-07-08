import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { checkRateLimit } from "./rate-limit"

const mockWsDoFetch = vi.fn()
vi.mock("@/lib/broadcast", () => ({
  wsDoFetch: (...a: unknown[]) => mockWsDoFetch(...a),
}))

describe("checkRateLimit — unified rate-limit entry", () => {
  beforeEach(() => {
    mockWsDoFetch.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("looks up the registered policy and forwards it to the DO", async () => {
    mockWsDoFetch.mockResolvedValue(
      new Response(JSON.stringify({ allowed: true }), { status: 200 }),
    )
    await checkRateLimit({} as Env, "community:msgSend", "u_1")
    const [, path, init] = mockWsDoFetch.mock.calls[0]!
    expect(path).toBe("/rate-limit/check")
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body).toEqual({
      name: "community:msgSend",
      key: "u_1",
      windowMs: 10_000,
      max: 30,
    })
  })

  it("supports per-call overrides for policies whose limits are configurable", async () => {
    mockWsDoFetch.mockResolvedValue(
      new Response(JSON.stringify({ allowed: true }), { status: 200 }),
    )
    await checkRateLimit({} as Env, "auth:otpSend", "a@b.com", {
      windowMs: 120_000,
      max: 3,
    })
    const [, , init] = mockWsDoFetch.mock.calls[0]!
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      name: "auth:otpSend",
      key: "a@b.com",
      windowMs: 120_000,
      max: 3,
    })
  })

  it("returns the DO response verbatim on success", async () => {
    mockWsDoFetch.mockResolvedValue(
      new Response(JSON.stringify({ allowed: false, retryAfterSec: 7 }), { status: 200 }),
    )
    const r = await checkRateLimit({} as Env, "community:msgSend", "u_1")
    expect(r).toEqual({ allowed: false, retryAfterSec: 7 })
  })

  it("fails open on non-2xx transport failure", async () => {
    mockWsDoFetch.mockResolvedValue(new Response("boom", { status: 503 }))
    const r = await checkRateLimit({} as Env, "community:msgSend", "u_1")
    expect(r).toEqual({ allowed: true })
  })

  it("fails open when wsDoFetch throws", async () => {
    mockWsDoFetch.mockRejectedValue(new Error("network"))
    const r = await checkRateLimit({} as Env, "community:msgSend", "u_1")
    expect(r).toEqual({ allowed: true })
  })
})
