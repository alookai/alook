import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
const mocks = vi.hoisted(() => ({ machines: vi.fn(), friends: vi.fn(), servers: vi.fn(), friend: vi.fn(), server: vi.fn(), listInvites: vi.fn(), createInvite: vi.fn(), dm: vi.fn(), message: vi.fn(), rate: vi.fn(), fanout: vi.fn() }))
vi.mock("@alook/shared", async (importOriginal) => { const actual = await importOriginal<typeof import("@alook/shared")>(); return { ...actual, queries: { ...actual.queries,
  automation: { listMachines: mocks.machines, listFriends: mocks.friends, getFriendByHandle: mocks.friend },
  communityChannel: { listChannelRefDirectoryForUser: mocks.servers },
  communityServer: { resolveServerByNameForMember: mocks.server }, communityInvite: { listServerInvites: mocks.listInvites, createInvite: mocks.createInvite }, communityDm: { createOrGetDM: mocks.dm },
} } })
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
  mocks.machines.mockResolvedValue([{ id: "mac1", name: "Mac", status: "online", hostname: "private", availableRuntimes: [] }])
  mocks.friends.mockResolvedValue([{ id: "hidden", name: "Alice", discriminator: "0001", isBot: false, ownerUserId: null, email: "private" }])
  mocks.servers.mockResolvedValue([{ id: "hidden", name: "demo", discriminator: "0001", ownerId: "private", channels: [{ id: "private-id", name: "general", type: "text", topic: "private" }, { id: "forum-id", name: "ideas", type: "forum" }] }])
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
    expect(await (await readAutomationMachines(request(), ctx)).json()).toEqual({ machines: [{ id: "mac1", name: "Mac", status: "online", backends: [] }] })
    expect(await (await readAutomationFriends(request(), ctx)).json()).toEqual({ friends: [{ name: "Alice", handle: "Alice#0001", is_my_bot: false }] })
    expect(await (await readAutomationServers(request(), ctx)).json()).toEqual({ servers: [{ name: "demo", handle: "demo#0001", channels: [{ name: "general", type: "text", ref: "/demo#0001/general" }, { name: "ideas", type: "forum", ref: "/demo#0001/ideas" }] }] })
    expect(mocks.servers).toHaveBeenCalledExactlyOnceWith({ primary: true }, "owner", { railOrder: false })
    for (const query of [mocks.machines, mocks.friends]) expect(query).toHaveBeenCalledExactlyOnceWith({ primary: true }, "owner")
  })
  it("keeps joined servers with no participating channels and handles no joined servers", async () => {
    mocks.servers.mockResolvedValueOnce([{ id: "s1", name: "demo", discriminator: "0001", channels: [] }])
    expect(await (await readAutomationServers(request(), context())).json()).toEqual({ servers: [{ name: "demo", handle: "demo#0001", channels: [] }] })
    mocks.servers.mockResolvedValueOnce([])
    expect(await (await readAutomationServers(request(), context())).json()).toEqual({ servers: [] })
  })
  it("marks only the code owner's bots and returns both persisted machine statuses without private fields", async () => {
    mocks.friends.mockResolvedValue([
      { name: "Helper", discriminator: "0001", isBot: true, ownerUserId: "owner", id: "private" },
      { name: "Peer bot", discriminator: "0002", isBot: true, ownerUserId: "other", email: "private" },
      { name: "Human", discriminator: "0003", isBot: false, ownerUserId: "owner" },
    ])
    mocks.machines.mockResolvedValue([
      { id: "online", name: "Running", status: "online", hostname: "private", availableRuntimes: [] },
      { id: "offline", name: "Stopped", status: "offline", availableRuntimes: [] },
    ])
    expect(await (await readAutomationFriends(request(), context())).json()).toEqual({ friends: [
      { name: "Helper", handle: "Helper#0001", is_my_bot: true },
      { name: "Peer bot", handle: "Peer bot#0002", is_my_bot: false },
      { name: "Human", handle: "Human#0003", is_my_bot: false },
    ] })
    expect(await (await readAutomationMachines(request(), context())).json()).toEqual({ machines: [
      { id: "online", name: "Running", status: "online", backends: [] },
      { id: "offline", name: "Stopped", status: "offline", backends: [] },
    ] })
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

it("rejects missing or malformed server handles before admission", async () => {
  const ctx = context()
  for (const params of [undefined, {}, { id: "not-a-handle" }]) {
    expect((await inviteAutomationFriend(request(), { ...ctx, params })).status).toBe(400)
  }
  expect(ctx.beforeCreate).not.toHaveBeenCalled()
  expect(mocks.server).not.toHaveBeenCalled()
  expect(mocks.message).not.toHaveBeenCalled()
})

it("skips another author's, expired and exhausted invitations before reusing a valid one", async () => {
  mocks.listInvites.mockResolvedValueOnce([
    { creatorId: "other", token: "other", maxUses: null, uses: 0, expiresAt: null },
    { creatorId: "owner", token: "expired", maxUses: null, uses: 0, expiresAt: "2000-01-01T00:00:00Z" },
    { creatorId: "owner", token: "exhausted", maxUses: 1, uses: 1, expiresAt: null },
    { creatorId: "owner", token: "valid", maxUses: 2, expiresAt: "2999-01-01T00:00:00Z" },
  ])
  expect((await inviteAutomationFriend(request(), context())).status).toBe(201)
  expect(mocks.createInvite).not.toHaveBeenCalled()
  expect(mocks.message.mock.lastCall?.[0].body).toEqual({ content: "http://localhost/c/invite/valid" })
})

it("normalizes legacy backends and strips runtime diagnostics and model bodies from the machine list", async () => {
  mocks.machines.mockResolvedValue([{ id: "m", name: "M", status: "online", availableRuntimes: ["codex", "", null,
    { id: "opencode", status: "unhealthy", version: "1", lastError: "private", reasoning: { updateMode: "unsupported", catalogOrigin: "adapter_suggestions", models: [] } },
    { id: "bad runtime", status: "healthy" },
  ] }])
  expect(await (await readAutomationMachines(request(), context())).json()).toEqual({ machines: [{ id: "m", name: "M", status: "online", backends: [
    { id: "codex", health: "healthy", modelRequired: false },
    { id: "opencode", version: "1", health: "unhealthy", modelRequired: true },
  ] }] })
})
