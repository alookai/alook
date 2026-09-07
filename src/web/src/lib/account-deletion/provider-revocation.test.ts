import { afterEach, describe, expect, it, vi } from "vitest"
import { revokeProviderAccount } from "./provider-revocation"

describe("account deletion provider revocation", () => {
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
})
