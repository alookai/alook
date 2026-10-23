import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({ actor: { kind: "bot", userId: "requester", ownerUserId: "owner", machineId: "machine", isActive: true } as Record<string, unknown>, submit: vi.fn(), get: vi.fn(), decide: vi.fn(), dispatch: vi.fn(), complete: vi.fn(), broadcast: vi.fn() }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({}) }))
vi.mock("@/lib/middleware/community-actor", async () => {
  const actual = await vi.importActual<typeof import("@/lib/middleware/community-actor")>("@/lib/middleware/community-actor")
  return { ...actual, withCommunityActor: (handler: (req: NextRequest, context: any) => unknown) => (req: NextRequest) => handler(req, { env: { DB: {} }, actor: mocks.actor, params: { id: "request" } }) }
})
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: { ...actual.queries, user: { ...actual.queries.user, getUserPublic: async () => ({ name: "Owner", discriminator: "0001" }) }, communityBotCreation: { ...actual.queries.communityBotCreation, submitCreationRequest: (...args: unknown[]) => mocks.submit(...args), getCreationRequest: (...args: unknown[]) => mocks.get(...args), decideCreationRequest: (...args: unknown[]) => mocks.decide(...args) } } }
})
vi.mock("@/lib/community/message-dispatcher", () => ({ dispatchCommittedMessage: (...args: unknown[]) => mocks.dispatch(...args) }))
vi.mock("@/lib/community/fanout", () => ({ broadcastToUserSafe: (...args: unknown[]) => mocks.broadcast(...args) }))
vi.mock("@/lib/community/bot-creation.server", async () => ({ ...await vi.importActual<typeof import("@/lib/community/bot-creation.server")>("@/lib/community/bot-creation.server"), completeBotCreation: (...args: unknown[]) => mocks.complete(...args) }))
import { POST } from "./route"
import { PATCH } from "./[id]/route"
import { BotCreationError } from "@alook/shared"

const item = { itemId: "item", name: "Reviewer", description: "Review sources", reason: "Independent review", machineId: "machine", machineName: "Work Mac", backendId: "codex", model: "custom/model", reasoningEffort: null, createdBot: null }
const row = { id: "request", requesterId: "requester", ownerId: "owner", channelId: "dm", messageId: "card", status: "pending" as const, bots: [item], createdAt: "2026-10-22T00:00:00.000Z", resolvedAt: null, decisionNonce: null }
const proposal = { name: "Reviewer", description: "Review sources", reason: "Independent review", machineId: "machine", backendId: "codex", model: "custom/model" }
const request = (body: unknown, method = "POST") => new NextRequest("http://local/api/community/bots/creation-requests", { method, body: JSON.stringify(body) })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.actor = { kind: "bot", userId: "requester", ownerUserId: "owner", machineId: "machine", isActive: true }
  mocks.submit.mockResolvedValue({ row, isNew: true })
  mocks.get.mockResolvedValue(row)
})
describe("bot creation request API authorization and envelopes", () => {
  it("returns a typed submission failure without dispatching a card", async () => {
    mocks.submit.mockRejectedValueOnce(new BotCreationError("MACHINE_OFFLINE", "Target machine is offline", 409, { machineId: "machine", itemIndex: 1 }))
    const response = await POST(request({ requestId: "request", bots: [proposal] }))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "Target machine is offline", code: "MACHINE_OFFLINE", machineId: "machine", itemIndex: 1 })
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
  it("propagates unexpected decision failures without publishing an approval", async () => {
    mocks.actor = { kind: "human", userId: "owner", isBot: false }
    mocks.decide.mockRejectedValueOnce(new Error("decision storage unavailable"))
    await expect(PATCH(request({ decision: "approve" }, "PATCH"))).rejects.toThrow("decision storage unavailable")
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })
  it("derives both identities from bot authentication and dispatches exactly one committed card", async () => {
    const response = await POST(request({ requestId: "request", bots: [proposal] }))
    expect(response.status).toBe(201)
    expect(mocks.submit).toHaveBeenCalledWith(expect.anything(), "owner", "requester", { requestId: "request", bots: [proposal] })
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.anything(), "card")
    expect(await response.json()).toMatchObject({ status: "pending", count: 1, cardMessageId: "card", dmRef: "/.dm/Owner#0001" })
    mocks.submit.mockResolvedValue({ row, isNew: false })
    await POST(request({ requestId: "request", bots: [proposal] }))
    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
  })
  it("rejects blank reasons and identity injection before writing", async () => {
    const blank = await POST(request({ requestId: "request", bots: [proposal, { ...proposal, reason: " " }] }))
    expect(blank.status).toBe(400)
    expect(await blank.json()).toMatchObject({ code: "REASON_REQUIRED", itemIndex: 2, field: "reason" })
    expect((await POST(request({ requestId: "request", bots: [proposal], ownerId: "stranger" }))).status).toBe(400)
    expect(mocks.submit).not.toHaveBeenCalled()
  })
  it("denies human submission and bot approval without falling through", async () => {
    mocks.actor = { kind: "human", userId: "owner", isBot: false }
    expect((await POST(request({ requestId: "request", bots: [proposal] }))).status).toBe(403)
    mocks.actor = { kind: "bot", userId: "requester", ownerUserId: "owner" }
    expect((await PATCH(request({ decision: "approve" }, "PATCH"))).status).toBe(403)
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(mocks.decide).not.toHaveBeenCalled()
  })
  it("publishes authoritative approval and only runs post-create effects for the winning decision", async () => {
    mocks.actor = { kind: "human", userId: "owner", isBot: false }
    const approved = { ...row, status: "approved", resolvedAt: row.createdAt, bots: [{ ...item, createdBot: { id: "newbot", name: item.name, discriminator: "0002", image: null, avatarVersion: 0 } }] }
    mocks.decide.mockResolvedValue({ row: approved, changed: true })
    const response = await PATCH(request({ decision: "approve" }, "PATCH"))
    expect(response.status).toBe(200)
    expect(mocks.decide).toHaveBeenCalledWith(expect.anything(), "owner", "request", "approve")
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(mocks.broadcast).toHaveBeenCalledWith("owner", expect.objectContaining({ type: "community:message.updated", channelId: "dm", messageId: "card", botCreation: expect.objectContaining({ status: "approved" }) }))
    mocks.decide.mockResolvedValue({ row: approved, changed: false })
    await PATCH(request({ decision: "approve" }, "PATCH"))
    expect(mocks.complete).toHaveBeenCalledTimes(1)
    expect(mocks.broadcast).toHaveBeenCalledTimes(1)
  })
  it("keeps useful capacity errors and does not claim approval or dispatch effects", async () => {
    mocks.actor = { kind: "human", userId: "owner", isBot: false }
    mocks.decide.mockRejectedValue(new BotCreationError("BOT_LIMIT_REACHED", "Not enough bot slots", 409, { required: 2, available: 1 }))
    const response = await PATCH(request({ decision: "approve" }, "PATCH"))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: "BOT_LIMIT_REACHED", required: 2, available: 1 })
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })
})
