import { describe, expect, it } from "vitest"
import {
  ANALYTICS_CONSENT_MAX_AGE_SECONDS,
} from "./analytics-consent"
import {
  createAnalyticsConsentProof,
  verifyAnalyticsConsentProof,
} from "./analytics-consent-server"

const SECRET = "test-consent-signing-secret"
const NOW = Date.UTC(2026, 8, 17, 4, 0, 0)

describe("analytics consent proof", () => {
  it.each(["granted", "denied"] as const)("round-trips %s", async (decision) => {
    const proof = await createAnalyticsConsentProof(decision, SECRET, NOW)
    await expect(verifyAnalyticsConsentProof(proof, SECRET, NOW)).resolves.toBe(decision)
  })

  it("rejects a changed decision or signature", async () => {
    const proof = await createAnalyticsConsentProof("granted", SECRET, NOW)
    await expect(verifyAnalyticsConsentProof(
      proof.replace(".granted.", ".denied."),
      SECRET,
      NOW,
    )).resolves.toBeNull()
    await expect(verifyAnalyticsConsentProof(`${proof.slice(0, -1)}x`, SECRET, NOW)).resolves.toBeNull()
  })

  it("rejects stale, future, malformed, and wrong-secret proofs", async () => {
    const stale = await createAnalyticsConsentProof(
      "granted",
      SECRET,
      NOW - (ANALYTICS_CONSENT_MAX_AGE_SECONDS + 1) * 1000,
    )
    const future = await createAnalyticsConsentProof("granted", SECRET, NOW + 301_000)
    const current = await createAnalyticsConsentProof("granted", SECRET, NOW)

    await expect(verifyAnalyticsConsentProof(stale, SECRET, NOW)).resolves.toBeNull()
    await expect(verifyAnalyticsConsentProof(future, SECRET, NOW)).resolves.toBeNull()
    await expect(verifyAnalyticsConsentProof("v1.granted.nope.signature", SECRET, NOW)).resolves.toBeNull()
    await expect(verifyAnalyticsConsentProof(
      `v1.granted.${Math.floor(NOW / 1000)}.A`,
      SECRET,
      NOW,
    )).resolves.toBeNull()
    await expect(verifyAnalyticsConsentProof(current, "other-secret", NOW)).resolves.toBeNull()
  })
})
