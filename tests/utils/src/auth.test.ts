import { afterEach, describe, expect, it, vi } from "vitest"
import { signIn } from "./auth"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("signIn", () => {
  it("selects the Better Auth session token regardless of Set-Cookie order", async () => {
    const headers = new Headers()
    headers.append("Set-Cookie", "is_sign_in=email; Path=/")
    headers.append("Set-Cookie", "better-auth.session_token=session-value; HttpOnly; Path=/")
    headers.append("Set-Cookie", "better-auth.session_data=cached-value; HttpOnly; Path=/")
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200, headers }))

    await expect(signIn("person@example.com", "password"))
      .resolves.toBe("better-auth.session_token=session-value")
  })

  it("fails when Better Auth returns only non-session cookies", async () => {
    const headers = new Headers({
      "Set-Cookie": "is_sign_in=email; Path=/",
    })
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200, headers }))

    await expect(signIn("person@example.com", "password"))
      .rejects.toThrow("no session cookie")
  })
})

describe("current human community session requests", () => {
  it.each(["/api/community/users/me/profile", "/api/community/channels/current/messages"])("qualifies JSON session %s without changing caller headers", async path => {
    const { sessionRequest } = await import("./auth")
    const { COMMUNITY_CONTRACT_HEADER, COMMUNITY_CONTRACT_VERSION } = await import("@alook/shared")
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}))
    await sessionRequest(path, "session=unit", { headers: [["X-Caller", "kept"]] })
    const headers = new Headers(fetch.mock.calls[0]![1]!.headers)
    expect(headers.get(COMMUNITY_CONTRACT_HEADER)).toBe(String(COMMUNITY_CONTRACT_VERSION))
    expect(headers.get("X-Caller")).toBe("kept")
    expect(headers.get("Cookie")).toBe("session=unit")
  })
  it("preserves explicit negative versions and independent credential wire protocols", async () => {
    const { sessionRequest, tokenRequest } = await import("./auth")
    const { COMMUNITY_CONTRACT_HEADER } = await import("@alook/shared")
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}))
    await sessionRequest("/api/community/users/me/profile", "session=unit", { headers: { [COMMUNITY_CONTRACT_HEADER]: "wrong" } })
    await sessionRequest("/api/auth/device/approve", "session=unit")
    await tokenRequest("/api/daemon/status", "unit-credential")
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).get(COMMUNITY_CONTRACT_HEADER)).toBe("wrong")
    expect(new Headers(fetch.mock.calls[1]![1]!.headers).has(COMMUNITY_CONTRACT_HEADER)).toBe(false)
    expect(new Headers(fetch.mock.calls[2]![1]!.headers).has(COMMUNITY_CONTRACT_HEADER)).toBe(false)
    expect(new Headers(fetch.mock.calls[2]![1]!.headers).get("Authorization")).toBe("Bearer unit-credential")
  })
})
