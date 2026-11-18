import { beforeEach, describe, expect, it, vi } from "vitest"

const reads = vi.hoisted(() => ({ channels: vi.fn(), categories: vi.fn() }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: { ...actual.queries, communityChannel: { ...actual.queries.communityChannel, listChannelsForMember: reads.channels },
    communityCategory: { ...actual.queries.communityCategory, listCategoriesByServer: reads.categories } } }
})

import { buildServerChannelGroups } from "./list-channels"

const server = { id: "server", name: "Studio", discriminator: "0042" }
const db = {} as Parameters<typeof buildServerChannelGroups>[0]

beforeEach(() => {
  reads.channels.mockReset().mockResolvedValue([
    { id: "public-id", name: "public", type: "text", categoryId: null },
    { id: "private-id", name: "private", type: "forum", categoryId: "visible-private" },
  ])
  reads.categories.mockReset().mockResolvedValue([
    { id: "hidden", name: "Never surfaced", private: 1, position: 0 },
    { id: "visible-private", name: "Private", private: 1, position: 1 },
  ])
})

describe("Bot aggregate resource IDs on the original scoped channel read", () => {
  it("keeps the default CLI ref-only shape and omits empty private groups", async () => {
    const groups = await buildServerChannelGroups(db, server, "bot")
    expect(groups).toEqual([
      { category: null, channels: [{ ref: "/Studio#0042/public", name: "public", type: "text", visibility: "public" }] },
      { category: { name: "Private", private: true }, channels: [{ ref: "/Studio#0042/private", name: "private", type: "forum", visibility: "private" }] },
    ])
    expect(reads.channels).toHaveBeenCalledExactlyOnceWith(db, "server", "bot")
    expect(reads.categories).toHaveBeenCalledExactlyOnceWith(db, "server")
  })

  it("adds only the IDs of those same scoped rows for the Bot aggregate", async () => {
    const groups = await buildServerChannelGroups(db, server, "bot", true)
    expect(groups.flatMap(group => group.channels)).toEqual([
      { id: "public-id", ref: "/Studio#0042/public", name: "public", type: "text", visibility: "public" },
      { id: "private-id", ref: "/Studio#0042/private", name: "private", type: "forum", visibility: "private" },
    ])
    expect(groups.some(group => group.category?.name === "Never surfaced")).toBe(false)
    expect(reads.channels).toHaveBeenCalledTimes(1)
    expect(reads.categories).toHaveBeenCalledTimes(1)
  })
})
