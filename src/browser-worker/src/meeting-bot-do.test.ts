import { describe, it, expect, vi, beforeEach } from "vitest"
import { createMockBrowser, createMockFetcher } from "./__mocks__/cf"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: any
    env: any
    constructor(ctx: any, env: any) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

const { browser: mockBrowser, page: mockPage } = createMockBrowser()
const mockLaunch = vi.fn().mockResolvedValue(mockBrowser)

const mockEndpointURLString = vi.fn().mockReturnValue("ws://mock-endpoint")

vi.mock("@cloudflare/playwright", () => ({
  chromium: { connect: (...args: any[]) => mockLaunch(...args) },
  endpointURLString: (...args: any[]) => mockEndpointURLString(...args),
}))

import { MeetingBotDO } from "./meeting-bot-do"
import type { MeetingBotEnv } from "./types"

function createDO() {
  const capturedPromises: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { capturedPromises.push(p) },
    storage: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
  }
  const { fetcher: webFetcher, fetch: webFetch } = createMockFetcher()
  const env: MeetingBotEnv = {
    BROWSER: {} as any,
    MEETING_BOT: {} as any,
    WEB_SERVICE: webFetcher,
  }

  const doInstance = new MeetingBotDO(ctx as any, env)
  return { doInstance, ctx, env, webFetch, capturedPromises }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  mockLaunch.mockResolvedValue(mockBrowser)
  mockPage.evaluate.mockResolvedValue([])
  mockPage.$.mockResolvedValue({ click: vi.fn() })
  mockPage.goto.mockResolvedValue(undefined)
  mockPage.close.mockResolvedValue(undefined)
  mockBrowser.close.mockResolvedValue(undefined)
  mockBrowser.newPage.mockResolvedValue(mockPage)
})

describe("MeetingBotDO", () => {
  describe("POST /start", () => {
    it("starts browser session on start request", async () => {
      const { doInstance, capturedPromises } = createDO()

      const res = await doInstance.fetch(new Request("http://internal/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meetingUrl: "https://meet.google.com/abc-defg-hij",
          participants: ["alice@example.com"],
        }),
      }))

      expect(res.status).toBe(200)
      const json = await res.json() as { ok: boolean; status: string }
      expect(json.ok).toBe(true)
      expect(json.status).toBe("recording")
      expect(mockLaunch).toHaveBeenCalledOnce()
      expect(mockBrowser.newPage).toHaveBeenCalledOnce()
      expect(capturedPromises).toHaveLength(1)
    })

    it("returns 400 when meetingUrl is missing", async () => {
      const { doInstance } = createDO()

      const res = await doInstance.fetch(new Request("http://internal/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }))

      expect(res.status).toBe(400)
      const json = await res.json() as { error: string }
      expect(json.error).toBe("meetingUrl is required")
    })

    it("handles browser launch failure gracefully", async () => {
      mockLaunch.mockRejectedValueOnce(new Error("browser quota exceeded"))
      const { doInstance } = createDO()

      const res = await doInstance.fetch(new Request("http://internal/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meetingUrl: "https://meet.google.com/abc-defg-hij",
        }),
      }))

      expect(res.status).toBe(500)
      const json = await res.json() as { error: string; status: string }
      expect(json.status).toBe("failed")
      expect(json.error).toBe("browser quota exceeded")
    })
  })

  describe("GET /status", () => {
    it("returns current status", async () => {
      const { doInstance } = createDO()

      const res = await doInstance.fetch(new Request("http://internal/status", {
        method: "GET",
      }))

      expect(res.status).toBe(200)
      const json = await res.json() as { status: string }
      expect(json.status).toBe("starting")
    })

    it("returns status with meeting info after starting", async () => {
      const { doInstance } = createDO()

      await doInstance.fetch(new Request("http://internal/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meetingUrl: "https://meet.google.com/abc-defg-hij",
          participants: ["alice@example.com"],
        }),
      }))

      const res = await doInstance.fetch(new Request("http://internal/status", { method: "GET" }))
      const json = await res.json() as { status: string; meetingUrl: string; participants: string[] }

      expect(json.status).toBe("recording")
      expect(json.meetingUrl).toBe("https://meet.google.com/abc-defg-hij")
      expect(json.participants).toEqual(["alice@example.com"])
    })
  })

  describe("POST /stop", () => {
    async function startAndStop(doInstance: MeetingBotDO) {
      vi.useFakeTimers()

      // Start the session — joinMeeting has delay(3000), enableCaptions has delay(1000)
      const startPromise = doInstance.fetch(new Request("http://internal/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meetingUrl: "https://meet.google.com/abc-defg-hij",
        }),
      }))
      await vi.advanceTimersByTimeAsync(5000)
      await startPromise

      // Stop — leaveMeeting has delay(2000)
      const stopPromise = doInstance.fetch(new Request("http://internal/stop", { method: "POST" }))
      await vi.advanceTimersByTimeAsync(3000)
      const res = await stopPromise

      vi.useRealTimers()
      return res
    }

    it("stops session and returns transcript", async () => {
      const { doInstance } = createDO()
      const res = await startAndStop(doInstance)

      const json = await res.json() as { ok: boolean; status: string }
      expect(json.ok).toBe(true)
      expect(json.status).toBe("completed")
    })

    it("triggers cleanup of browser resources", async () => {
      const { doInstance } = createDO()
      await startAndStop(doInstance)

      expect(mockPage.close).toHaveBeenCalled()
      expect(mockBrowser.close).toHaveBeenCalled()
    })
  })

  describe("unknown routes", () => {
    it("returns 404 for unknown paths", async () => {
      const { doInstance } = createDO()

      const res = await doInstance.fetch(new Request("http://internal/unknown", { method: "GET" }))
      expect(res.status).toBe(404)
    })
  })
})
