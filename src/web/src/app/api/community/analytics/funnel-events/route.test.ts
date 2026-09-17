import { NextRequest } from "next/server"
import { describe, expect, it, vi } from "vitest"

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

describe("POST /api/community/analytics/funnel-events", () => {
  it("claims only the authenticated account and disables caching", async () => {
    mocks.claimPendingEvents.mockResolvedValueOnce([
      { event: "runtime_connected", surface: "community", connection_type: "local_daemon" },
    ])

    const response = await POST(new NextRequest(
      "https://alook.ai/api/community/analytics/funnel-events",
      { method: "POST", headers: { Origin: "https://alook.ai" } },
    ))

    expect(mocks.claimPendingEvents).toHaveBeenCalledWith(mocks.db, "session-user")
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(await response.json()).toEqual({ events: [
      { event: "runtime_connected", surface: "community", connection_type: "local_daemon" },
    ] })
  })
})
