import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
}))

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}))
vi.mock("./sign-in-client", () => ({
  default: () => null,
}))

import SignInPage from "./page"

describe("sign-in server configuration", () => {
  it("passes a disabled Apple flag when all Apple secrets are absent", async () => {
    mocks.getCloudflareContext.mockResolvedValueOnce({
      env: { NODE_ENV: "production" },
    })

    const page = await SignInPage()

    expect(page.props).toMatchObject({ isProd: true, appleEnabled: false })
  })

  it("passes only an enabled boolean when all Apple secrets are present", async () => {
    mocks.getCloudflareContext.mockResolvedValueOnce({
      env: {
        NODE_ENV: "development",
        APPLE_CLIENT_ID: "ai.alook.web",
        APPLE_TEAM_ID: "TEAM123456",
        APPLE_KEY_ID: "KEY1234567",
        APPLE_PRIVATE_KEY: "private-key-never-passed-to-the-client",
      },
    })

    const page = await SignInPage()

    expect(page.props).toMatchObject({ isProd: false, appleEnabled: true })
    expect(JSON.stringify(page.props)).not.toContain("private-key-never-passed-to-the-client")
  })

  it("fails closed instead of rendering with partial Apple configuration", async () => {
    mocks.getCloudflareContext.mockResolvedValueOnce({
      env: { APPLE_CLIENT_ID: "ai.alook.web" },
    })

    await expect(SignInPage()).rejects.toThrow(
      "Apple authentication configuration is incomplete",
    )
  })
})
