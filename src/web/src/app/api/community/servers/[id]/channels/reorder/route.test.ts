import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({ member: vi.fn(), roots: vi.fn(), categories: vi.fn(), reorder: vi.fn(), fanout: vi.fn(), primary: vi.fn(() => ({})) }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: mocks.primary }))
vi.mock("@alook/shared", async () => ({
  ...await vi.importActual<typeof import("@alook/shared")>("@alook/shared"),
  queries: {
    communityMember: { getMember: mocks.member },
    communityCategory: { listCategoriesByServer: mocks.categories },
    communityChannel: { getServerRootChannelsByIds: mocks.roots, reorderChannels: mocks.reorder },
  },
}))
vi.mock("@/lib/community/fanout", () => ({ fanOutToServerMembers: mocks.fanout }))
vi.mock("@/lib/middleware/auth", () => ({ withAuth: (handler: any) => (req: any, ctx?: any) => handler(req, { env: { DB: "binding" }, userId: "u1", params: ctx?.params }) }))
import { PATCH } from "./route"
const ctx = { params: { id: "s1" } } as never
const request = (body: unknown) => new NextRequest("http://localhost/api/community/servers/s1/channels/reorder", { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.member.mockResolvedValue({ id: "m1", role: "admin" })
  mocks.roots.mockResolvedValue([{ id: "c1", serverId: "s1", categoryId: "a" }, { id: "c2", serverId: "s1", categoryId: "b" }])
  mocks.categories.mockResolvedValue([{ id: "a", private: 0 }, { id: "b", private: 0 }])
  mocks.reorder.mockResolvedValue(undefined)
  mocks.fanout.mockResolvedValue(undefined)
})

describe("server-scoped channel order", () => {
  it("requires server administration before reading channel rows", async () => {
    mocks.member.mockResolvedValue({ id: "member", role: "member" })
    expect((await PATCH(request({ channelIds: ["c1"] }), ctx)).status).toBe(403)
    expect(mocks.roots).not.toHaveBeenCalled()
    expect(mocks.reorder).not.toHaveBeenCalled()
  })
  it.each([null, {}, { channelIds: [] }, { channelIds: ["c1", "c1"] }, { channelIds: [1] }, { channelIds: ["c1"], move: { channelId: "other", categoryId: "b" } }, { channelIds: ["c1"], move: { channelId: "c1", categoryId: 1 } }, { channelIds: ["c1"], unknown: true }])("rejects malformed commands before reading rows: %j", async (body) => {
    expect((await PATCH(request(body), ctx)).status).toBe(400)
    expect(mocks.roots).not.toHaveBeenCalled()
    expect(mocks.reorder).not.toHaveBeenCalled()
    expect(mocks.fanout).not.toHaveBeenCalled()
  })
  it.each(["foreign-server", "missing", "nested-thread"])("rejects a %s identity absent from the scoped root query", async () => {
    mocks.roots.mockResolvedValue([{ id: "c1" }])
    expect((await PATCH(request({ channelIds: ["c1", "unavailable"] }), ctx)).status).toBe(404)
    expect(mocks.roots).toHaveBeenCalledExactlyOnceWith({}, "s1", ["c1", "unavailable"])
    expect(mocks.reorder).not.toHaveBeenCalled()
    expect(mocks.fanout).not.toHaveBeenCalled()
  })
  it("preserves the existing reorder contract and uses a primary session", async () => {
    expect((await PATCH(request({ channelIds: ["c2", "c1"] }), ctx)).status).toBe(200)
    expect(mocks.primary).toHaveBeenCalledExactlyOnceWith("binding")
    expect(mocks.reorder).toHaveBeenCalledExactlyOnceWith({}, "s1", ["c2", "c1"], undefined)
    expect(mocks.categories).not.toHaveBeenCalled()
    expect(mocks.fanout).toHaveBeenCalledExactlyOnceWith("s1", { type: "community:channel.reorder", serverId: "s1", channels: [{ id: "c2", position: 0 }, { id: "c1", position: 1 }] })
  })
  it.each([false, true])("commits a same-privacy category move and order together, private=%s", async (privateCategory) => {
    mocks.categories.mockResolvedValue([{ id: "a", private: Number(privateCategory) }, { id: "b", private: Number(privateCategory) }])
    const move = { channelId: "c1", categoryId: "b" }
    expect((await PATCH(request({ channelIds: ["c2", "c1"], move }), ctx)).status).toBe(200)
    expect(mocks.categories).toHaveBeenCalledExactlyOnceWith({}, "s1")
    expect(mocks.reorder).toHaveBeenCalledExactlyOnceWith({}, "s1", ["c2", "c1"], move)
    expect(mocks.reorder.mock.invocationCallOrder[0]).toBeLessThan(mocks.fanout.mock.invocationCallOrder[0]!)
  })
  it("moves a public channel to uncategorized in the same batch", async () => {
    const move = { channelId: "c1", categoryId: null }
    expect((await PATCH(request({ channelIds: ["c1", "c2"], move }), ctx)).status).toBe(200)
    expect(mocks.reorder).toHaveBeenCalledWith({}, "s1", ["c1", "c2"], move)
  })
  it.each(["b", null])("rejects a private channel entering public/root: %s", async (categoryId) => {
    mocks.categories.mockResolvedValue([{ id: "a", private: 1 }, { id: "b", private: 0 }])
    expect((await PATCH(request({ channelIds: ["c1", "c2"], move: { channelId: "c1", categoryId } }), ctx)).status).toBe(400)
    expect(mocks.reorder).not.toHaveBeenCalled()
    expect(mocks.fanout).not.toHaveBeenCalled()
  })
  it("rejects a public channel entering private", async () => {
    mocks.categories.mockResolvedValue([{ id: "a", private: 0 }, { id: "b", private: 1 }])
    expect((await PATCH(request({ channelIds: ["c1", "c2"], move: { channelId: "c1", categoryId: "b" } }), ctx)).status).toBe(400)
    expect(mocks.reorder).not.toHaveBeenCalled()
  })
  it("rejects a target category outside the server", async () => {
    expect((await PATCH(request({ channelIds: ["c1", "c2"], move: { channelId: "c1", categoryId: "foreign" } }), ctx)).status).toBe(404)
    expect(mocks.reorder).not.toHaveBeenCalled()
  })
  it("sends no success event when the atomic write fails", async () => {
    mocks.reorder.mockRejectedValue(new Error("batch rejected"))
    await expect(PATCH(request({ channelIds: ["c1", "c2"], move: { channelId: "c1", categoryId: "b" } }), ctx)).rejects.toThrow("batch rejected")
    expect(mocks.fanout).not.toHaveBeenCalled()
  })
})
