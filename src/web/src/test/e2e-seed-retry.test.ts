import { describe, expect, it } from "vitest"
import { isRetryableSeedStatus, seedRetryDelayMs } from "./e2e-ui/_fixtures/seed-retry"

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
})
