import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"

const originalNodeEnv = process.env.NODE_ENV
const originalServerUrl = process.env.NEXT_PUBLIC_COMMUNITY_SERVER_URL
const originalWsUrl = process.env.NEXT_PUBLIC_COMMUNITY_DAEMON_WS_URL

beforeEach(() => {
  vi.resetModules()
  delete process.env.NEXT_PUBLIC_COMMUNITY_SERVER_URL
  delete process.env.NEXT_PUBLIC_COMMUNITY_DAEMON_WS_URL
})

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv
  if (originalServerUrl === undefined) delete process.env.NEXT_PUBLIC_COMMUNITY_SERVER_URL
  else process.env.NEXT_PUBLIC_COMMUNITY_SERVER_URL = originalServerUrl
  if (originalWsUrl === undefined) delete process.env.NEXT_PUBLIC_COMMUNITY_DAEMON_WS_URL
  else process.env.NEXT_PUBLIC_COMMUNITY_DAEMON_WS_URL = originalWsUrl
})

describe("community env constants", () => {
  it("falls back to dev defaults when env vars are unset in dev", async () => {
    process.env.NODE_ENV = "development"
    const mod = await import("./env.js")
    expect(mod.COMMUNITY_SERVER_URL).toBe("http://localhost:3000")
    expect(mod.COMMUNITY_DAEMON_WS_URL).toBe("ws://localhost:8789")
  })

  it("uses env var values when set in dev", async () => {
    process.env.NODE_ENV = "development"
    process.env.NEXT_PUBLIC_COMMUNITY_SERVER_URL = "https://alook.example"
    process.env.NEXT_PUBLIC_COMMUNITY_DAEMON_WS_URL = "wss://ws.alook.example"
    const mod = await import("./env.js")
    expect(mod.COMMUNITY_SERVER_URL).toBe("https://alook.example")
    expect(mod.COMMUNITY_DAEMON_WS_URL).toBe("wss://ws.alook.example")
  })

  it("throws in production when env vars are unset", async () => {
    process.env.NODE_ENV = "production"
    await expect(import("./env.js")).rejects.toThrow(
      /Missing required env var NEXT_PUBLIC_COMMUNITY_SERVER_URL/,
    )
  })

  it("uses env var values when set in production", async () => {
    process.env.NODE_ENV = "production"
    process.env.NEXT_PUBLIC_COMMUNITY_SERVER_URL = "https://alook.example"
    process.env.NEXT_PUBLIC_COMMUNITY_DAEMON_WS_URL = "wss://ws.alook.example"
    const mod = await import("./env.js")
    expect(mod.COMMUNITY_SERVER_URL).toBe("https://alook.example")
    expect(mod.COMMUNITY_DAEMON_WS_URL).toBe("wss://ws.alook.example")
  })
})
