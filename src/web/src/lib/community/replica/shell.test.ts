import { afterEach, describe, expect, it, vi } from "vitest"

const originalNavigator = globalThis.navigator
const originalWindow = globalThis.window
const originalMessageChannel = globalThis.MessageChannel

class TestMessageChannel {
  port1: { onmessage: ((event: MessageEvent) => void) | null } = { onmessage: null }
  port2 = { peer: this.port1 }
}

function installBrowser(workerReply: Record<string, unknown> | null = { ok: true }) {
  const postMessage = vi.fn((_message: unknown, ports: Array<{ peer: TestMessageChannel["port1"] }>) => {
    if (workerReply) queueMicrotask(() => ports[0]!.peer.onmessage?.({ data: workerReply } as MessageEvent))
  })
  const worker = { postMessage } as unknown as ServiceWorker
  const register = vi.fn().mockResolvedValue({ active: worker })
  const getRegistration = vi.fn().mockResolvedValue({ active: worker })
  const serviceWorker = {
    register,
    getRegistration,
    ready: Promise.resolve({ active: worker }),
    controller: null,
  }
  vi.stubGlobal("MessageChannel", TestMessageChannel)
  vi.stubGlobal("window", {
    MessageChannel: TestMessageChannel,
    setTimeout,
    clearTimeout,
  })
  vi.stubGlobal("navigator", { serviceWorker })
  return { getRegistration, postMessage, register }
}

afterEach(() => {
  vi.unstubAllGlobals()
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator })
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow })
  Object.defineProperty(globalThis, "MessageChannel", { configurable: true, value: originalMessageChannel })
  vi.resetModules()
})

describe("community shell client", () => {
  it("registers without HTTP cache reuse and asks the active worker to cache the exact route", async () => {
    const browser = installBrowser({ ok: true, protocolVersion: 1, route: "https://alook.test/c/channels/s/c", assets: 7 })
    const { cacheCommunityShellRoute } = await import("./shell")

    await expect(cacheCommunityShellRoute("https://alook.test/c/channels/s/c")).resolves.toEqual({
      ok: true,
      protocolVersion: 1,
      route: "https://alook.test/c/channels/s/c",
      assets: 7,
    })
    expect(browser.register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" })
    expect(browser.postMessage).toHaveBeenCalledWith(
      { type: "CACHE_COMMUNITY_ROUTE", protocolVersion: 1, url: "https://alook.test/c/channels/s/c" },
      expect.any(Array),
    )
  })

  it("clears cached community documents through an existing registration", async () => {
    const browser = installBrowser()
    const { clearCommunityShellRoutes } = await import("./shell")

    await clearCommunityShellRoutes()

    expect(browser.getRegistration).toHaveBeenCalledWith("/")
    expect(browser.register).not.toHaveBeenCalled()
    expect(browser.postMessage).toHaveBeenCalledWith(
      { type: "CLEAR_COMMUNITY_ROUTES" },
      expect.any(Array),
    )
  })

  it("reports unsupported environments without registering", async () => {
    vi.stubGlobal("window", {})
    vi.stubGlobal("navigator", {})
    const { cacheCommunityShellRoute } = await import("./shell")

    await expect(cacheCommunityShellRoute("https://alook.test/c")).resolves.toEqual({
      ok: false,
      error: "unsupported",
    })
  })
})
