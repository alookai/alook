import { describe, expect, it } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import {
  parseStructuralSnapshot,
  projectServerDetailTree,
  reduceStructuralSnapshot,
  STRUCTURAL_SNAPSHOT_CHILD_LIMIT,
  STRUCTURAL_SNAPSHOT_TTL_MS,
  structuralServerToCategories,
  structuralSnapshotDirectory,
  structuralSnapshotFolders,
  structuralSnapshotServers,
  type StructuralSnapshotV1,
  updateStructuralSnapshot,
} from "./structural-snapshot"

const NOW = 2_000_000_000_000

function snapshot(): StructuralSnapshotV1 {
  return {
    schemaVersion: 1,
    accountId: "account-a",
    capturedAt: NOW,
    serverOrder: ["server-b", "server-a"],
    folders: [{ id: "folder-1", name: "Work", serverIds: ["server-a"] }],
    servers: [
      {
        id: "server-a",
        name: "Alpha",
        discriminator: "0001",
        icon: null,
        categories: [{ id: "category-1", name: "General", private: false }],
        channels: [
          { id: "channel-a", name: "chat", type: "text", categoryId: "category-1" },
          { id: "channel-b", name: "ideas", type: "forum", categoryId: null },
        ],
        childRouteHints: [{
          id: "child-1",
          name: "thread",
          type: "thread",
          parentChannelId: "channel-a",
          parentMessageId: "message-1",
        }],
      },
      {
        id: "server-b",
        name: "Beta",
        discriminator: "0002",
        icon: "https://example.com/icon.png",
        categories: [],
        channels: [],
        childRouteHints: [],
      },
    ],
  }
}

describe("parseStructuralSnapshot", () => {
  it("round-trips the exact v1 allowlist", () => {
    expect(parseStructuralSnapshot(snapshot(), "account-a", NOW)).toEqual(snapshot())
  })

  it.each([
    ["wrong account", { ...snapshot(), accountId: "account-b" }],
    ["wrong version", { ...snapshot(), schemaVersion: 2 }],
    ["expired", { ...snapshot(), capturedAt: NOW - STRUCTURAL_SNAPSHOT_TTL_MS - 1 }],
    ["future", { ...snapshot(), capturedAt: NOW + 1 }],
    ["unknown top-level field", { ...snapshot(), role: "owner" }],
  ])("rejects %s", (_label, value) => {
    expect(parseStructuralSnapshot(value, "account-a", NOW)).toBeNull()
  })

  it("rejects unknown nested authorization and runtime fields", () => {
    const value = snapshot() as StructuralSnapshotV1 & {
      servers: Array<StructuralSnapshotV1["servers"][number] & { ownerId?: string }>
    }
    value.servers[0] = { ...value.servers[0]!, ownerId: "owner-1" }
    expect(parseStructuralSnapshot(value, "account-a", NOW)).toBeNull()

  })

  it("rejects duplicate, dangling, temporary, and over-limit references", () => {
    const duplicate = snapshot()
    duplicate.serverOrder = ["server-a", "server-a"]
    expect(parseStructuralSnapshot(duplicate, "account-a", NOW)).toBeNull()

    const dangling = snapshot()
    dangling.servers[0]!.channels[0]!.categoryId = "missing"
    expect(parseStructuralSnapshot(dangling, "account-a", NOW)).toBeNull()

    const temporary = snapshot()
    temporary.servers[0]!.channels[0]!.id = "tmp_ch_1"
    expect(parseStructuralSnapshot(temporary, "account-a", NOW)).toBeNull()

    const oversized = snapshot()
    oversized.servers[0]!.childRouteHints = Array.from(
      { length: STRUCTURAL_SNAPSHOT_CHILD_LIMIT + 1 },
      (_, index) => ({
        id: `child-${index}`,
        name: `Thread ${index}`,
        type: "thread" as const,
        parentChannelId: "channel-a",
        parentMessageId: `message-${index}`,
      }),
    )
    expect(parseStructuralSnapshot(oversized, "account-a", NOW)).toBeNull()
  })

  it("rejects malformed and unsafe child-route hints", () => {
    const unknownField = snapshot() as unknown as {
      servers: Array<{ childRouteHints: Array<Record<string, unknown>> }>
    }
    unknownField.servers[0]!.childRouteHints[0]!.permission = "read"
    expect(parseStructuralSnapshot(unknownField, "account-a", NOW)).toBeNull()

    const unsafeParentMessage = snapshot()
    unsafeParentMessage.servers[0]!.childRouteHints[0]!.parentMessageId = ""
    expect(parseStructuralSnapshot(unsafeParentMessage, "account-a", NOW)).toBeNull()
  })

  it("preserves an empty folder as structural rail state", () => {
    const value = snapshot()
    value.folders = [{ id: "folder-empty", name: "Later", serverIds: [] }]
    expect(parseStructuralSnapshot(value, "account-a", NOW)?.folders).toEqual(value.folders)

    const next = reduceStructuralSnapshot(value, {
      type: "replaceFolders",
      folders: value.folders,
    }, NOW)!
    expect(next.folders).toEqual(value.folders)
  })

  it("accepts a bounded 100-server structural fixture without runtime data", () => {
    const servers = Array.from({ length: 100 }, (_, serverIndex) => {
      const channels = Array.from({ length: 10 }, (_, channelIndex) => ({
        id: `server-${serverIndex}-channel-${channelIndex}`,
        name: `Channel ${channelIndex}`,
        type: channelIndex % 2 === 0 ? "text" as const : "forum" as const,
        categoryId: `server-${serverIndex}-category`,
      }))
      return {
        id: `server-${serverIndex}`,
        name: `Server ${serverIndex}`,
        discriminator: String(serverIndex).padStart(4, "0"),
        icon: null,
        categories: [{
          id: `server-${serverIndex}-category`,
          name: "General",
          private: false,
        }],
        channels,
        childRouteHints: Array.from({ length: STRUCTURAL_SNAPSHOT_CHILD_LIMIT }, (_, childIndex) => ({
          id: `server-${serverIndex}-child-${childIndex}`,
          name: `Thread ${childIndex}`,
          type: "thread" as const,
          parentChannelId: channels[0]!.id,
          parentMessageId: `server-${serverIndex}-message-${childIndex}`,
        })),
      }
    })
    const value: StructuralSnapshotV1 = {
      schemaVersion: 1,
      accountId: "account-a",
      capturedAt: NOW,
      serverOrder: servers.map((server) => server.id),
      folders: [],
      servers,
    }

    const parsed = parseStructuralSnapshot(value, "account-a", NOW)

    expect(parsed?.servers).toHaveLength(100)
    expect(parsed?.servers.flatMap((server) => server.channels)).toHaveLength(1_000)
    expect(parsed?.servers.flatMap((server) => server.childRouteHints)).toHaveLength(3_200)
    expect(JSON.stringify(parsed).length).toBeLessThan(1_000_000)
  })
})

describe("reduceStructuralSnapshot", () => {
  it("authoritatively replaces server membership while preserving known trees", () => {
    const next = reduceStructuralSnapshot(snapshot(), {
      type: "replaceServers",
      accountId: "account-a",
      servers: [{ id: "server-a", name: "Renamed", discriminator: "0001", icon: null }],
    }, NOW + 1)!
    expect(next.serverOrder).toEqual(["server-a"])
    expect(next.servers[0]?.name).toBe("Renamed")
    expect(next.servers[0]?.channels.map((channel) => channel.id)).toEqual(["channel-a", "channel-b"])
    expect(next.folders).toEqual([{ id: "folder-1", name: "Work", serverIds: ["server-a"] }])
  })

  it("retains only child hints whose parent remains in a replaced server tree", () => {
    const next = reduceStructuralSnapshot(snapshot(), {
      type: "replaceServerTree",
      serverId: "server-a",
      categories: [{ id: "category-1", name: "General", private: false }],
      channels: [{ id: "channel-a", name: "chat", type: "text", categoryId: "category-1" }],
    }, NOW + 1)!

    expect(next.servers[0]?.childRouteHints.map((child) => child.id)).toEqual(["child-1"])
  })

  it("prunes a parent channel and every related child hint atomically", () => {
    const next = reduceStructuralSnapshot(snapshot(), {
      type: "removeChannel",
      serverId: "server-a",
      channelId: "channel-a",
    }, NOW + 1)!
    expect(next.servers[0]?.channels.map((channel) => channel.id)).toEqual(["channel-b"])
    expect(next.servers[0]?.childRouteHints).toEqual([])
  })

  it("bounds child hints by most-recent insertion", () => {
    let current = snapshot()
    current.servers[0]!.childRouteHints = []
    for (let index = 0; index < STRUCTURAL_SNAPSHOT_CHILD_LIMIT + 5; index += 1) {
      current = reduceStructuralSnapshot(current, {
        type: "upsertChildHint",
        serverId: "server-a",
        child: {
          id: `child-${index}`,
          name: `Thread ${index}`,
          type: "thread",
          parentChannelId: "channel-a",
          parentMessageId: `message-${index}`,
        },
      }, NOW + index)!
    }
    expect(current.servers[0]?.childRouteHints).toHaveLength(STRUCTURAL_SNAPSHOT_CHILD_LIMIT)
    expect(current.servers[0]?.childRouteHints[0]?.id).toBe(`child-${STRUCTURAL_SNAPSHOT_CHILD_LIMIT + 4}`)
  })

  it("reconciles every ordered tree and rail mutation through one reducer", () => {
    let current = snapshot()
    current = reduceStructuralSnapshot(current, {
      type: "replaceRail",
      serverOrder: ["server-a", "unknown", "server-a"],
      folders: [
        { id: "folder-a", name: "A", serverIds: ["server-a"] },
        { id: "folder-b", name: "B", serverIds: ["server-b"] },
      ],
    }, NOW + 1)!
    expect(current.serverOrder).toEqual(["server-a", "server-b"])

    current = reduceStructuralSnapshot(current, {
      type: "upsertCategory",
      serverId: "server-a",
      category: { id: "category-2", name: "Later", private: true },
    }, NOW + 2)!
    current = reduceStructuralSnapshot(current, {
      type: "patchCategory",
      serverId: "server-a",
      categoryId: "category-2",
      changes: { name: "First" },
      position: -5,
    }, NOW + 3)!
    current = reduceStructuralSnapshot(current, {
      type: "reorderCategories",
      serverId: "server-a",
      categoryIds: ["category-1", "missing"],
    }, NOW + 4)!
    expect(current.servers[0]?.categories.map((category) => category.id))
      .toEqual(["category-1", "category-2"])

    current = reduceStructuralSnapshot(current, {
      type: "upsertChannel",
      serverId: "server-a",
      channel: { id: "channel-c", name: "later", type: "text", categoryId: "category-2" },
    }, NOW + 5)!
    current = reduceStructuralSnapshot(current, {
      type: "patchChannel",
      serverId: "server-a",
      channelId: "channel-c",
      changes: { name: "renamed", type: "forum" },
    }, NOW + 6)!
    current = reduceStructuralSnapshot(current, {
      type: "reorderChannels",
      serverId: "server-a",
      channelIds: ["channel-c", "missing", "channel-a"],
    }, NOW + 7)!
    expect(current.servers[0]?.channels.map((channel) => channel.id))
      .toEqual(["channel-c", "channel-a", "channel-b"])

    current = reduceStructuralSnapshot(current, {
      type: "patchChildHint",
      serverId: "server-a",
      channelId: "child-1",
      name: "renamed child",
    }, NOW + 8)!
    expect(current.servers[0]?.childRouteHints[0]?.name).toBe("renamed child")
    current = reduceStructuralSnapshot(current, {
      type: "removeChildHint",
      serverId: "server-a",
      channelId: "child-1",
    }, NOW + 9)!
    expect(current.servers[0]?.childRouteHints).toEqual([])

    current = reduceStructuralSnapshot(current, {
      type: "removeCategory",
      serverId: "server-a",
      categoryId: "category-2",
    }, NOW + 10)!
    expect(current.servers[0]?.channels.find((channel) => channel.id === "channel-c")?.categoryId)
      .toBeNull()

    current = reduceStructuralSnapshot(current, {
      type: "removeServer",
      serverId: "server-a",
    }, NOW + 11)!
    expect(current.folders).toEqual([{ id: "folder-b", name: "B", serverIds: ["server-b"] }])
    expect(current.servers.map((server) => server.id)).toEqual(["server-b"])

    const defaultTimestamp = reduceStructuralSnapshot(current, {
      type: "replaceFolders",
      folders: [],
    })!
    expect(defaultTimestamp.capturedAt).toBeGreaterThanOrEqual(Date.now() - 1_000)
  })

  it("updates exactly one QueryClient owner", () => {
    const queryClient = new QueryClient()
    updateStructuralSnapshot(queryClient, {
      type: "replaceServers",
      accountId: "account-a",
      servers: [{ id: "server-a", name: "Alpha", discriminator: "0001", icon: null }],
    }, NOW)
    expect(queryClient.getQueryData(communityKeys.structuralSnapshot())).toEqual({
      schemaVersion: 1,
      accountId: "account-a",
      capturedAt: NOW,
      serverOrder: ["server-a"],
      folders: [],
      servers: [{
        id: "server-a",
        name: "Alpha",
        discriminator: "0001",
        icon: null,
        categories: [],
        channels: [],
        childRouteHints: [],
      }],
    })
  })
})

describe("structural projections", () => {
  it("drops runtime fields and derives uncategorized channels", () => {
    const tree = projectServerDetailTree({
      categories: [
        {
          id: "category-1",
          name: "General",
          private: 1,
          creatorId: "creator-1",
          channels: [{
            id: "channel-a",
            name: "chat",
            type: "text",
            topic: "secret",
            unread: true,
          }],
        },
        {
          id: "__uncategorized__",
          name: "",
          channels: [{ id: "channel-b", name: "ideas", type: "forum" }],
        },
        {
          id: "tmp_cat_1",
          name: "Pending",
          pending: true,
          channels: [{ id: "tmp_ch_1", name: "Pending", type: "text", pending: true }],
        },
      ],
    })
    expect(tree).toEqual({
      categories: [{ id: "category-1", name: "General", private: true }],
      channels: [
        { id: "channel-a", name: "chat", type: "text", categoryId: "category-1" },
        { id: "channel-b", name: "ideas", type: "forum", categoryId: null },
      ],
    })
    const projected = structuralServerToCategories({
      ...snapshot().servers[0]!,
      ...tree,
    })
    expect(projected.map((category) => category.id)).toEqual(["category-1", "__uncategorized__"])
  })

  it("projects ordered rail, folder references, and top-level directory", () => {
    const value = snapshot()
    expect(structuralSnapshotServers(value).map((server) => server.id)).toEqual(["server-b", "server-a"])
    expect(structuralSnapshotFolders(value)[0]?.servers.map((server) => server.id)).toEqual(["server-a"])
    expect(structuralSnapshotDirectory(value)[0]?.channels.map((channel) => channel.id)).toEqual([
      "channel-a",
      "channel-b",
    ])
  })
})
