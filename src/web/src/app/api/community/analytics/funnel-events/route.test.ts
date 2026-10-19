import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  db: { primary: true },
  claimPendingEvents: vi.fn(),
  withCookieHumanAuth: vi.fn(
    (handler: (req: NextRequest, ctx: Record<string, any>) => Promise<Response>) =>
      async (req: NextRequest) => handler(req, {
        env: { DB: {} },
        userId: "session-user",
      }),
  ),
}))

vi.mock("@/lib/db", () => ({ getPrimaryDb: () => mocks.db }))
vi.mock("@alook/shared", () => ({
  queries: {
    communityFunnelAnalytics: {
      claimPendingEvents: (...args: unknown[]) => mocks.claimPendingEvents(...args),
    },
  },
}))
vi.mock("@/lib/middleware/auth", () => ({
  withCookieHumanAuth: mocks.withCookieHumanAuth,
}))

import { POST } from "./route"

beforeEach(() => vi.clearAllMocks())

describe("POST /api/community/analytics/funnel-events", () => {
  it("claims only the authenticated account and disables caching", async () => {
    mocks.claimPendingEvents.mockResolvedValueOnce([
      { event: "runtime_connected", surface: "community", connection_type: "local_daemon" },
    ])

    const response = await POST(new NextRequest(
      "https://alook.ai/api/community/analytics/funnel-events",
      { method: "POST", headers: { Origin: "https://alook.ai" } },
    ))

    expect(mocks.claimPendingEvents).toHaveBeenCalledWith(mocks.db, "session-user", "legacy")
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(await response.json()).toEqual({ events: [
      { event: "runtime_connected", surface: "community", connection_type: "local_daemon" },
    ] })
  })
})

it("claims only joins for the authenticated inviter when consent is not denied", async () => {
  mocks.claimPendingEvents.mockResolvedValueOnce([{ event: "invited_human_joined", surface: "community" }])
  const response = await POST(new NextRequest("https://alook.ai/api/community/analytics/funnel-events?event=invited_human_joined", { method: "POST" }))
  expect(mocks.claimPendingEvents).toHaveBeenLastCalledWith(mocks.db, "session-user", "invited_human_joined")
  expect(await response.json()).toEqual({ events: [{ event: "invited_human_joined", surface: "community" }] })
})

it("does not consume joins for a denied cookie", async () => {
  mocks.claimPendingEvents.mockClear()
  const response = await POST(new NextRequest("https://alook.ai/api/community/analytics/funnel-events?event=invited_human_joined", {
    method: "POST", headers: { Cookie: "alook_analytics_consent=v1.denied" },
  }))
  expect(mocks.claimPendingEvents).not.toHaveBeenCalled()
  expect(await response.json()).toEqual({ events: [] })
  expect(response.headers.get("Cache-Control")).toBe("no-store")
})

it("rejects arbitrary claim categories before the database write", async () => {
  mocks.claimPendingEvents.mockClear()
  const response = await POST(new NextRequest("https://alook.ai/api/community/analytics/funnel-events?event=all", { method: "POST" }))
  expect(response.status).toBe(400)
  expect(mocks.claimPendingEvents).not.toHaveBeenCalled()
})
