import { describe, expect, it } from "vitest"
import { BUSINESS_SCHEMA_VERSION, categorySchema, channelSchema, serverSchema } from "@alook/shared"
import { readServerDirectoryWindow, serverDirectoryWindowComplete, ServerDirectorySnapshotSchema } from "./server-directory-window"

const server = serverSchema.parse({ id: "s", position: 0, name: "Server", discriminator: "0042", description: "", ownerId: "viewer", icon: null, official: false, isOwner: true })
const category = categorySchema.parse({ id: "category", serverId: "s", name: "Category", position: 0, private: false, creatorId: null, pending: false })
const channel = channelSchema.parse({ id: "channel", serverId: "s", categoryId: "category", name: "Channel", type: "text", topic: "", parentChannelId: null, parentMessageId: null, creatorId: "viewer", position: 0, archived: false, createdAt: "2026-10-28T00:00:00Z", lastMessageAt: null, messageCount: 0, muted: false, tags: [], pending: false })
const window = { schemaVersion: BUSINESS_SCHEMA_VERSION, accountId: "viewer", serverId: "s", categoryIds: [category.id], channelIds: [channel.id] }
const rows = { servers: [server], categories: [category], channels: [channel] }

describe("qualified server directory window", () => {
  it("requires a current ID window and its full canonical closure", () => {
    expect(readServerDirectoryWindow(window)).toEqual(window)
    expect(serverDirectoryWindowComplete(window, rows, "viewer", "s")).toBe(true)
    expect(serverDirectoryWindowComplete(window, { ...rows, channels: [] }, "viewer", "s")).toBe(false)
    expect(serverDirectoryWindowComplete(window, { ...rows, categories: [] }, "viewer", "s")).toBe(false)
    expect(serverDirectoryWindowComplete(window, { ...rows, channels: [{ ...channel, serverId: "other" }] }, "viewer", "s")).toBe(false)
    expect(serverDirectoryWindowComplete(window, rows, "other", "s")).toBe(false)
    expect(serverDirectoryWindowComplete(window, rows, "viewer", "other")).toBe(false)
  })

  it("does not treat an entity, old window, duplicate ID or detail flag as directory proof", () => {
    for (const value of [server, "s", { ...window, schemaVersion: BUSINESS_SCHEMA_VERSION - 1 }, { ...window, detailComplete: true }, { ...window, channelIds: ["channel", "channel"] }]) {
      expect(readServerDirectoryWindow(value)).toBeUndefined()
    }
  })

  it("requires actual full resource facts in directory snapshots", () => {
    expect(() => ServerDirectorySnapshotSchema.parse({ server, categories: [], channels: [{ id: "channel", type: "text", name: "Channel" }] })).toThrow()
    const { position: _position, ...missingPosition } = server
    expect(() => ServerDirectorySnapshotSchema.parse({ server: missingPosition, categories: [], channels: [] })).toThrow()
  })
})
