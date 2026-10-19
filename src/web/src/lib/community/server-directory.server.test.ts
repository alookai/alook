import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Database } from "@alook/shared"

const mocks = vi.hoisted(() => ({ access: vi.fn(), server: vi.fn(), channels: vi.fn(), categories: vi.fn() }))
vi.mock("./permissions", () => ({ requireServerMember: mocks.access }))
vi.mock("@alook/shared", async original => {
  const shared = await original<typeof import("@alook/shared")>()
  return { ...shared, queries: { ...shared.queries, communityServer: { ...shared.queries.communityServer, getServer: mocks.server }, communityChannel: { ...shared.queries.communityChannel, listServerChannelsForViewer: mocks.channels } } }
})
import { readCommunityServerDirectory } from "./server-directory.server"

const db = { query: { communityCategory: { findMany: mocks.categories } } } as unknown as Database
beforeEach(() => {
  mocks.access.mockReset().mockResolvedValue({ ok: true, value: { userId: "viewer", role: "member" } })
  mocks.server.mockReset().mockResolvedValue({ id: "s1", name: "Server", discriminator: "0042", description: "About", ownerId: "owner", iconKey: null, official: false })
  mocks.categories.mockReset().mockResolvedValue([{ id: "cat", name: "Category", private: 0, position: 0 }])
  mocks.channels.mockReset().mockResolvedValue([{ id: "c1", serverId: "s1", categoryId: "cat", name: "Visible", type: "text" }, { id: "f1", serverId: "s1", categoryId: null, name: "Forum", type: "forum" }])
})

describe("scoped document server directory", () => {
  it("checks viewer membership before reading any directory rows", async () => {
    mocks.access.mockResolvedValue({ ok: false, status: 403, error: "denied" })
    expect(await readCommunityServerDirectory(db, "viewer", "s1")).toBeUndefined()
    expect(mocks.server).not.toHaveBeenCalled()
    expect(mocks.categories).not.toHaveBeenCalled()
    expect(mocks.channels).not.toHaveBeenCalled()
  })

  it("uses the same scoped category and viewer-filtered channel loaders as HTTP", async () => {
    const result = await readCommunityServerDirectory(db, "viewer", "s1")
    expect(mocks.access).toHaveBeenCalledWith(db, "s1", "viewer")
    expect(mocks.server).toHaveBeenCalledWith(db, "s1")
    expect(mocks.channels).toHaveBeenCalledWith(db, "s1", "viewer")
    expect(result).toMatchObject({ id: "s1", categories: [{ id: "cat", private: false, channels: [{ id: "c1", active: false, unread: false }] }, { id: "__uncategorized__", channels: [{ id: "f1", type: "forum" }] }] })
    expect(result).not.toHaveProperty("iconKey")
    const { where } = mocks.categories.mock.calls[0][0]
    const eq = vi.fn()
    where({ serverId: "column" }, { eq })
    expect(eq).toHaveBeenCalledWith("column", "s1")
  })
})
