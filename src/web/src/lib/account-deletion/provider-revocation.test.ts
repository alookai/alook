import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const appleMocks = vi.hoisted(() => ({
  generateClientSecret: vi.fn(),
  resolveConfig: vi.fn(),
}))

vi.mock("@/lib/apple-auth", () => ({
  generateAppleClientSecret: appleMocks.generateClientSecret,
  resolveAppleAuthConfig: appleMocks.resolveConfig,
}))

import { revokeProviderAccount } from "./provider-revocation"

const appleEnv = {
  APPLE_CLIENT_ID: "ai.alook.web",
  APPLE_TEAM_ID: "TEAM123456",
  APPLE_KEY_ID: "KEY1234567",
  APPLE_PRIVATE_KEY: "fake-private-key",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
}

describe("account deletion provider revocation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appleMocks.resolveConfig.mockReturnValue({
      enabled: true,
      config: {
        clientId: appleEnv.APPLE_CLIENT_ID,
        teamId: appleEnv.APPLE_TEAM_ID,
        keyId: appleEnv.APPLE_KEY_ID,
        privateKey: appleEnv.APPLE_PRIVATE_KEY,
      },
    })
    appleMocks.generateClientSecret.mockResolvedValue("signed-client-secret")
  })

  afterEach(() => vi.unstubAllGlobals())

  it("revokes Google with the refresh token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    await revokeProviderAccount({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" }, {
      providerId: "google",
      accountId: "account",
      accessToken: "access",
      refreshToken: "refresh",
    })

    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({ body: new URLSearchParams({ token: "refresh" }) }),
    )
  })

  it("revokes GitHub with the access token and app credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)

    await revokeProviderAccount({ GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret" }, {
      providerId: "github",
      accountId: "account",
      accessToken: "access",
      refreshToken: "refresh",
    })

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/applications/client/grant",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ access_token: "access" }),
      }),
    )
  })

  it("reports only the provider status when revocation fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    vi.stubGlobal("fetch", fetchMock)

    const failure = revokeProviderAccount({ GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret" }, {
      providerId: "github",
      accountId: "account",
      accessToken: "private-access-token",
      refreshToken: null,
    })

    await expect(failure).rejects.toThrow("provider revocation returned 401")
    await expect(failure).rejects.not.toThrow("private-access-token")
  })

  it.each([
    {
      name: "refresh token",
      accessToken: "apple-access",
      refreshToken: "apple-refresh",
      expectedToken: "apple-refresh",
      expectedHint: "refresh_token",
    },
    {
      name: "access token fallback",
      accessToken: "apple-access",
      refreshToken: null,
      expectedToken: "apple-access",
      expectedHint: "access_token",
    },
    {
      name: "access token fallback for an empty refresh token",
      accessToken: "apple-access",
      refreshToken: "",
      expectedToken: "apple-access",
      expectedHint: "access_token",
    },
  ])("revokes Apple with the $name before local deletion", async ({
    accessToken,
    refreshToken,
    expectedToken,
    expectedHint,
  }) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    await revokeProviderAccount(appleEnv, {
      providerId: "apple",
      accountId: "stable-sub",
      accessToken,
      refreshToken,
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://appleid.apple.com/auth/revoke")
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    })
    expect(Object.fromEntries((init.body as URLSearchParams).entries())).toEqual({
      client_id: appleEnv.APPLE_CLIENT_ID,
      client_secret: "signed-client-secret",
      token: expectedToken,
      token_type_hint: expectedHint,
    })
    expect(appleMocks.generateClientSecret).toHaveBeenCalledOnce()
  })

  it("fails closed without an Apple token", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(revokeProviderAccount(appleEnv, {
      providerId: "apple",
      accountId: "stable-sub",
      accessToken: null,
      refreshToken: null,
    })).rejects.toThrow("Apple provider revocation token is unavailable")

    expect(fetchMock).not.toHaveBeenCalled()
    expect(appleMocks.generateClientSecret).not.toHaveBeenCalled()
  })

  it("fails closed when Apple revocation configuration is absent", async () => {
    appleMocks.resolveConfig.mockReturnValue({ enabled: false })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(revokeProviderAccount(appleEnv, {
      providerId: "apple",
      accountId: "stable-sub",
      accessToken: "apple-access",
      refreshToken: null,
    })).rejects.toThrow("Apple provider revocation configuration is unavailable")

    expect(fetchMock).not.toHaveBeenCalled()
    expect(appleMocks.generateClientSecret).not.toHaveBeenCalled()
  })

  it("propagates value-free partial-configuration failures", async () => {
    appleMocks.resolveConfig.mockImplementation(() => {
      throw new Error("Apple authentication configuration is incomplete")
    })

    const failure = revokeProviderAccount(appleEnv, {
      providerId: "apple",
      accountId: "stable-sub",
      accessToken: "private-apple-access-token",
      refreshToken: null,
    })

    await expect(failure).rejects.toThrow("Apple authentication configuration is incomplete")
    await expect(failure).rejects.not.toThrow(appleEnv.APPLE_PRIVATE_KEY)
  })

  it("fails closed when Apple's revocation endpoint is unreachable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network unavailable"))
    vi.stubGlobal("fetch", fetchMock)

    await expect(revokeProviderAccount(appleEnv, {
      providerId: "apple",
      accountId: "stable-sub",
      accessToken: "apple-access",
      refreshToken: null,
    })).rejects.toThrow("network unavailable")
  })

  it("does not expose Apple tokens or client secrets in provider errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
    vi.stubGlobal("fetch", fetchMock)

    const failure = revokeProviderAccount(appleEnv, {
      providerId: "apple",
      accountId: "stable-sub",
      accessToken: "private-apple-access-token",
      refreshToken: null,
    })

    await expect(failure).rejects.toThrow("provider revocation returned 503")
    await expect(failure).rejects.not.toThrow("private-apple-access-token")
    await expect(failure).rejects.not.toThrow("signed-client-secret")
  })
})
