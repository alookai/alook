import { beforeEach, describe, expect, it, vi } from "vitest"

const q = vi.hoisted(() => ({ server: vi.fn(), getServer: vi.fn(), listUserServers: vi.fn(), channel: vi.fn(), resolveTopLevelBatch: vi.fn(), access: vi.fn(), root: vi.fn(), rootsBatch: vi.fn(), thread: vi.fn(), threadsBatch: vi.fn(), createThread: vi.fn(), createDm: vi.fn() }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: { ...actual.queries,
    communityServer: { ...actual.queries.communityServer, resolveServerByNameForMember: q.server, getServer: q.getServer, listUserServers: q.listUserServers },
    communityChannel: { ...actual.queries.communityChannel, resolveChannelByNameForMember: q.channel, resolveTopLevelChannelsForRefBatch: q.resolveTopLevelBatch, resolveChannelAccessContext: q.access, getThreadChannelByParentMessage: q.thread, listChildChannelsByParentMessageIds: q.threadsBatch },
    communityMessage: { ...actual.queries.communityMessage, getMessageByChannelAndSeq: q.root, listMessagesByChannelAndSeqs: q.rootsBatch },
    communityDm: { ...actual.queries.communityDm, createOrGetDM: q.createDm },
  } }
})
vi.mock("./create-channels", () => ({ createThreadForUser: q.createThread }))
import { resolveChannelRefTarget, resolveChannelRefTargetsBatch } from "./channel-ref-target"

const db = {} as never
const serverRow = { id: "s", name: "Studio", discriminator: "0042", description: "", icon: null, official: false, ownerId: "owner", createdAt: "2026-01-01T00:00:00.000Z" }
const parent = { id: "forum", serverId: "s", categoryId: null, name: "fix", type: "forum", topic: "", position: 0, parentChannelId: null, parentMessageId: null, creatorId: "owner", messageCount: 1, archived: 0, lastMessageAt: null, createdAt: "2026-01-01T00:00:00.000Z" }
const thread = { id: "post", serverId: "s", categoryId: null, name: "Archived post", type: "thread", topic: "", position: 0, parentChannelId: "forum", parentMessageId: "root", creatorId: "owner", messageCount: 1, archived: 1, lastMessageAt: null, createdAt: "2026-01-01T00:00:00.000Z" }
function access(channel: typeof parent | typeof thread, privateDenied = false) {
  return { channel, anchor: parent, role: "admin", isPrivate: privateDenied, isChannelMember: false, isCreator: false }
}
beforeEach(() => {
  vi.resetAllMocks()
  q.server.mockResolvedValue([{ id: "s" }])
  q.getServer.mockResolvedValue(serverRow)
  q.listUserServers.mockResolvedValue([{ ...serverRow, role: "admin", memberId: "m1", mentions: 0 }])
  q.channel.mockResolvedValue([parent])
  q.resolveTopLevelBatch.mockResolvedValue([{ channel: parent, isPrivate: false, isCreator: false, isChannelMember: false }])
  q.access.mockImplementation((_db, id) => Promise.resolve(access(id === "forum" ? parent : thread)))
  q.root.mockResolvedValue({ id: "root", content: "not returned" })
  q.rootsBatch.mockResolvedValue([{ id: "root", channelId: "forum", seq: 259 }])
  q.thread.mockResolvedValue(thread)
  q.threadsBatch.mockResolvedValue([thread])
})
describe("readonly exact channel ref resolution", () => {
  it.each(["/Studio#0042/fix", "/Studio#0042/fix#999"])("opens the base channel without a message lookup: %s", async ref => {
    const result = await resolveChannelRefTarget(db, "viewer", ref)
    expect(result).toMatchObject({ target: { server: { id: "s", name: "Studio" }, channel: { id: "forum", name: "fix", parentChannelId: null } } })
    expect("resources" in result && result.resources?.servers).toHaveLength(1)
    expect("resources" in result && result.resources?.channels.map((c) => c.id)).toEqual(["forum"])
    expect(q.server).toHaveBeenCalledWith(db, "viewer", "studio#0042")
    expect(q.channel).toHaveBeenCalledWith(db, "s", "viewer", "fix")
    expect(q.root).not.toHaveBeenCalled(); expect(q.thread).not.toHaveBeenCalled()
  })
  it.each([true, false])("finds an existing off-list post, archived=%s, ignoring only its message suffix", async archived => {
    const row = { ...thread, archived: archived ? 1 : 0 }
    q.thread.mockResolvedValue(row); q.access.mockImplementation((_db, id) => Promise.resolve(access(id === "forum" ? parent : row)))
    const result = await resolveChannelRefTarget(db, "viewer", "/Studio#0042/fix/#259#18")
    expect(result).toMatchObject({ target: { server: { id: "s", name: "Studio" }, channel: { id: "post", name: "Archived post", parentChannelId: "forum" } } })
    expect("resources" in result && result.resources?.channels.map((c) => c.id)).toEqual(["forum", "post"])
    expect(q.root).toHaveBeenCalledExactlyOnceWith(db, { channelId: "forum" }, 259)
    expect(q.thread).toHaveBeenCalledExactlyOnceWith(db, "forum", "root")
    expect(q.access.mock.calls.map(call => call.slice(1))).toEqual([["forum", "viewer"], ["post", "viewer"]])
    expect(q.createThread).not.toHaveBeenCalled(); expect(q.createDm).not.toHaveBeenCalled()
  })
  it("denies a private parent before the root probe, including an unrostered admin", async () => {
    q.access.mockResolvedValue(access(parent, true))
    expect(await resolveChannelRefTarget(db, "viewer", "/Studio#0042/fix/#259#18")).toEqual({ error: 403 })
    expect(q.root).not.toHaveBeenCalled(); expect(q.thread).not.toHaveBeenCalled()
  })
  it("checks the final child access again and returns no metadata on denial", async () => {
    q.access.mockResolvedValueOnce(access(parent)).mockResolvedValueOnce(null)
    expect(await resolveChannelRefTarget(db, "viewer", "/Studio#0042/fix/#259")).toEqual({ error: 403 })
  })
  it.each(["not-ref", "/Studio/fix/#259", "/.dm/peer#0042#18"])("rejects unsupported syntax before queries: %s", async ref => {
    expect(await resolveChannelRefTarget(db, "viewer", ref)).toEqual({ error: 400 })
    expect(q.server).not.toHaveBeenCalled(); expect(q.createDm).not.toHaveBeenCalled()
  })
  it("does not resolve a server outside the viewer membership", async () => {
    q.server.mockResolvedValue([])
    expect(await resolveChannelRefTarget(db, "viewer", "/Studio#0042/fix/#259")).toEqual({ error: 404 })
    expect(q.channel).not.toHaveBeenCalled(); expect(q.root).not.toHaveBeenCalled()
  })
  it.each(["root", "thread"] as const)("returns unavailable for missing %s without creation", async missing => {
    q[missing].mockResolvedValue(null)
    expect(await resolveChannelRefTarget(db, "viewer", "/Studio#0042/fix/#259#27")).toEqual({ error: 404 })
    expect(q.createThread).not.toHaveBeenCalled(); expect(q.createDm).not.toHaveBeenCalled()
    if (missing === "root") expect(q.thread).not.toHaveBeenCalled()
  })
  it("propagates a storage failure instead of a reachable parent fallback", async () => {
    q.thread.mockRejectedValue(new Error("unavailable"))
    await expect(resolveChannelRefTarget(db, "viewer", "/Studio#0042/fix/#259#27")).rejects.toThrow("unavailable")
    expect(q.createThread).not.toHaveBeenCalled()
  })
})
