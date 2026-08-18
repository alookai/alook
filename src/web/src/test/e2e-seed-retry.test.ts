import { describe, expect, it, vi } from "vitest"
import {
  isRetryableSeedStatus,
  retrySeedRequest,
  seedRetryDelayMs,
} from "./e2e-ui/_fixtures/seed-retry"

describe("UI E2E seed retry", () => {
  it("retries transient auth, rate-limit, and server failures", () => {
    expect(isRetryableSeedStatus(401)).toBe(true)
    expect(isRetryableSeedStatus(403)).toBe(true)
    expect(isRetryableSeedStatus(429)).toBe(true)
    expect(isRetryableSeedStatus(503)).toBe(true)
    expect(isRetryableSeedStatus(400)).toBe(false)
    expect(isRetryableSeedStatus(404)).toBe(false)
  })

  it("honors Retry-After for rate-limited fixture writes", () => {
    expect(seedRetryDelayMs({ status: 429, headers: new Headers({ "Retry-After": "7" }) })).toBe(7000)
    expect(seedRetryDelayMs({ status: 429, headers: new Headers() })).toBe(400)
    expect(seedRetryDelayMs({ status: 503, headers: new Headers({ "Retry-After": "7" }) })).toBe(400)
  })

  it("waits the advertised delay and retries a rate-limited request", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 429,
        headers: { "Retry-After": "7" },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
    const wait = vi.fn().mockResolvedValue(undefined)

    const response = await retrySeedRequest(request, wait)

    expect(response.status).toBe(201)
    expect(request).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledOnce()
    expect(wait).toHaveBeenCalledWith(7000)
  })

  it("does not retry an ordinary client error", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
    const wait = vi.fn().mockResolvedValue(undefined)

    const response = await retrySeedRequest(request, wait)

    expect(response.status).toBe(400)
    expect(request).toHaveBeenCalledOnce()
    expect(wait).not.toHaveBeenCalled()
  })
})
