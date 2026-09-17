import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { verifyAnalyticsConsentProof } from "@/lib/analytics-consent-server"

const mocks = vi.hoisted(() => ({
  env: { BETTER_AUTH_SECRET: "route-consent-signing-secret" },
}))

vi.mock("@/lib/middleware/env", () => ({
  withEnv: (handler: (request: NextRequest, context: { env: typeof mocks.env }) => Promise<Response>) =>
    (request: NextRequest) => handler(request, { env: mocks.env }),
}))

import { POST } from "./route"

function request(
  body: unknown,
  origin = "https://alook.ai",
  url = "https://alook.ai/api/privacy/analytics-consent",
) {
  return new NextRequest(url, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.env.BETTER_AUTH_SECRET = "route-consent-signing-secret"
})

describe("POST /api/privacy/analytics-consent", () => {
  it.each(["granted", "denied"] as const)("sets the readable and signed %s cookies", async (decision) => {
    const response = await POST(request({ decision }))
    const cookies = response.headers.getSetCookie()

    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0")
    expect(await response.json()).toEqual({ decision })
    expect(cookies).toHaveLength(2)
    expect(cookies[0]).toContain(`alook_analytics_consent=v1.${decision}`)
    expect(cookies[0]).toContain("Path=/")
    expect(cookies[0]).toContain("Max-Age=15552000")
    expect(cookies[0]).toContain("SameSite=lax")
    expect(cookies[0]).toContain("Secure")
    expect(cookies[0]).not.toContain("HttpOnly")
    expect(cookies[1]).toContain("alook_analytics_consent_proof=")
    expect(cookies[1]).toContain("HttpOnly")
    expect(cookies[1]).toContain("Secure")

    const proof = cookies[1].match(/^[^=]+=([^;]+)/u)?.[1]
    await expect(verifyAnalyticsConsentProof(
      proof,
      mocks.env.BETTER_AUTH_SECRET,
    )).resolves.toBe(decision)
  })

  it("allows local HTTP while omitting Secure", async () => {
    const response = await POST(request(
      { decision: "denied" },
      "http://localhost:3000",
      "http://localhost:3000/api/privacy/analytics-consent",
    ))
    expect(response.status).toBe(200)
    expect(response.headers.getSetCookie().every((cookie) => !cookie.includes("Secure"))).toBe(true)
  })

  it("uses the browser origin behind a local reverse proxy", async () => {
    const response = await POST(new NextRequest(
      "https://localhost:3001/api/privacy/analytics-consent",
      {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:3000",
          Host: "127.0.0.1:3000",
          "X-Forwarded-Host": "127.0.0.1:3000",
          "X-Forwarded-Proto": "https",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ decision: "granted" }),
      },
    ))

    expect(response.status).toBe(200)
    expect(response.headers.getSetCookie().every((cookie) => !cookie.includes("Secure"))).toBe(true)
  })

  it.each([
    ["cross-origin", request({ decision: "granted" }, "https://evil.example"), 403],
    ["missing origin", new NextRequest("https://alook.ai/api/privacy/analytics-consent", {
      method: "POST",
      body: JSON.stringify({ decision: "granted" }),
    }), 403],
    ["unknown decision", request({ decision: "maybe" }), 400],
    ["extra fields", request({ decision: "granted", userId: "other" }), 400],
    ["null body", request(null), 400],
  ] as const)("rejects %s", async (_name, input, status) => {
    const response = await POST(input)
    expect(response.status).toBe(status)
    expect(response.headers.getSetCookie()).toEqual([])
  })

  it("fails closed without a signing secret", async () => {
    mocks.env.BETTER_AUTH_SECRET = ""
    const response = await POST(request({ decision: "granted" }))
    expect(response.status).toBe(503)
    expect(response.headers.getSetCookie()).toEqual([])
  })
})
