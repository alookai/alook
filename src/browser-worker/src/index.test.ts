import { describe, it, expect, vi, beforeEach } from "vitest"
import { createMockDO, createMockFetcher } from "./__mocks__/cf"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}))

vi.mock("@cloudflare/puppeteer", () => ({
  default: { launch: vi.fn() },
}))

let nanoidCounter = 0
vi.mock("nanoid", () => ({
  nanoid: () => `mock-session-${++nanoidCounter}`,
}))

import handler from "./index"
import type { MeetingBotEnv } from "./types"

function createEnv(overrides?: { doResponse?: Response }) {
  const { meetingBot, doFetch, mockIdFromName } = createMockDO()
  const { fetcher } = createMockFetcher()

  if (overrides?.doResponse) {
    doFetch.mockResolvedValue(overrides.doResponse)
  }

  const { fetcher: webFetcher } = createMockFetcher()
  const env: MeetingBotEnv = {
    BROWSER: {} as any,
    MEETING_BOT: meetingBot,
    EMAIL_SERVICE: fetcher,
    WEB_SERVICE: webFetcher,
  }

  return { env, doFetch, mockIdFromName }
}

beforeEach(() => {
  nanoidCounter = 0
  vi.clearAllMocks()
})

describe("POST /meeting/join", () => {
  function makeJoinRequest(body: Record<string, unknown>) {
    return new Request("http://localhost/meeting/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  it("returns 200 with session ID on valid request", async () => {
    const { env, doFetch } = createEnv({
      doResponse: Response.json({ ok: true, status: "recording", startedAt: "2026-04-28T00:00:00Z" }),
    })

    const res = await handler.fetch(
      makeJoinRequest({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        participants: ["alice@example.com"],
      }),
      env,
    )

    expect(res.status).toBe(200)
    const json = await res.json() as { sessionId: string; ok: boolean }
    expect(json.ok).toBe(true)
    expect(json.sessionId).toBe("mock-session-1")
  })

  it("returns 400 when meetingUrl is missing", async () => {
    const { env } = createEnv()

    const res = await handler.fetch(
      makeJoinRequest({ participants: ["alice@example.com"] }),
      env,
    )

    expect(res.status).toBe(400)
    const json = await res.json() as { error: string }
    expect(json.error).toBe("meetingUrl is required")
  })

  it("returns 400 for invalid Google Meet URL format", async () => {
    const { env } = createEnv()

    const res = await handler.fetch(
      makeJoinRequest({ meetingUrl: "https://zoom.us/j/123456" }),
      env,
    )

    expect(res.status).toBe(400)
    const json = await res.json() as { error: string }
    expect(json.error).toBe("invalid Google Meet URL format")
  })

  it("forwards meetingUrl and participants to DO", async () => {
    const { env, doFetch } = createEnv()

    await handler.fetch(
      makeJoinRequest({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        participants: ["alice@example.com", "bob@example.com"],
      }),
      env,
    )

    expect(doFetch).toHaveBeenCalledOnce()
    const [req] = doFetch.mock.calls[0] as [Request]
    const body = await req.json() as { meetingUrl: string; participants: string[] }
    expect(body.meetingUrl).toBe("https://meet.google.com/abc-defg-hij")
    expect(body.participants).toEqual(["alice@example.com", "bob@example.com"])
  })

  it("defaults participants to empty array when not provided", async () => {
    const { env, doFetch } = createEnv()

    await handler.fetch(
      makeJoinRequest({ meetingUrl: "https://meet.google.com/abc-defg-hij" }),
      env,
    )

    const [req] = doFetch.mock.calls[0] as [Request]
    const body = await req.json() as { participants: string[] }
    expect(body.participants).toEqual([])
  })

  it("propagates DO error response", async () => {
    const { env } = createEnv({
      doResponse: new Response(JSON.stringify({ error: "browser launch failed", status: "failed" }), { status: 500 }),
    })

    const res = await handler.fetch(
      makeJoinRequest({ meetingUrl: "https://meet.google.com/abc-defg-hij" }),
      env,
    )

    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).toBe("browser launch failed")
  })
})

describe("GET /meeting/:id/status", () => {
  it("returns session state from DO", async () => {
    const { env, doFetch } = createEnv({
      doResponse: Response.json({
        status: "recording",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        participants: ["alice@example.com"],
        transcriptLength: 5,
        error: null,
      }),
    })

    const res = await handler.fetch(
      new Request("http://localhost/meeting/session-123/status", { method: "GET" }),
      env,
    )

    expect(res.status).toBe(200)
    const json = await res.json() as { status: string; transcriptLength: number }
    expect(json.status).toBe("recording")
    expect(json.transcriptLength).toBe(5)
  })

  it("forwards request to correct DO name", async () => {
    const { env, mockIdFromName } = createEnv()

    await handler.fetch(
      new Request("http://localhost/meeting/my-session-id/status", { method: "GET" }),
      env,
    )

    expect(mockIdFromName).toHaveBeenCalledWith("my-session-id")
  })
})

describe("POST /meeting/:id/stop", () => {
  it("triggers session termination via DO", async () => {
    const { env, doFetch } = createEnv({
      doResponse: Response.json({
        ok: true,
        status: "completed",
        transcript: "[00:00:05] Alice:\nHello",
        entryCount: 1,
      }),
    })

    const res = await handler.fetch(
      new Request("http://localhost/meeting/session-123/stop", { method: "POST" }),
      env,
    )

    expect(res.status).toBe(200)
    const json = await res.json() as { status: string; transcript: string }
    expect(json.status).toBe("completed")
    expect(json.transcript).toContain("Alice")
  })

  it("forwards stop request to DO endpoint", async () => {
    const { env, doFetch } = createEnv()

    await handler.fetch(
      new Request("http://localhost/meeting/xyz-session/stop", { method: "POST" }),
      env,
    )

    expect(doFetch).toHaveBeenCalledOnce()
    const [req] = doFetch.mock.calls[0] as [Request]
    expect(new URL(req.url).pathname).toBe("/stop")
    expect(req.method).toBe("POST")
  })
})

describe("fetch() routing", () => {
  it("returns 404 for unknown paths", async () => {
    const { env } = createEnv()

    const res = await handler.fetch(
      new Request("http://localhost/unknown", { method: "POST" }),
      env,
    )

    expect(res.status).toBe(404)
  })

  it("returns 404 for GET on non-status routes", async () => {
    const { env } = createEnv()

    const res = await handler.fetch(
      new Request("http://localhost/meeting/join", { method: "GET" }),
      env,
    )

    expect(res.status).toBe(404)
  })

  it("returns 405 for unsupported methods", async () => {
    const { env } = createEnv()

    const res = await handler.fetch(
      new Request("http://localhost/meeting/join", { method: "DELETE" }),
      env,
    )

    expect(res.status).toBe(405)
  })
})
