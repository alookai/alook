import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
  connection: vi.fn(async () => {}),
}))

vi.mock("next/server", () => ({ connection: mocks.connection }))

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}))
vi.mock("./sign-in-client", () => ({
  default: () => null,
}))

import SignInPage from "./page"

describe("sign-in server configuration", () => {
  beforeEach(() => vi.clearAllMocks())

  it("does not read bindings when the request boundary rejects static rendering", async () => {
    const boundary = new Error("Request required")
    mocks.connection.mockRejectedValueOnce(boundary)
    await expect(SignInPage()).rejects.toBe(boundary)
    expect(mocks.getCloudflareContext).not.toHaveBeenCalled()
  })

  it("waits for the request before reading runtime configuration", async () => {
    let resolve!: () => void
    mocks.connection.mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
    mocks.getCloudflareContext.mockResolvedValueOnce({ env: { NODE_ENV: "production" } })
    const pending = SignInPage()
    expect(mocks.getCloudflareContext).not.toHaveBeenCalled()
    resolve()
    expect((await pending).props).toMatchObject({ isProd: true, appleEnabled: false })
    expect(mocks.getCloudflareContext).toHaveBeenCalledOnce()
  })

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

  it("shows the real OTP form for the explicit local QA configuration", async () => {
    mocks.getCloudflareContext.mockResolvedValueOnce({ env: { NODE_ENV: "development", DEV_AUTH_OTP: "1" } })
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
