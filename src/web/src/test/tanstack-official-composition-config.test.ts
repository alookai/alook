import type { IncomingMessage, ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import playwrightConfig, {
  spikePlaywrightConfig,
} from "../../spikes/tanstack-official-composition/playwright.config"
import {
  createSpikeApiPlugin,
} from "../../spikes/tanstack-official-composition/vite.config"
import type {
  SpikeSnapshot,
  SpikeTestApi,
} from "../../spikes/tanstack-official-composition/test-api"

type Middleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void | Promise<void>

function request(method: string, url: string, payload?: unknown): IncomingMessage {
  const stream = Readable.from(payload === undefined ? [] : [JSON.stringify(payload)])
  return Object.assign(stream, { method, url }) as IncomingMessage
}

function createApiHarness() {
  let middleware: Middleware | undefined
  const wsSend = vi.fn()
  createSpikeApiPlugin().configureServer({
    middlewares: { use: (handler) => { middleware = handler } },
    ws: { send: wsSend },
  })
  if (!middleware) throw new Error("spike middleware was not registered")

  return {
    wsSend,
    async dispatch(method: string, url: string, payload?: unknown) {
      let responseBody = ""
      const headers = new Map<string, unknown>()
      const next = vi.fn()
      const response = {
        statusCode: 200,
        setHeader(name: string, value: unknown) {
          headers.set(name, value)
          return this
        },
        end(value?: unknown) {
          responseBody = value === undefined ? "" : String(value)
          return this
        },
      } as unknown as ServerResponse
      await middleware(request(method, url, payload), response, next)
      return {
        body: responseBody ? JSON.parse(responseBody) as unknown : undefined,
        headers,
        next,
        status: response.statusCode,
      }
    },
  }
}

describe("TanStack official composition spike configuration", () => {
  it("exports the exact Playwright contract without starting its web server", () => {
    expect(playwrightConfig).toBe(spikePlaywrightConfig)
    expect(playwrightConfig).toMatchObject({
      testDir: ".",
      testMatch: "official-composition.spec.ts",
      timeout: 45_000,
      fullyParallel: false,
      workers: 1,
      use: {
        baseURL: "http://127.0.0.1:4177",
        browserName: "chromium",
        headless: true,
      },
      webServer: {
        command: expect.stringContaining("spikes/tanstack-official-composition/vite.config.ts"),
        cwd: process.cwd(),
        port: 4177,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
    })
  })

  it("proves the type-only browser API through an invoked runtime contract", async () => {
    const snapshot: SpikeSnapshot = {
      account: "alpha",
      capabilityGap: "none",
      generation: 1,
      logs: [],
      messages: [],
      offline: false,
      servers: [],
    }
    const api = {
      applyLocalServer: vi.fn(),
      snapshot: vi.fn(() => snapshot),
      rebuild: vi.fn(async () => {}),
      waitForIdle: vi.fn(async () => {}),
    } satisfies SpikeTestApi
    const row = { id: "s-local", name: "Local", version: 2 }

    api.applyLocalServer(row)
    await api.rebuild()
    await api.waitForIdle()

    expect(api.applyLocalServer).toHaveBeenCalledWith(row)
    expect(api.snapshot()).toBe(snapshot)
    expect(api.rebuild).toHaveBeenCalledOnce()
    expect(api.waitForIdle).toHaveBeenCalledOnce()
  })

  it("executes successful fake API mutation, websocket, and paging behavior in memory", async () => {
    const api = createApiHarness()

    const initial = await api.dispatch("GET", "/spike-api/accounts/alpha/servers")
    expect(initial).toMatchObject({
      status: 200,
      body: { rows: [
        { id: "s-alpha", name: "Alpha", version: 1 },
        { id: "s-second", name: "Second", version: 1 },
      ] },
    })
    expect(initial.headers.get("content-type")).toBe("application/json")

    await api.dispatch("POST", "/spike-api/control/mutate", {
      account: "alpha",
      server: { id: "s-alpha", name: "Alpha 2", version: 2 },
    })
    expect(await api.dispatch("GET", "/spike-api/accounts/alpha/servers"))
      .toMatchObject({ body: { rows: expect.arrayContaining([
        { id: "s-alpha", name: "Alpha 2", version: 2 },
      ]) } })

    expect(await api.dispatch(
      "GET",
      "/spike-api/accounts/alpha/channels/c-alpha/messages?offset=1&limit=2",
    )).toMatchObject({ body: { rows: [{ seq: 5 }, { seq: 4 }] } })
    expect(await api.dispatch(
      "GET",
      "/spike-api/accounts/alpha/channels/c-alpha/messages",
    )).toMatchObject({ body: { rows: [
      { seq: 6 }, { seq: 5 }, { seq: 4 }, { seq: 3 }, { seq: 2 }, { seq: 1 },
    ] } })

    const upsert = {
      type: "upsert" as const,
      account: "alpha",
      servers: [{ id: "s-live", name: "Live", version: 1 }],
      messages: [{ id: "m-live", channelId: "c-live", seq: 7, text: "live" }],
    }
    expect(await api.dispatch("POST", "/spike-api/control/ws", upsert))
      .toMatchObject({ status: 200, body: { ok: true, event: upsert } })
    expect(api.wsSend).toHaveBeenLastCalledWith({
      type: "custom",
      event: "spike:ws",
      data: upsert,
    })

    const revoke = {
      type: "revoke" as const,
      account: "alpha",
      serverId: "s-live",
      channelIds: ["c-live"],
    }
    await api.dispatch("POST", "/spike-api/control/ws", revoke)
    expect(await api.dispatch("GET", "/spike-api/accounts/alpha/servers"))
      .toMatchObject({ body: { rows: expect.not.arrayContaining([
        expect.objectContaining({ id: "s-live" }),
      ]) } })

    const freshness = await api.dispatch("POST", "/spike-api/control/freshness-burst", {
      account: "alpha",
      server: { id: "s-fresh", name: "Fresh", version: 1 },
    })
    expect(freshness).toMatchObject({
      status: 200,
      body: { ok: true, reasons: ["reconnect", "gap", "unknown"] },
    })
    expect(api.wsSend.mock.calls.slice(-3).map(([payload]) => payload.data.reason))
      .toEqual(["reconnect", "gap", "unknown"])

    const explicitFreshness = { type: "freshness" as const, account: "alpha", reason: "gap" as const }
    await api.dispatch("POST", "/spike-api/control/ws", explicitFreshness)
    expect(api.wsSend).toHaveBeenLastCalledWith({
      type: "custom",
      event: "spike:ws",
      data: explicitFreshness,
    })

    expect(await api.dispatch("GET", "/spike-api/control/requests"))
      .toMatchObject({ body: { requests: expect.arrayContaining([
        expect.objectContaining({ method: "POST", path: "/spike-api/control/ws" }),
        expect.objectContaining({ path: "/spike-api/accounts/alpha/servers", search: "" }),
      ]) } })
    expect(await api.dispatch("POST", "/spike-api/control/reset"))
      .toMatchObject({ status: 200, body: { ok: true } })
    expect(await api.dispatch("GET", "/spike-api/accounts/alpha/servers"))
      .toMatchObject({ body: { rows: expect.arrayContaining([
        { id: "s-alpha", name: "Alpha", version: 1 },
      ]) } })
  })

  it("fails closed for unknown accounts and falls through outside the fake API", async () => {
    const api = createApiHarness()
    const server = { id: "s", name: "Server", version: 1 }
    const unknownRoutes: Array<[string, string, unknown?]> = [
      ["POST", "/spike-api/control/mutate", { account: "missing", server }],
      ["POST", "/spike-api/control/freshness-burst", { account: "missing", server }],
      ["POST", "/spike-api/control/ws", {
        type: "upsert", account: "missing", servers: [server], messages: [],
      }],
      ["GET", "/spike-api/accounts/missing/servers"],
      ["GET", "/spike-api/accounts/missing/channels/c/messages"],
    ]
    for (const [method, url, payload] of unknownRoutes) {
      expect(await api.dispatch(method, url, payload))
        .toMatchObject({ status: 404, body: { error: "unknown account" } })
    }

    expect(await api.dispatch("GET", "/spike-api/not-found"))
      .toMatchObject({ status: 404, body: { error: "not found" } })
    const outside = await api.dispatch("GET", "/not-the-spike")
    expect(outside.next).toHaveBeenCalledOnce()
    expect(outside.body).toBeUndefined()
  })
})
