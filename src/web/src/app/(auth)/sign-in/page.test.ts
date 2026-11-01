import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
  cookies: vi.fn(),
}))

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}))
vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}))
vi.mock("./sign-in-client", () => ({
  default: () => null,
}))

import SignInPage from "./page"

describe("sign-in server configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.cookies.mockResolvedValue({
      get: vi.fn(() => undefined),
    })
  })

  it("passes a disabled Apple flag and null last-used method when absent", async () => {
    mocks.getCloudflareContext.mockResolvedValueOnce({
      env: { NODE_ENV: "production" },
    })

    const page = await SignInPage()

    expect(page.props).toMatchObject({
      isProd: true,
      appleEnabled: false,
      initialLastUsedMethod: null,
    })
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

  it("normalizes remembered login method cookies and drops unknown values", async () => {
    mocks.cookies.mockResolvedValueOnce({
      get: vi.fn((name: string) =>
        name === "alook_last_login_method" ? { value: "email-otp" } : undefined),
    })
    mocks.getCloudflareContext.mockResolvedValueOnce({
      env: { NODE_ENV: "production" },
    })
    expect((await SignInPage()).props.initialLastUsedMethod).toBe("email")

    mocks.cookies.mockResolvedValueOnce({
      get: vi.fn(() => ({ value: "unexpected-provider" })),
    })
    mocks.getCloudflareContext.mockResolvedValueOnce({
      env: { NODE_ENV: "production" },
    })
    expect((await SignInPage()).props.initialLastUsedMethod).toBeNull()
  })

  it("shows the real OTP form for the explicit local QA configuration", async () => {
    mocks.getCloudflareContext.mockResolvedValueOnce({
      env: { NODE_ENV: "development", DEV_AUTH_OTP: "1" },
    })
    expect((await SignInPage()).props.isProd).toBe(true)
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
