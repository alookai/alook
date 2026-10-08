import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ access: vi.fn(), channel: vi.fn(), participants: vi.fn(), audience: vi.fn(), users: vi.fn(), serverMembers: vi.fn(), resolve: vi.fn() }))
vi.mock("./permissions", () => ({ requireMessageSurfaceAccess: mocks.access }))
vi.mock("@alook/shared", async (original) => ({ ...await original<typeof import("@alook/shared")>(), queries: {
  communityChannel: { getChannelForMember: mocks.channel, listChannelMemberUserIds: mocks.audience },
  communityThread: { listThreadParticipants: mocks.participants }, user: { getUsersByIds: mocks.users },
  communityMember: { getMembersByUserIds: mocks.serverMembers }, communityMembersResolver: { resolveScopeMembers: mocks.resolve },
} }))
import { readCommunityMembers } from "./member-read"
beforeEach(() => {
  vi.clearAllMocks()
  mocks.access.mockResolvedValue({ ok: true, value: { surface: "dm", dm: { otherUserId: "peer" } } })
  mocks.channel.mockResolvedValue({ id: "dm", type: "dm", serverId: null, creatorId: null })
  mocks.audience.mockResolvedValue(["viewer", "peer"])
  mocks.participants.mockResolvedValue([])
  mocks.users.mockResolvedValue(["viewer", "peer"].map((id) => ({ id, name: id, discriminator: "1234", image: null, avatarVersion: 0, email: "private@example.test" })))
})
describe("common member relations", () => {
  it("keeps the current notify roster distinct from readable users", async () => {
    mocks.access.mockResolvedValue({ ok: true, value: { surface: "channel", channel: { id: "thread", type: "thread", serverId: "server", creatorId: "viewer" } } })
    mocks.participants.mockResolvedValue([{ userId: "viewer", source: "spoke" }, { userId: "deleted", source: "added" }])
    mocks.users.mockResolvedValue([{ id: "viewer", name: "Viewer", discriminator: "1234", image: null, avatarVersion: 0, email: "private@example.test" }])
    mocks.serverMembers.mockResolvedValue([{ id: "member", userId: "viewer", role: "admin", statusEmoji: "👍", statusText: "here" }])
    const response = await readCommunityMembers({} as never, "thread", "viewer", "notify")
    expect(await response.json()).toMatchObject({ channelId: "thread", relation: "notify", members: [{ userId: "viewer", source: "spoke", isCreator: true, role: "admin", memberId: "member" }], profiles: [{ id: "viewer", statusEmoji: "👍", statusText: "here" }] })
    expect(mocks.participants).toHaveBeenCalledWith({}, "thread")
    expect(mocks.audience).not.toHaveBeenCalled()
    expect(mocks.resolve).not.toHaveBeenCalled()
  })
  it.each(["text", "forum"])("resolves the %s access audience rather than notify participants", async (type) => {
    mocks.access.mockResolvedValue({ ok: true, value: { surface: "channel", channel: { id: "parent", type, serverId: "server", creatorId: "viewer" } } })
    mocks.resolve.mockResolvedValue([{ userId: "viewer", source: "admin" }])
    mocks.users.mockResolvedValue([{ id: "viewer", name: "Viewer", image: null, avatarVersion: 0 }])
    mocks.serverMembers.mockResolvedValue([])
    const response = await readCommunityMembers({} as never, "parent", "viewer", "access")
    expect(await response.json()).toMatchObject({ members: [{ channelId: "parent", userId: "viewer", relation: "access", source: "admin" }] })
    expect(mocks.resolve).toHaveBeenCalledWith({}, { scope: type === "forum" ? "forum" : "channel", scopeId: "parent" })
    expect(mocks.participants).not.toHaveBeenCalled()
  })
  it("does not hydrate members when the readable DM no longer has metadata", async () => {
    mocks.channel.mockResolvedValue(null)
    expect((await readCommunityMembers({} as never, "dm", "viewer", "access")).status).toBe(404)
    expect(mocks.users).not.toHaveBeenCalled()
  })
  it("retains both DM participants without server membership or email fields", async () => {
    const response = await readCommunityMembers({} as never, "dm", "viewer", "access")
    const body = await response.json()
    expect(body).toMatchObject({ contractVersion: 2, channelId: "dm", relation: "access" })
    expect(body.members).toHaveLength(2)
    expect(body.members.every((member: { role: unknown; memberId: unknown }) => member.role === null && member.memberId === null)).toBe(true)
    expect(JSON.stringify(body)).not.toContain("private@example.test")
    expect(mocks.serverMembers).not.toHaveBeenCalled()
    expect(mocks.resolve).not.toHaveBeenCalled()
  })
  it("returns the actual empty notify set rather than deriving it from access", async () => {
    mocks.users.mockResolvedValue([])
    const response = await readCommunityMembers({} as never, "dm", "viewer", "notify")
    expect(await response.json()).toMatchObject({ relation: "notify", members: [], profiles: [] })
    expect(mocks.audience).not.toHaveBeenCalled()
  })
  it("requires a relation and preserves the full reading rejection", async () => {
    expect((await readCommunityMembers({} as never, "dm", "viewer", null)).status).toBe(400)
    mocks.access.mockResolvedValue({ ok: false, status: 403, error: "blocked" })
    expect((await readCommunityMembers({} as never, "dm", "viewer", "access")).status).toBe(403)
    expect(mocks.audience).not.toHaveBeenCalled()
  })
})
