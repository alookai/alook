import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  userId: undefined as string | undefined, env: { DB: {}, BETTER_AUTH_SECRET: "local-auth", NODE_ENV: "development" },
  consent: vi.fn(), owned: vi.fn(), invite: vi.fn(), record: vi.fn(), live: vi.fn(), note: vi.fn(),
}))
vi.mock("@/lib/middleware/auth", () => ({ withOptionalAuth: (handler: (req: NextRequest, ctx: unknown) => Promise<Response>) =>
  (req: NextRequest) => handler(req, { userId: mocks.userId, env: mocks.env }) }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => mocks.env.DB }))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: async () => ({ ctx: { waitUntil: () => {} } }) }))
vi.mock("@alook/shared", async original => ({ ...await original<typeof import("@alook/shared")>(), queries: {
  user: { getUserInternal: mocks.live }, billing: { getAnalyticsConsent: mocks.consent },
  productAnalytics: { getOwnedServer: mocks.owned, getInviteSource: mocks.invite, recordEvent: mocks.record, notePendingReason: mocks.note },
} }))
import { POST } from "./route"
const id = "ee27bb80-e6dc-4cc3-97d7-c7bf2f1c13d2"
function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://alook.ai/api/community/analytics/product-events", {
    method: "POST", body: JSON.stringify(body), headers: { origin: "https://alook.ai", "content-type": "application/json", ...headers },
  })
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.userId = undefined
  mocks.live.mockResolvedValue({ id: "owner", isBot: false, deletedAt: null })
  mocks.consent.mockResolvedValue(null); mocks.owned.mockResolvedValue({ id: "server" })
  mocks.invite.mockResolvedValue({ id: "invite", serverId: "server", createdBy: "creator" })
  mocks.record.mockImplementation(async (_db, input) => ({ row: { ...input, id: "event" }, inserted: true }))
})

describe("restricted browser product-event endpoint", () => {
  it("rejects oversized streamed bodies before parsing or recording", async () => {
    const req = request({ event: "login_page_view", requestId: id, extra: "x".repeat(4096) }, { "content-length": "1" })
    expect((await POST(req)).status).toBe(400)
    expect(mocks.record).not.toHaveBeenCalled()
  })
  it("rejects cross-origin and bearer callers", async () => {
    const body = { event: "login_page_view", requestId: id }
    expect((await POST(request(body, { origin: "https://other.test" }))).status).toBe(403)
    expect((await POST(request(body, { authorization: "Bearer synthetic" }))).status).toBe(403)
    expect(mocks.record).not.toHaveBeenCalled()
  })
  it("rejects missing and malformed Origin before recording an event", async () => {
    for (const origin of [undefined, "not a URL"]) {
      const req = request({ event: "login_page_view", requestId: id })
      if (origin === undefined) req.headers.delete("origin")
      else req.headers.set("origin", origin)
      expect((await POST(req)).status).toBe(403)
    }
    expect(mocks.record).not.toHaveBeenCalled()
  })
  it("rejects forged success, arbitrary private events, extra dimensions and invalid nonce", async () => {
    for (const body of [
      { event: "sign_in_success", requestId: id }, { event: "page_view", requestId: id },
      { event: "login_page_view", requestId: id, email: "private@example.test" },
      { event: "login_page_view", requestId: "bad" }, { event: "landing_cta_clicked", requestId: id, ctaName: "private-channel-name" },
    ]) expect((await POST(request(body))).status).toBe(400)
    expect(mocks.record).not.toHaveBeenCalled()
  })
  it("does not degrade a failed cookie session into an anonymous visit", async () => {
    expect((await POST(request({ event: "invitation_link_visit", requestId: id, token: "token" }, { cookie: "better-auth.session_token=synthetic" }))).status).toBe(503)
    expect(mocks.record).not.toHaveBeenCalled()
  })
  it("excludes live bot or deleted users even if optional session resolution accepted them", async () => {
    mocks.userId = "owner"
    for (const live of [{ isBot: true, deletedAt: null }, { isBot: false, deletedAt: "deleted" }]) {
      mocks.live.mockResolvedValue(live)
      expect((await POST(request({ event: "login_page_view", requestId: id }))).status).toBe(401)
    }
    expect(mocks.record).not.toHaveBeenCalled()
  })
  it("preserves anonymous explicit denial without writing identity cookies or ledger", async () => {
    const response = await POST(request({ event: "login_page_view", requestId: id }, { cookie: "alook_analytics_consent=v1.denied" }))
    expect(await response.json()).toEqual({ recorded: false })
    expect(response.headers.getSetCookie()).toEqual([])
    expect(mocks.record).not.toHaveBeenCalled()
  })
  it("requires human authentication and server ownership for Enter", async () => {
    const body = { event: "onboarding_enter_clicked", requestId: id, serverId: "server" }
    expect((await POST(request(body))).status).toBe(401)
    mocks.userId = "owner"; mocks.owned.mockResolvedValue(null)
    expect((await POST(request(body))).status).toBe(404)
    expect(mocks.owned).toHaveBeenCalledWith(mocks.env.DB, "owner", "server")
  })
  it("records the Enter click with a server-scoped durable dedupe key before navigation", async () => {
    mocks.userId = "owner"
    const response = await POST(request({ event: "onboarding_enter_clicked", requestId: id, serverId: "server" }))
    expect(response.status).toBe(200)
    expect(mocks.record).toHaveBeenCalledWith(mocks.env.DB, expect.objectContaining({ eventName: "onboarding_enter_clicked", dedupeKey: "onboarding-enter:owner:server" }))
    expect(response.headers.getSetCookie().some(cookie => cookie.startsWith("_ga="))).toBe(true)
  })
  it("counts known invitation page entries, including expired sources, without token payload", async () => {
    await POST(request({ event: "invitation_link_visit", requestId: id, token: "private-token" }))
    expect(mocks.record).toHaveBeenCalledWith(mocks.env.DB, expect.objectContaining({ eventName: "invitation_link_visit", sourceId: "invite", dedupeKey: `invite-visit:invite:${id}`, actorUserId: null }))
    expect(JSON.stringify(mocks.record.mock.calls)).not.toContain("private-token")
  })
  it("excludes invalid sources and signed inviter self-preview", async () => {
    mocks.invite.mockResolvedValueOnce(null)
    expect(await (await POST(request({ event: "invitation_link_visit", requestId: id, token: "invalid" }))).json()).toEqual({ recorded: false })
    mocks.userId = "creator"
    expect(await (await POST(request({ event: "invitation_link_visit", requestId: id, token: "valid" }))).json()).toEqual({ recorded: false })
    expect(mocks.record).not.toHaveBeenCalled()
  })
  it("records only bounded public entry and failure dimensions", async () => {
    await POST(request({ event: "landing_cta_clicked", requestId: id, ctaName: "get_started" }))
    expect(mocks.record).toHaveBeenLastCalledWith(mocks.env.DB, expect.objectContaining({ eventName: "landing_cta_clicked", ctaName: "get_started" }))
    await POST(request({ event: "sign_in_failed", requestId: id, method: "email_otp", failureStage: "verify_code" }))
    expect(mocks.record).toHaveBeenLastCalledWith(mocks.env.DB, expect.objectContaining({ eventName: "sign_in_failed", method: "email_otp", failureStage: "verify_code" }))
  })
})
