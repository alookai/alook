import { describe, expect, it } from "vitest"
import {
  ANALYTICS_CONSENT_MAX_AGE_SECONDS,
} from "./analytics-consent"
import {
  createAnalyticsConsentProof,
  parseGaClientId,
  parseGaSessionId,
  readCheckoutAnalyticsConsent,
  verifyAnalyticsConsentProof,
} from "./analytics-consent-server"

const SECRET = "test-consent-signing-secret"
const NOW = Date.UTC(2026, 8, 17, 4, 0, 0)

describe("analytics consent proof", () => {
  it.each(["granted", "denied"] as const)("round-trips %s", async (decision) => {
    const proof = await createAnalyticsConsentProof(decision, SECRET, NOW)
    await expect(verifyAnalyticsConsentProof(proof, SECRET, NOW)).resolves.toEqual({
      decision,
      sourceVersion: Math.floor(NOW / 1000),
    })
  })

  it("returns the signed decision time as the consent source version", async () => {
    const proof = await createAnalyticsConsentProof("granted", SECRET, NOW)
    await expect(verifyAnalyticsConsentProof(proof, SECRET, NOW)).resolves.toEqual({
      decision: "granted",
      sourceVersion: Math.floor(NOW / 1000),
    })
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

describe("GA checkout identity", () => {
  it.each([
    ["GA1.1.123456789.1700000000", "123456789.1700000000"],
    ["GA2.2.1.2", "1.2"],
    ["bad", null],
    ["GA1.1.a.2", null],
  ])("parses client cookie %s", (value, expected) => {
    expect(parseGaClientId(value)).toBe(expected)
  })

  it.each([
    ["GS1.1.1700000000.3.0.0", "1700000000"],
    ["GS2.1.s1700000000$o3$g0", "1700000000"],
    ["GS2.1.o3$s1700000000", null],
    ["bad", null],
  ])("parses session cookie %s", (value, expected) => {
    expect(parseGaSessionId(value)).toBe(expected)
  })

  it("returns identity only with a valid signed grant and valid client cookie", async () => {
    const proof = await createAnalyticsConsentProof("granted", SECRET)
    const cookies = [
      `alook_analytics_consent_proof=${encodeURIComponent(proof)}`,
      "_ga=GA1.1.123456789.1700000000",
      "_ga_STBCL8F4ZY=GS2.1.s1700000000$o1",
    ].join("; ")
    await expect(readCheckoutAnalyticsConsent(cookies, SECRET)).resolves.toEqual({
      decision: "granted",
      sourceVersion: Number(proof.split(".")[2]),
      identity: { clientId: "123456789.1700000000", sessionId: "1700000000" },
    })
    await expect(readCheckoutAnalyticsConsent(cookies, "wrong-secret")).resolves.toEqual({ decision: null, sourceVersion: null, identity: null })
  })

  it.each(["", "; _ga_STBCL8F4ZY=bad"])("rejects checkout identity without a valid stream session cookie (%s)", async (sessionCookie) => {
    const proof = await createAnalyticsConsentProof("granted", SECRET)
    const cookies = `alook_analytics_consent_proof=${encodeURIComponent(proof)}; _ga=GA1.1.123456789.1700000000${sessionCookie}`
    await expect(readCheckoutAnalyticsConsent(cookies, SECRET)).resolves.toEqual({
      decision: "granted",
      sourceVersion: Number(proof.split(".")[2]),
      identity: null,
    })
  })
})
