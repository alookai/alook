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
