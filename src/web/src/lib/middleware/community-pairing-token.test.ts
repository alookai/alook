import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))

// Spy on every pairing-token / machine query the middleware could plausibly
// call. The whole point of `withCommunityPairingToken` is that it validates
// the `cmt_` prefix but leaves the atomic exchange to the route handler
// (`daemon/activate`). If any of these fire during middleware execution, the
// middleware has stopped being stateless.
const pairingQuerySpies = {
  claimPairingToken: vi.fn(),
  findActiveToken: vi.fn(),
  findTokenById: vi.fn(),
  createPairingToken: vi.fn(),
  createReconnectPairingToken: vi.fn(),
  touchTokenLastUsed: vi.fn(),
  revokeToken: vi.fn(),
  activateMachineCredential: vi.fn(),
  findActiveCredentialByBearer: vi.fn(),
  findCredentialByHash: vi.fn(),
}
vi.mock("@alook/shared", () => ({
  queries: {
    communityMachine: pairingQuerySpies,
  },
}))

import { withCommunityPairingToken } from "./community-pairing-token"

const handler = vi.fn(async (_req: NextRequest, ctx: any) =>
  NextResponse.json({ ok: true, ctx })
)

describe("withCommunityPairingToken", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const wrapped = withCommunityPairingToken(handler)

  it("rejects when Authorization is missing", async () => {
    const req = new NextRequest("http://localhost/x")
    const res = await wrapped(req)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "missing Authorization header" })
    expect(handler).not.toHaveBeenCalled()
  })

  it("rejects a non-Bearer prefix", async () => {
    const req = new NextRequest("http://localhost/x", {
      headers: { Authorization: "Basic cmt_abc" },
    })
    const res = await wrapped(req)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "missing Authorization header" })
    expect(handler).not.toHaveBeenCalled()
  })

  it("rejects a Bearer token whose prefix isn't `cmt_`", async () => {
    for (const bad of ["Bearer cmk_abc", "Bearer al_abc", "Bearer foo"]) {
      const req = new NextRequest("http://localhost/x", { headers: { Authorization: bad } })
      const res = await wrapped(req)
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: "invalid pairing token" })
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it("invokes the handler with the raw `cmt_` tokenId on a valid header", async () => {
    const req = new NextRequest("http://localhost/x", {
      headers: { Authorization: "Bearer cmt_pending" },
    })
    const res = await wrapped(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ctx: any }
    expect(body.ctx).toMatchObject({ rawTokenId: "cmt_pending" })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("passes through resolved async params", async () => {
    const req = new NextRequest("http://localhost/x", {
      headers: { Authorization: "Bearer cmt_ok" },
    })
    const res = await wrapped(req, { params: Promise.resolve({ id: "abc" }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ctx: any }
    expect(body.ctx).toMatchObject({ rawTokenId: "cmt_ok", params: { id: "abc" } })
  })

  it("rejects an empty tokenId after the `Bearer ` prefix", async () => {
    // Surprise: the Web platform's Headers strip trailing whitespace from
    // values, so `"Bearer "` on the wire becomes `"Bearer"` by the time the
    // middleware reads it — which fails the `startsWith("Bearer ")` guard
    // and returns "missing Authorization header". The middleware's own
    // `slice(7).trim() === ""` branch (which would answer "invalid pairing
    // token") is therefore essentially unreachable via a real HTTP header.
    // Either way, the response is a 401 with a sensible error, and the
    // handler is not invoked — which is what actually matters.
    const req = new NextRequest("http://localhost/x", {
      headers: { Authorization: "Bearer " },
    })
    const res = await wrapped(req)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "missing Authorization header" })
    expect(handler).not.toHaveBeenCalled()
  })

  it("does NOT consume the pairing token — leaves the DB exchange to the handler", async () => {
    const req = new NextRequest("http://localhost/x", {
      headers: { Authorization: "Bearer cmt_notyetclaimed" },
    })
    const res = await wrapped(req)
    expect(res.status).toBe(200)
    // The handler runs with the raw tokenId and can do whatever it wants,
    // but the middleware itself must never touch the pairing-token DB layer.
    expect(handler).toHaveBeenCalledTimes(1)
    for (const [name, spy] of Object.entries(pairingQuerySpies)) {
      expect(spy, `middleware should not have called communityMachine.${name}`).not.toHaveBeenCalled()
    }
  })
})
