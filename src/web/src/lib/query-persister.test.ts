import "fake-indexeddb/auto"
import { describe, expect, it, beforeEach } from "vitest"
import { get, set } from "idb-keyval"
import { QueryClient } from "@tanstack/react-query"
import type { PersistedClient } from "@tanstack/react-query-persist-client"
import { communityKeys } from "@/lib/query-keys"
import {
  clearPersistedCache,
  createIdbPersister,
  MAX_PERSISTED_MESSAGES_PER_SCOPE,
  MAX_PERSISTED_MESSAGE_SCOPES,
  shouldPersistQuery,
  shouldPersistQueryKey,
} from "@/lib/query-persister"

// ── shouldPersistQueryKey ─────────────────────────────────────────────────

describe("shouldPersistQueryKey", () => {
  it("does not persist channel transport message queries", () => {
    expect(shouldPersistQueryKey(communityKeys.channelMessages("ch_1"))).toBe(false)
  })

  it("does not persist DM transport message queries", () => {
    expect(shouldPersistQueryKey(communityKeys.dmMessages("dm_1"))).toBe(false)
  })

  it("persists account-scoped canonical collections", () => {
    expect(shouldPersistQueryKey(
      communityKeys.communityDbCollection("u_1", "channels"),
    )).toBe(true)
  })

  it("does not persist raw warm-shell transport queries", () => {
    expect(shouldPersistQueryKey(communityKeys.servers())).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.folders())).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.dms())).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.server("srv_1"))).toBe(false)
  })

  it("does NOT persist channel read-state snapshot (refetched on every mount)", () => {
    expect(
      shouldPersistQueryKey(communityKeys.channelReadStateSnapshot("ch_1")),
    ).toBe(false)
  })

  it("does NOT persist DM read-state snapshot (refetched on every mount)", () => {
    expect(
      shouldPersistQueryKey(communityKeys.dmReadStateSnapshot("dm_1")),
    ).toBe(false)
  })

  it("does NOT persist presence, members, sentinels, or unrelated account data", () => {
    expect(shouldPersistQueryKey(communityKeys.presence("srv_1"))).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.members("srv_1"))).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.server("__none__"))).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.server("__pending__"))).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.machines())).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.friends())).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.inbox())).toBe(false)
  })

  it("does not restore transient transport state on reload", () => {
    expect(shouldPersistQueryKey(communityKeys.forumSidebarThreads("srv_1"))).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.channelMeta("srv_1", "thread_1"))).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.message("opener_1"))).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.channelRefDirectory())).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.presence("srv_1"))).toBe(false)
    expect(shouldPersistQueryKey(
      communityKeys.communityDbCollection("u_1", "channels"),
    )).toBe(true)
  })

  it("does NOT persist pins/threads/forum tags (message-related but ephemeral)", () => {
    expect(shouldPersistQueryKey(communityKeys.pins("ch_1"))).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.threads("ch_1"))).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.forumTags("ch_1"))).toBe(false)
  })

  it("returns false for keys outside the community namespace", () => {
    expect(shouldPersistQueryKey(["auth", "session"])).toBe(false)
    expect(shouldPersistQueryKey([])).toBe(false)
  })
})

// ── createIdbPersister: serialize scrubbing ───────────────────────────────

const validServer = {
  id: "srv_1",
  name: "Server",
  discriminator: "0001",
  description: "",
  ownerId: "owner_1",
  initial: "S",
  active: false,
  unread: false,
  mentions: 0,
  isOwner: true,
  icon: null,
  official: false,
  unreadSources: [{ channelId: "ch_1", lastUnreadSeq: 1 }],
  mentionSources: [{ channelId: "ch_1", count: 1, lastSeq: 1 }],
}

const validFolder = {
  id: "folder_1",
  name: "Folder",
  position: 0,
  servers: [{ id: "srv_1", name: "Server", initial: "S", icon: null }],
}

const validDm = {
  id: "dm_1",
  userId: "peer_1",
  name: "Peer",
  discriminator: "0002",
  avatar: "P",
  avatarVersion: 1,
  status: "offline",
  preview: "hello",
  unread: false,
  lastUnreadSeq: 1,
}

function validServerDetail(id = "srv_1") {
  return {
    id,
    name: "Server",
    discriminator: "0001",
    description: "",
    icon: null,
    official: false,
    ownerId: "owner_1",
    categories: [{
      id: "cat_1",
      name: "Channels",
      private: false,
      channels: [{
        id: "ch_1",
        name: "general",
        active: false,
        unread: false,
        muted: false,
        type: "text",
        tags: ["general"],
        creatorId: null,
        pending: false,
      }],
      creatorId: null,
      pending: false,
    }],
    forumUnreadState: {
      ch_forum: { baseUnread: false, childIds: ["thread_1"] },
    },
    unreadSources: [{
      channelId: "ch_1",
      lastUnreadSeq: 1,
      lastAttentionSeq: null,
    }],
  }
}

async function readPersistedBlob(userId: string | null): Promise<PersistedClient> {
  const raw = await get<string>(
    `alook:qc:v2:${userId ?? "anon"}:client`,
  )
  if (!raw) throw new Error("no persisted blob")
  return JSON.parse(raw) as PersistedClient
}

describe("createIdbPersister — serialize filter", () => {
  beforeEach(async () => {
    await clearPersistedCache("u_1")
    await clearPersistedCache(null)
  })

  it("drops channel message pages instead of duplicating canonical messages", async () => {
    const qc = new QueryClient()
    qc.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [
        {
          messages: [
            { id: "m_real_1", content: "keep", createdAt: "2026-07-01T00:00:00.000Z" },
            { id: "temp_abc", content: "drop", createdAt: "2026-07-01T00:00:01.000Z" },
            { id: "m_real_2", content: "keep", createdAt: "2026-07-01T00:00:02.000Z" },
          ],
          hasMore: false,
          latestSeq: 0,
        },
      ],
      pageParams: [{ mode: "newest" }],
    })

    const persister = createIdbPersister("u_1")
    await persister.persistClient({
      timestamp: Date.now(),
      buster: "v1",
      clientState: {
        mutations: [],
        queries: [
          {
            queryKey: communityKeys.channelMessages("ch_1"),
            queryHash: JSON.stringify(communityKeys.channelMessages("ch_1")),
            state: qc.getQueryState(communityKeys.channelMessages("ch_1"))!,
          },
        ],
      },
    })

    const blob = await readPersistedBlob("u_1")
    expect(blob.clientState.queries).toEqual([])
  })

  it("drops DM message pages instead of duplicating canonical messages", async () => {
    const qc = new QueryClient()
    qc.setQueryData(communityKeys.dmMessages("dm_1"), {
      pages: [
        {
          messages: [
            { id: "m_ok", content: "keep", createdAt: "2026-07-01T00:00:00.000Z" },
            {
              id: "m_bad",
              content: "drop",
              createdAt: "2026-07-01T00:00:01.000Z",
              failed: true,
            },
          ],
          hasMore: false,
          latestSeq: 0,
        },
      ],
      pageParams: [{ mode: "newest" }],
    })

    const persister = createIdbPersister("u_1")
    await persister.persistClient({
      timestamp: Date.now(),
      buster: "v1",
      clientState: {
        mutations: [],
        queries: [
          {
            queryKey: communityKeys.dmMessages("dm_1"),
            queryHash: JSON.stringify(communityKeys.dmMessages("dm_1")),
            state: qc.getQueryState(communityKeys.dmMessages("dm_1"))!,
          },
        ],
      },
    })

    const blob = await readPersistedBlob("u_1")
    expect(blob.clientState.queries).toEqual([])
  })

  it("drops valid raw shell queries and server details", async () => {
    const qc = new QueryClient()
    qc.setQueryData(communityKeys.servers(), { servers: [validServer] }, { updatedAt: 1 })
    qc.setQueryData(communityKeys.folders(), { folders: [validFolder] }, { updatedAt: 2 })
    qc.setQueryData(communityKeys.dms(), { conversations: [validDm] }, { updatedAt: 3 })
    const detailKeys = Array.from(
      { length: 2 },
      (_, index) => communityKeys.server(`srv_${index}`),
    )
    detailKeys.forEach((key, index) => {
      qc.setQueryData(key, validServerDetail(key[2]), { updatedAt: index + 10 })
    })
    const queryKeys = [
      communityKeys.servers(),
      communityKeys.folders(),
      communityKeys.dms(),
      ...detailKeys,
    ]

    await createIdbPersister("u_1").persistClient({
      timestamp: Date.now(),
      buster: "v1",
      clientState: {
        mutations: [],
        queries: queryKeys.map((queryKey) => ({
          queryKey,
          queryHash: JSON.stringify(queryKey),
          state: qc.getQueryState(queryKey)!,
        })),
      },
    })

    const blob = await readPersistedBlob("u_1")
    expect(blob.clientState.queries.map((query) => query.queryKey)).toEqual([])
  })

  it("windows canonical server trees, message tails, and referenced profiles", async () => {
    const qc = new QueryClient()
    const detailKeys = Array.from({ length: 7 }, (_, index) => communityKeys.server(`srv_${index}`))
    detailKeys.forEach((key, index) => {
      qc.setQueryData(key, validServerDetail(key[2]), { updatedAt: index + 1 })
    })
    const dmChannels = Array.from({ length: MAX_PERSISTED_MESSAGE_SCOPES + 2 }, (_, index) => ({
      id: `dm_${index}`,
      serverId: null,
      categoryId: null,
      name: "",
      type: "dm" as const,
      parentChannelId: null,
      parentMessageId: null,
      creatorId: null,
      position: 0,
      archived: false,
      muted: false,
      unread: false,
      tags: [],
      pending: false,
      lastMessageAt: null,
    }))
    const serverChannels = Array.from({ length: 7 }, (_, index) => ({
      ...dmChannels[0],
      id: `ch_${index}`,
      serverId: `srv_${index}`,
      type: "text" as const,
    }))
    const messages = [...dmChannels.flatMap((channel, scopeIndex) => (
      Array.from({ length: MAX_PERSISTED_MESSAGES_PER_SCOPE + 1 }, (_, messageIndex) => ({
        id: `${channel.id}:m_${messageIndex}`,
        channelId: channel.id,
        type: "chat" as const,
        seq: messageIndex,
        createdAt: `2026-09-${String(scopeIndex + 1).padStart(2, "0")}T00:00:00.000Z`,
        authorId: `author_${scopeIndex}`,
        ...(scopeIndex === MAX_PERSISTED_MESSAGE_SCOPES + 1
          && messageIndex === MAX_PERSISTED_MESSAGES_PER_SCOPE ? {
          approval: {
            otherProfile: { id: "approval_other" },
            botProfile: { id: "approval_bot" },
            waitingOnProfile: { id: "approval_waiting" },
          },
          replyTo: { authorId: "reply_author" },
          thread: { participants: [{ id: "thread_participant" }] },
        } : {}),
      }))
    )), {
      id: "orphan-message",
      channelId: "not-retained",
      type: "chat" as const,
      seq: 1,
      createdAt: "2026-09-25T00:00:00.000Z",
      authorId: "orphan-author",
    }]
    messages.push(
      {
        id: "dm_0:tie_a",
        channelId: "dm_0",
        type: "chat",
        seq: 100,
        createdAt: "2026-09-30T00:00:00.000Z",
        authorId: "author_0",
      },
      {
        id: "dm_0:tie_b",
        channelId: "dm_0",
        type: "chat",
        seq: 100,
        createdAt: "2026-09-30T00:00:00.000Z",
        authorId: "author_0",
      },
    )
    const collectionData = {
      servers: Array.from({ length: 7 }, (_, index) => ({
        id: `srv_${index}`,
        name: `Server ${index}`,
        discriminator: "0001",
        description: "",
        ownerId: `owner_${index}`,
        icon: null,
        official: false,
        isOwner: false,
        unread: false,
        mentions: 0,
      })),
      channels: [...dmChannels, ...serverChannels],
      categories: Array.from({ length: 7 }, (_, index) => ({
        id: `cat_${index}`,
        serverId: `srv_${index}`,
        name: "Channels",
        position: 0,
        private: false,
        pending: false,
      })),
      messages,
      profiles: [
        ...Array.from({ length: MAX_PERSISTED_MESSAGE_SCOPES + 2 }, (_, index) => ({
          userId: `author_${index}`,
          name: `Author ${index}`,
          discriminator: "0001",
          avatar: "A",
          avatarVersion: 0,
        })),
        ...Array.from({ length: 7 }, (_, index) => ({
          userId: `owner_${index}`,
          name: `Owner ${index}`,
          discriminator: "0001",
          avatar: "O",
          avatarVersion: 0,
        })),
        ...[
          "approval_other", "approval_bot", "approval_waiting", "reply_author",
          "thread_participant", "dm_peer", "roster_only", "notify_only",
        ].map(
          (userId) => ({
            userId,
            name: userId,
            discriminator: "0001",
            avatar: "P",
            avatarVersion: 0,
          }),
        ),
        { userId: "u_1", name: "Viewer", discriminator: "0001", avatar: "V", avatarVersion: 0 },
        { userId: "orphan", name: "Orphan", discriminator: "0001", avatar: "O", avatarVersion: 0 },
      ],
      serverMemberships: [
        { id: "srv_6:u_1", serverId: "srv_6", userId: "u_1", role: "member", viewer: true },
        { id: "srv_6:roster_only", serverId: "srv_6", userId: "roster_only", role: "member", viewer: false },
      ],
      channelMemberships: [
        { id: "dm_0:u_1:access", channelId: "dm_0", userId: "u_1", relation: "access" },
        { id: "dm_0:dm_peer:access", channelId: "dm_0", userId: "dm_peer", relation: "access" },
        { id: "dm_0:notify_only:notify", channelId: "dm_0", userId: "notify_only", relation: "notify" },
        { id: "ch_6:u_1:access", channelId: "ch_6", userId: "u_1", relation: "access" },
        { id: "ch_6:u_1:notify", channelId: "ch_6", userId: "u_1", relation: "notify" },
        { id: "ch_6:roster_only:access", channelId: "ch_6", userId: "roster_only", relation: "access" },
      ],
      readStates: [
        { channelId: "ch_0", lastReadMessageId: "old", lastReadAt: "2026-09-01T00:00:00.000Z", lastReadSeq: 1 },
        { channelId: "dm_0", lastReadMessageId: "dm", lastReadAt: "2026-09-02T00:00:00.000Z", lastReadSeq: 2 },
      ],
      readStateClock: [{ id: "account", revision: 9 }],
    }
    for (const [name, data] of Object.entries(collectionData)) {
      qc.setQueryData(communityKeys.communityDbCollection("u_1", name), data)
    }
    const wrongAccountKey = communityKeys.communityDbCollection("other", "channels")
    const unknownCollectionKey = communityKeys.communityDbCollection("u_1", "unknown")
    const malformedCollectionKey = communityKeys.communityDbCollection("u_1", "folders")
    qc.setQueryData(wrongAccountKey, dmChannels)
    qc.setQueryData(unknownCollectionKey, [])
    qc.setQueryData(malformedCollectionKey, [{ id: "malformed" }])
    qc.setQueryData(communityKeys.servers(), null)
    const keys = [
      ...detailKeys,
      ...Object.keys(collectionData).map((name) => communityKeys.communityDbCollection("u_1", name)),
      wrongAccountKey,
      unknownCollectionKey,
      malformedCollectionKey,
      communityKeys.servers(),
    ]
    await createIdbPersister("u_1").persistClient({
      timestamp: Date.now(),
      buster: "v2",
      clientState: {
        mutations: [],
        queries: keys.map((queryKey) => ({
          queryKey,
          queryHash: JSON.stringify(queryKey),
          state: qc.getQueryState(queryKey)!,
        })),
      },
    })

    const blob = await readPersistedBlob("u_1")
    const collection = (name: string) => blob.clientState.queries.find((query) => (
      query.queryKey[1] === "db" && query.queryKey[3] === name
    ))?.state.data as unknown[]
    const persistedMessages = collection("messages") as typeof messages
    expect(new Set(persistedMessages.map((message) => message.channelId)).size)
      .toBe(MAX_PERSISTED_MESSAGE_SCOPES)
    expect(persistedMessages).toHaveLength(
      MAX_PERSISTED_MESSAGE_SCOPES * MAX_PERSISTED_MESSAGES_PER_SCOPE,
    )
    expect(persistedMessages.filter((message) => message.id.startsWith("dm_0:tie_"))
      .map((message) => message.id)).toEqual(["dm_0:tie_b", "dm_0:tie_a"])
    expect(Math.min(...persistedMessages.map((message) => message.seq))).toBe(1)
    expect((collection("categories") as Array<{ serverId: string }>).map((row) => row.serverId))
      .toEqual(["srv_0", "srv_1", "srv_2", "srv_3", "srv_4", "srv_5", "srv_6"])
    expect((collection("servers") as Array<{ id: string; position?: number }>).map((row) => ({
      id: row.id,
      position: row.position,
    }))).toEqual(Array.from({ length: 7 }, (_, index) => ({
      id: `srv_${index}`,
      position: undefined,
    })))
    expect((collection("channels") as Array<{ serverId: string | null }>).filter(
      (row) => row.serverId !== null,
    ).map((row) => row.serverId)).toEqual([
      "srv_0", "srv_1", "srv_2", "srv_3", "srv_4", "srv_5", "srv_6",
    ])
    const profileIds = new Set((collection("profiles") as Array<{ userId: string }>).map(
      (row) => row.userId,
    ))
    expect(profileIds.has("orphan")).toBe(false)
    expect(profileIds.has("u_1")).toBe(true)
    expect([...profileIds]).toEqual(expect.arrayContaining([
      "owner_0",
      "owner_6",
      "approval_other",
      "approval_bot",
      "approval_waiting",
      "reply_author",
      "thread_participant",
      "dm_peer",
    ]))
    expect(profileIds.has("roster_only")).toBe(false)
    expect(profileIds.has("notify_only")).toBe(false)
    expect(collection("serverMemberships")).toEqual([
      expect.objectContaining({ userId: "u_1", viewer: true }),
    ])
    expect(collection("channelMemberships")).toEqual(expect.arrayContaining([
      expect.objectContaining({ channelId: "dm_0", userId: "u_1", relation: "access" }),
      expect.objectContaining({ channelId: "dm_0", userId: "dm_peer", relation: "access" }),
      expect.objectContaining({ channelId: "ch_6", userId: "u_1", relation: "access" }),
      expect.objectContaining({ channelId: "ch_6", userId: "u_1", relation: "notify" }),
    ]))
    expect(collection("channelMemberships")).toHaveLength(4)
    expect((collection("readStates") as Array<{ channelId: string }>).map((row) => row.channelId))
      .toEqual(["ch_0", "dm_0"])
    expect(collection("readStateClock")).toEqual([{ id: "account", revision: 9 }])
    expect(blob.clientState.queries.some((query) => (
      query.queryKey[1] === "channel" || query.queryKey[1] === "dm"
    ))).toBe(false)
  })

  it("drops malformed shell payloads during deserialize scrub", async () => {
    const qc = new QueryClient()
    qc.setQueryData(communityKeys.servers(), { nope: [] })
    qc.setQueryData(communityKeys.server("srv_1"), { id: "other", categories: [] })
    const injected: PersistedClient = {
      timestamp: Date.now(),
      buster: "v1",
      clientState: {
        mutations: [],
        queries: [communityKeys.servers(), communityKeys.server("srv_1")].map((queryKey) => ({
          queryKey,
          queryHash: JSON.stringify(queryKey),
          state: qc.getQueryState(queryKey)!,
        })),
      },
    }
    await set("alook:qc:v2:u_1:client", JSON.stringify(injected))
    expect((await createIdbPersister("u_1").restoreClient())?.clientState.queries).toEqual([])
  })

  it.each([
    [
      "server list nested unread source",
      communityKeys.servers(),
      { servers: [{ ...validServer, unreadSources: [null] }] },
    ],
    [
      "folder nested server",
      communityKeys.folders(),
      { folders: [{ ...validFolder, servers: [null] }] },
    ],
    [
      "DM nested identity",
      communityKeys.dms(),
      { conversations: [{ ...validDm, avatarVersion: "old-schema" }] },
    ],
    [
      "server detail category",
      communityKeys.server("srv_bad"),
      { ...validServerDetail("srv_bad"), categories: [null] },
    ],
    [
      "server detail nested channel",
      communityKeys.server("srv_bad"),
      {
        ...validServerDetail("srv_bad"),
        categories: [{
          ...validServerDetail("srv_bad").categories[0],
          channels: [null],
        }],
      },
    ],
    [
      "server detail nested forum unread state",
      communityKeys.server("srv_bad"),
      {
        ...validServerDetail("srv_bad"),
        forumUnreadState: { ch_forum: { baseUnread: false, childIds: [null] } },
      },
    ],
  ])("drops a malformed %s query as one unit during restore", async (_label, queryKey, data) => {
    const qc = new QueryClient()
    qc.setQueryData(queryKey, data)
    const injected: PersistedClient = {
      timestamp: Date.now(),
      buster: "v1",
      clientState: {
        mutations: [],
        queries: [{
          queryKey,
          queryHash: JSON.stringify(queryKey),
          state: qc.getQueryState(queryKey)!,
        }],
      },
    }
    await set("alook:qc:v2:u_1:client", JSON.stringify(injected))

    expect((await createIdbPersister("u_1").restoreClient())?.clientState.queries).toEqual([])
  })
})

describe("shouldPersistQuery", () => {
  it("persists only canonical collection keys regardless of data", () => {
    expect(
      shouldPersistQuery(
        communityKeys.communityDbCollection("u_1", "channels"),
        undefined,
      ),
    ).toBe(true)
    expect(shouldPersistQuery(communityKeys.servers(), { servers: [] })).toBe(false)
    expect(shouldPersistQuery(communityKeys.channelMessages("ch_1"), undefined)).toBe(false)
    expect(
      shouldPersistQuery(communityKeys.channelReadStateSnapshot("ch_1"), {
        lastReadMessageId: "m_1",
      }),
    ).toBe(false)
  })
})

// ── User-scoped namespaces ────────────────────────────────────────────────

describe("createIdbPersister — user scoping", () => {
  beforeEach(async () => {
    await clearPersistedCache("u_alice")
    await clearPersistedCache("u_bob")
  })

  it("writes to a per-user IDB key so accounts don't leak", async () => {
    const alice = createIdbPersister("u_alice")
    const bob = createIdbPersister("u_bob")
    const stateForAlice: PersistedClient = {
      timestamp: 1,
      buster: "v1",
      clientState: { mutations: [], queries: [] },
    }
    const stateForBob: PersistedClient = {
      timestamp: 2,
      buster: "v1",
      clientState: { mutations: [], queries: [] },
    }
    await alice.persistClient(stateForAlice)
    await bob.persistClient(stateForBob)

    const aliceBlob = await readPersistedBlob("u_alice")
    const bobBlob = await readPersistedBlob("u_bob")
    expect(aliceBlob.timestamp).toBe(1)
    expect(bobBlob.timestamp).toBe(2)
  })

  it("clearPersistedCache only removes the target user's blob", async () => {
    const alice = createIdbPersister("u_alice")
    const bob = createIdbPersister("u_bob")
    await alice.persistClient({
      timestamp: 1,
      buster: "v1",
      clientState: { mutations: [], queries: [] },
    })
    await bob.persistClient({
      timestamp: 2,
      buster: "v1",
      clientState: { mutations: [], queries: [] },
    })

    await clearPersistedCache("u_alice")

    // Alice's blob is gone but Bob's is untouched.
    expect(await get(`alook:qc:v2:u_alice:client`)).toBeUndefined()
    const bobBlob = await readPersistedBlob("u_bob")
    expect(bobBlob.timestamp).toBe(2)
  })

  it("removes the current generation through the persister adapter", async () => {
    const persister = createIdbPersister("u_remove")
    await persister.persistClient({
      timestamp: 4,
      buster: "v1",
      clientState: { mutations: [], queries: [] },
    })

    await persister.removeClient()

    expect(await get("alook:qc:v2:u_remove:client")).toBeUndefined()
  })

  it("blocks a delayed writer created before clear", async () => {
    const stale = createIdbPersister("u_alice")
    await clearPersistedCache("u_alice")
    await stale.persistClient({
      timestamp: 3,
      buster: "v1",
      clientState: { mutations: [], queries: [] },
    })
    expect(await get(`alook:qc:v2:u_alice:client`)).toBeUndefined()
  })
})
