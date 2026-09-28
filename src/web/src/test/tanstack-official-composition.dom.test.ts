import { afterEach, describe, expect, it, vi } from "vitest"
import { waitFor } from "@/test/react-dom-harness"

const closeDatabase = vi.fn(async () => {})

vi.mock("@tanstack/browser-db-sqlite-persistence", () => ({
  BrowserCollectionCoordinator: class {
    dispose() {}
    getNodeId() { return "test-node" }
    isLeader() { return true }
  },
  createBrowserWASQLitePersistence: () => ({}),
  openBrowserWASQLiteOPFSDatabase: async () => ({ close: closeDatabase }),
  persistedCollectionOptions: ({
    persistence: _persistence,
    schemaVersion: _schemaVersion,
    ...options
  }: Record<string, unknown>) => options,
}))

function mountSpikeDom() {
  document.body.innerHTML = `
    <select data-testid="account"><option value="alpha">alpha</option><option value="beta">beta</option></select>
    <select data-testid="channel-select"><option value="c-alpha">c-alpha</option><option value="c-beta">c-beta</option></select>
    <button data-testid="account-switch"></button>
    <button data-testid="offline-toggle">Go offline</button>
    <button data-testid="rebuild-runtime"></button>
    <button data-testid="ws-apply"></button>
    <button data-testid="duplicate-replay"></button>
    <button data-testid="freshness-burst"></button>
    <button data-testid="revoke-scope"></button>
    <button data-testid="load-next-window"></button>
    <button data-testid="simulate-pagehide"></button>
    <button data-testid="simulate-pageshow-persisted"></button>
    <span data-testid="runtime-state"></span>
    <pre data-testid="servers-state"></pre>
    <pre data-testid="messages-window"></pre>
    <pre data-testid="event-log"></pre>
    <pre data-testid="capability-state"></pre>
  `
}

function apiResponse(rows: unknown[]) {
  return Promise.resolve(new Response(JSON.stringify({ rows }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }))
}

describe("TanStack official composition spike", () => {
  afterEach(async () => {
    document.querySelector<HTMLElement>("[data-testid='simulate-pagehide']")?.click()
    await window.__tanstackOfficialSpike?.waitForIdle()
    document.body.innerHTML = ""
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it("boots, pages an on-demand window, switches accounts, and rebuilds lifecycle state", async () => {
    mountSpikeDom()
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost")
      if (init?.method === "POST") {
        return Promise.resolve(new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }))
      }
      const account = url.pathname.includes("/beta/") ? "beta" : "alpha"
      if (url.pathname.endsWith("/servers")) {
        return apiResponse([{ id: `s-${account}`, name: account, version: 1 }])
      }
      const channelId = account === "alpha" ? "c-alpha" : "c-beta"
      const limit = Number(url.searchParams.get("limit") ?? 2)
      const offset = Number(url.searchParams.get("offset") ?? 0)
      const rows = Array.from({ length: 6 }, (_, index) => ({
        id: `m-${account}-${6 - index}`,
        channelId,
        seq: 6 - index,
        text: `${account} ${6 - index}`,
      })).slice(offset, offset + limit)
      return apiResponse(rows)
    }))

    await import("../../spikes/tanstack-official-composition/main")
    await window.__tanstackOfficialSpike.waitForIdle()
    await waitFor(() => {
      expect(window.__tanstackOfficialSpike.snapshot()).toMatchObject({
        account: "alpha",
        messages: [{ seq: 6 }, { seq: 5 }],
        servers: [{ id: "s-alpha" }],
      })
    })

    window.__tanstackOfficialSpike.applyLocalServer({
      id: "s-local",
      name: "Local",
      version: 2,
    })
    expect(window.__tanstackOfficialSpike.snapshot().servers.map((row) => row.id))
      .toContain("s-local")

    document.querySelector<HTMLElement>("[data-testid='load-next-window']")!.click()
    await window.__tanstackOfficialSpike.waitForIdle()
    expect(window.__tanstackOfficialSpike.snapshot().messages.map((row) => row.seq))
      .toEqual([6, 5, 4, 3])

    document.querySelector<HTMLElement>("[data-testid='account-switch']")!.click()
    await window.__tanstackOfficialSpike.waitForIdle()
    expect(window.__tanstackOfficialSpike.snapshot()).toMatchObject({
      account: "beta",
      servers: [{ id: "s-beta" }],
    })
    expect(closeDatabase).toHaveBeenCalled()

    document.querySelector<HTMLElement>("[data-testid='simulate-pagehide']")!.click()
    await window.__tanstackOfficialSpike.waitForIdle()
    expect(document.querySelector("[data-testid='runtime-state']"))
      .toHaveAttribute("data-state", "closed")
    document.querySelector<HTMLElement>("[data-testid='simulate-pageshow-persisted']")!.click()
    await window.__tanstackOfficialSpike.waitForIdle()
    expect(document.querySelector("[data-testid='runtime-state']"))
      .toHaveAttribute("data-state", "ready")
  })
})
