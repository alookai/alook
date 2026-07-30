import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

// The unified actor is a thin router over two collaborators:
//   - resolveBotActor (crk_ → bot identity) — the bot path;
//   - withAuth (session/al_ → human AuthContext) — the human path, delegated
//     VERBATIM so we don't re-test its internals here.
// We mock both so this file tests only the routing + actor-shape adaptation +
// the crk_-never-falls-through invariant. Behavior of each collaborator is
// covered by their own suites (community-agent-runner-auth.test.ts, auth.test.ts).

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockResolveBotActor = vi.fn()
vi.mock("./community-agent-runner-auth", () => ({
  resolveBotActor: (...a: unknown[]) => mockResolveBotActor(...a),
}))

// withAuth is a higher-order wrapper: withAuth(handler) → (req, ctx) => ….
// Our mock invokes the wrapped handler with a canned human AuthContext so we
// can assert the actor adaptation. `mockHumanCtx` lets a test simulate an
// auth failure by having the mock short-circuit instead of calling through.
let mockHumanCtx: Record<string, unknown> | null = {
  env: { DB: {} },
  userId: "human_1",
  email: "h@t.com",
  workspaceId: "ws_1",
  user: { isBot: false },
}
vi.mock("./auth", () => ({
  withAuth: (handler: (r: NextRequest, ctx: any) => Promise<Response>) =>
    async (req: NextRequest, _ctx?: unknown) => {
      if (!mockHumanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
      return handler(req, { ...mockHumanCtx, params: undefined })
    },
}))

import { withCommunityActor, rejectBot, requireBot, type CommunityActor } from "./community-actor"

const handler = vi.fn(async (_req: NextRequest, ctx: any) => NextResponse.json({ ok: true, actor: ctx.actor }))

const bearer = (v: string) => new NextRequest("http://localhost/x", { headers: { Authorization: v } })

describe("withCommunityActor", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHumanCtx = { env: { DB: {} }, userId: "human_1", email: "h@t.com", workspaceId: "ws_1", user: { isBot: false } }
  })

  const wrapped = withCommunityActor(handler)

  it("resolves a crk_ bearer to a bot actor (kind:bot, userId=botUserId)", async () => {
    mockResolveBotActor.mockResolvedValue({
      kind: "bot",
      actor: { botUserId: "bot_1", ownerUserId: "owner_1", machineId: "m_1" },
    })
    const res = await wrapped(bearer("Bearer crk_abc"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { actor: CommunityActor }
    expect(body.actor).toEqual({ kind: "bot", userId: "bot_1", ownerUserId: "owner_1", machineId: "m_1" })
  })

  it("a crk_ bearer that fails to resolve returns the error response and NEVER falls through to human", async () => {
    mockResolveBotActor.mockResolvedValue({
      kind: "error",
      response: NextResponse.json({ error: "runner key revoked or unknown" }, { status: 401 }),
    })
    const res = await wrapped(bearer("Bearer crk_bad"))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "runner key revoked or unknown" })
    // The human path must not have run — handler saw no human actor.
    expect(handler).not.toHaveBeenCalled()
  })

  it("routes a session request (no bearer) to the human path via withAuth", async () => {
    const res = await wrapped(new NextRequest("http://localhost/x"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { actor: CommunityActor }
    expect(body.actor).toEqual({ kind: "human", userId: "human_1", email: "h@t.com", workspaceId: "ws_1" })
    // Bot resolution must not have been attempted for a non-crk_ request.
    expect(mockResolveBotActor).not.toHaveBeenCalled()
  })

  it("routes an al_ machine-token bearer to the human path (not the bot path)", async () => {
    const res = await wrapped(bearer("Bearer al_machinetoken"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { actor: CommunityActor }
    expect(body.actor.kind).toBe("human")
    expect(mockResolveBotActor).not.toHaveBeenCalled()
  })

  it("propagates a human auth failure from withAuth unchanged", async () => {
    mockHumanCtx = null // simulate withAuth 401
    const res = await wrapped(new NextRequest("http://localhost/x"))
    expect(res.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe("rejectBot / requireBot guards", () => {
  const human: CommunityActor = { kind: "human", userId: "h", email: "e" }
  const bot: CommunityActor = { kind: "bot", userId: "b", ownerUserId: "o", machineId: "m" }

  it("rejectBot: 403 for a bot, null for a human", () => {
    expect(rejectBot(bot)?.status).toBe(403)
    expect(rejectBot(human)).toBeNull()
  })

  it("requireBot: 403 for a human; narrows to the bot actor for a bot", () => {
    const humanGate = requireBot(human)
    expect(humanGate.ok).toBe(false)
    if (!humanGate.ok) expect(humanGate.response.status).toBe(403)

    const botGate = requireBot(bot)
    expect(botGate.ok).toBe(true)
    if (botGate.ok) expect(botGate.bot).toEqual({ kind: "bot", userId: "b", ownerUserId: "o", machineId: "m" })
  })
})
