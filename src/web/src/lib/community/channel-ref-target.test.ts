import { beforeEach, describe, expect, it, vi } from "vitest"

const q = vi.hoisted(() => ({ server: vi.fn(), channel: vi.fn(), access: vi.fn(), root: vi.fn(), thread: vi.fn(), createThread: vi.fn(), createDm: vi.fn() }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: { ...actual.queries,
    communityServer: { ...actual.queries.communityServer, resolveServerByNameForMember: q.server },
    communityChannel: { ...actual.queries.communityChannel, resolveChannelByNameForMember: q.channel, resolveChannelAccessContext: q.access, getThreadChannelByParentMessage: q.thread },
    communityMessage: { ...actual.queries.communityMessage, getMessageByChannelAndSeq: q.root },
    communityDm: { ...actual.queries.communityDm, createOrGetDM: q.createDm },
  } }
})
vi.mock("./create-channels", () => ({ createThreadForUser: q.createThread }))
import { resolveChannelRefTarget } from "./channel-ref-target"

const db = {} as never
const parent = { id: "forum", serverId: "s", name: "fix", parentChannelId: null, archived: false }
const thread = { id: "post", serverId: "s", name: "Archived post", parentChannelId: "forum", archived: true }
function access(channel: typeof parent | typeof thread, privateDenied = false) {
  return { channel, anchor: parent, role: "admin", isPrivate: privateDenied, isChannelMember: false, isCreator: false }
}
beforeEach(() => {
  vi.resetAllMocks()
  q.server.mockResolvedValue([{ id: "s" }]); q.channel.mockResolvedValue([parent])
  q.access.mockImplementation((_db, id) => Promise.resolve(access(id === "forum" ? parent : thread)))
  q.root.mockResolvedValue({ id: "root", content: "not returned" }); q.thread.mockResolvedValue(thread)
})
describe("readonly exact channel ref resolution", () => {
  it.each(["/Studio#0042/fix", "/Studio#0042/fix#999"])("opens the base channel without a message lookup: %s", async ref => {
    expect(await resolveChannelRefTarget(db, "viewer", ref)).toEqual({ target: { server: { id: "s", name: "Studio" }, channel: { id: "forum", name: "fix", parentChannelId: null } } })
    expect(q.server).toHaveBeenCalledWith(db, "viewer", "studio#0042")
    expect(q.channel).toHaveBeenCalledWith(db, "s", "viewer", "fix")
    expect(q.root).not.toHaveBeenCalled(); expect(q.thread).not.toHaveBeenCalled()
  })
  it.each([true, false])("finds an existing off-list post, archived=%s, ignoring only its message suffix", async archived => {
    const row = { ...thread, archived }
    q.thread.mockResolvedValue(row); q.access.mockImplementation((_db, id) => Promise.resolve(access(id === "forum" ? parent : row)))
    const result = await resolveChannelRefTarget(db, "viewer", "/Studio#0042/fix/#259#18")
    expect(result).toEqual({ target: { server: { id: "s", name: "Studio" }, channel: { id: "post", name: "Archived post", parentChannelId: "forum" } } })
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
