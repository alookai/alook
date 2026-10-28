import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
const mocks = vi.hoisted(() => ({ machines: vi.fn(), friends: vi.fn(), servers: vi.fn(), friend: vi.fn(), server: vi.fn(), listInvites: vi.fn(), createInvite: vi.fn(), dm: vi.fn(), message: vi.fn(), rate: vi.fn(), fanout: vi.fn() }))
vi.mock("@alook/shared", async (importOriginal) => ({ ...await importOriginal<typeof import("@alook/shared")>(), queries: {
  automation: { listMachines: mocks.machines, listFriends: mocks.friends, listServers: mocks.servers, getFriendByHandle: mocks.friend },
  communityServer: { resolveServerByNameForMember: mocks.server }, communityInvite: { listServerInvites: mocks.listInvites, createInvite: mocks.createInvite }, communityDm: { createOrGetDM: mocks.dm },
} }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({ primary: true }), getDb: () => ({ primary: true }) }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.rate }))
vi.mock("./message-handler", () => ({ createCommunityMessage: mocks.message }))
vi.mock("./fanout", () => ({ fanOutToServerMembers: mocks.fanout }))
import { readAutomationMachines, readAutomationFriends, readAutomationServers } from "./automation-read.server"
import { inviteAutomationFriend } from "./automation-invite.server"
import { createBotForUser } from "./create-bot.server"
import { createServerForUser } from "./create-server.server"

const request = (body: unknown = { friend: "Alice#0001" }) => new NextRequest("http://localhost/api/community/servers/demo%230001/invites", { method: "POST", body: JSON.stringify(body) })
function context() { return { env: { DB: {} } as Env, userId: "owner", params: { id: "demo#0001" }, beforeCreate: vi.fn(async (): Promise<Response | null> => null) } }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.machines.mockResolvedValue([{ id: "mac1", name: "Mac", hostname: "private", availableRuntimes: ["private"] }])
  mocks.friends.mockResolvedValue([{ id: "hidden", name: "Alice", discriminator: "0001", email: "private" }])
  mocks.servers.mockResolvedValue([{ id: "hidden", name: "demo", discriminator: "0001", ownerId: "private" }])
  mocks.server.mockResolvedValue([{ id: "s1", name: "demo", discriminator: "0001" }])
  mocks.friend.mockResolvedValue({ id: "friend", name: "Alice", discriminator: "0001" })
  mocks.rate.mockResolvedValue({ allowed: true })
  mocks.listInvites.mockResolvedValue([])
  mocks.createInvite.mockResolvedValue({ id: "invite", token: "token", maxUses: null, uses: 0, expiresAt: null, createdAt: "now", serverId: "s1" })
  mocks.dm.mockResolvedValue({ id: "dm" })
  mocks.message.mockResolvedValue({ ok: true })
})

describe("Automation Read and invitation boundaries", () => {
  it("projects minimal API fields before returning lists, and scopes queries to the code owner", async () => {
    const ctx = context()
    expect(await (await readAutomationMachines(request(), ctx)).json()).toEqual({ machines: [{ id: "mac1", name: "Mac" }] })
    expect(await (await readAutomationFriends(request(), ctx)).json()).toEqual({ friends: [{ name: "Alice", handle: "Alice#0001" }] })
    expect(await (await readAutomationServers(request(), ctx)).json()).toEqual({ servers: [{ name: "demo", handle: "demo#0001" }] })
    for (const query of [mocks.machines, mocks.friends, mocks.servers]) expect(query).toHaveBeenCalledExactlyOnceWith({ primary: true }, "owner")
  })
  it("rejects invalid creation input before quota admission and stops valid input on denial", async () => {
    const ctx = context()
    expect((await createBotForUser(request({ name: "Only a name" }), ctx)).status).toBe(400)
    expect((await createServerForUser(request(null), ctx)).status).toBe(400)
    expect(ctx.beforeCreate).not.toHaveBeenCalled()
    ctx.beforeCreate.mockResolvedValue(Response.json({}, { status: 429 }))
    expect((await createBotForUser(request({ name: "Bot", machineId: "mac1", runtime: "claude" }), ctx)).status).toBe(429)
    expect((await createServerForUser(request({ name: "demo" }), ctx)).status).toBe(429)
  })
  it("does not read resource data when its independent quota is denied", async () => {
    const ctx = context()
    ctx.beforeCreate.mockResolvedValue(Response.json({ error: "limited" }, { status: 429 }))
    for (const read of [readAutomationMachines, readAutomationFriends, readAutomationServers]) expect((await read(request(), ctx)).status).toBe(429)
    expect(mocks.machines).not.toHaveBeenCalled()
    expect(mocks.friends).not.toHaveBeenCalled()
    expect(mocks.servers).not.toHaveBeenCalled()
  })
  it("sends only the generated invitation link to an accepted friend, with no forced join", async () => {
    const response = await inviteAutomationFriend(request(), context())
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ invitation: { server: "demo#0001", friend: "Alice#0001", sent: true } })
    expect(mocks.server).toHaveBeenCalledWith({ primary: true }, "owner", "demo#0001")
    expect(mocks.friend).toHaveBeenCalledWith({ primary: true }, "owner", "Alice#0001")
    expect(mocks.message).toHaveBeenCalledExactlyOnceWith({ db: { primary: true }, authorId: "owner", authorKind: "human", target: { kind: "dm", channelId: "dm", otherUserId: "friend" }, body: { content: "http://localhost/c/invite/token" }, source: "web" })
    expect(mocks.fanout).toHaveBeenCalledOnce()
  })
  it("does not grant arbitrary DM content, nonfriend targets or inaccessible servers", async () => {
    expect((await inviteAutomationFriend(request({ friend: "Alice#0001", content: "arbitrary text" }), context())).status).toBe(400)
    mocks.friend.mockResolvedValueOnce(null)
    expect((await inviteAutomationFriend(request(), context())).status).toBe(404)
    mocks.server.mockResolvedValueOnce([])
    expect((await inviteAutomationFriend(request(), context())).status).toBe(404)
    expect(mocks.createInvite).not.toHaveBeenCalled()
    expect(mocks.dm).not.toHaveBeenCalled()
    expect(mocks.message).not.toHaveBeenCalled()
  })
  it("preserves both automation quota and normal message rate limiting", async () => {
    const ctx = context()
    ctx.beforeCreate.mockResolvedValueOnce(Response.json({}, { status: 429 }))
    expect((await inviteAutomationFriend(request(), ctx)).status).toBe(429)
    expect(mocks.server).not.toHaveBeenCalled()
    mocks.rate.mockResolvedValueOnce({ allowed: false, retryAfterSec: 10 })
    const response = await inviteAutomationFriend(request(), context())
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("10")
    expect(mocks.message).not.toHaveBeenCalled()
  })
  it("reuses only the caller's live invite and reports existing capacity/message errors", async () => {
    mocks.listInvites.mockResolvedValueOnce([{ creatorId: "owner", token: "reused", maxUses: 2, uses: 1, expiresAt: null }])
    expect((await inviteAutomationFriend(request(), context())).status).toBe(201)
    expect(mocks.createInvite).not.toHaveBeenCalled()
    expect(mocks.fanout).not.toHaveBeenCalled()
    mocks.createInvite.mockResolvedValueOnce(null)
    expect((await inviteAutomationFriend(request(), context())).status).toBe(409)
    mocks.message.mockResolvedValueOnce({ ok: false, status: 409, error: "Message failed" })
    expect((await inviteAutomationFriend(request(), context())).status).toBe(409)
  })
})
