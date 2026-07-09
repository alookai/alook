import "fake-indexeddb/auto"
import { describe, expect, it, beforeEach } from "vitest"
import { get } from "idb-keyval"
import { QueryClient } from "@tanstack/react-query"
import type { PersistedClient } from "@tanstack/query-persist-client-core"
import { communityKeys } from "@/lib/query-keys"
import {
  clearPersistedCache,
  createIdbPersister,
  shouldPersistQueryKey,
} from "@/lib/query-persister"
import type { MessagesPage } from "@/hooks/community/use-messages"

// ── shouldPersistQueryKey ─────────────────────────────────────────────────

describe("shouldPersistQueryKey", () => {
  it("persists channel message queries", () => {
    expect(shouldPersistQueryKey(communityKeys.channelMessages("ch_1"))).toBe(true)
  })

  it("persists DM message queries", () => {
    expect(shouldPersistQueryKey(communityKeys.dmMessages("dm_1"))).toBe(true)
  })

  it("persists channel read-state snapshot", () => {
    expect(
      shouldPersistQueryKey(communityKeys.channelReadStateSnapshot("ch_1")),
    ).toBe(true)
  })

  it("persists DM read-state snapshot", () => {
    expect(
      shouldPersistQueryKey(communityKeys.dmReadStateSnapshot("dm_1")),
    ).toBe(true)
  })

  it("does NOT persist server list, presence, members, or machines", () => {
    expect(shouldPersistQueryKey(communityKeys.servers())).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.presence("srv_1"))).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.members("srv_1"))).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.machines())).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.friends())).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.dms())).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.inbox())).toBe(false)
  })

  it("does NOT persist pins/threads/forum posts (message-related but ephemeral)", () => {
    expect(shouldPersistQueryKey(communityKeys.pins("ch_1"))).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.threads("ch_1"))).toBe(false)
    expect(shouldPersistQueryKey(communityKeys.forumPosts("ch_1"))).toBe(false)
  })

  it("returns false for keys outside the community namespace", () => {
    expect(shouldPersistQueryKey(["auth", "session"])).toBe(false)
    expect(shouldPersistQueryKey([])).toBe(false)
  })
})

// ── createIdbPersister: serialize scrubbing ───────────────────────────────

function makePage(messages: Array<Partial<MessagesPage["messages"][number]>>): MessagesPage {
  return {
    messages: messages as MessagesPage["messages"],
    hasMore: false,
    latestSeq: 0,
  }
}

async function readPersistedBlob(userId: string | null): Promise<PersistedClient> {
  const raw = await get<string>(
    `alook:qc:v1:${userId ?? "anon"}:client`,
  )
  if (!raw) throw new Error("no persisted blob")
  return JSON.parse(raw) as PersistedClient
}

describe("createIdbPersister — serialize filter", () => {
  beforeEach(async () => {
    await clearPersistedCache("u_1")
    await clearPersistedCache(null)
  })

  it("strips temp_* rows from persisted channel message pages", async () => {
    const qc = new QueryClient()
    qc.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [
        makePage([
          { id: "m_real_1", content: "keep", createdAt: "2026-07-01T00:00:00.000Z" },
          { id: "temp_abc", content: "drop", createdAt: "2026-07-01T00:00:01.000Z" },
          { id: "m_real_2", content: "keep", createdAt: "2026-07-01T00:00:02.000Z" },
        ]),
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
    const q = blob.clientState.queries[0]
    const data = q.state.data as { pages: MessagesPage[] }
    expect(data.pages[0].messages.map((m) => m.id)).toEqual([
      "m_real_1",
      "m_real_2",
    ])
  })

  it("strips failed:true rows from persisted DM message pages", async () => {
    const qc = new QueryClient()
    qc.setQueryData(communityKeys.dmMessages("dm_1"), {
      pages: [
        makePage([
          { id: "m_ok", content: "keep", createdAt: "2026-07-01T00:00:00.000Z" },
          {
            id: "m_bad",
            content: "drop",
            createdAt: "2026-07-01T00:00:01.000Z",
            failed: true,
          },
        ]),
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
    const q = blob.clientState.queries[0]
    const data = q.state.data as { pages: MessagesPage[] }
    expect(data.pages[0].messages.map((m) => m.id)).toEqual(["m_ok"])
  })

  it("leaves non-message queries untouched", async () => {
    const persister = createIdbPersister("u_1")
    const snapshotKey = communityKeys.channelReadStateSnapshot("ch_1")
    await persister.persistClient({
      timestamp: Date.now(),
      buster: "v1",
      clientState: {
        mutations: [],
        queries: [
          {
            queryKey: snapshotKey,
            queryHash: JSON.stringify(snapshotKey),
            state: {
              data: { lastReadMessageId: "m_42", lastReadAt: null, lastReadSeq: 12 },
              // Enough to satisfy the persister's `state` shape; TanStack
              // ignores fields it doesn't recognise on restore.
              dataUpdateCount: 1,
              dataUpdatedAt: Date.now(),
              error: null,
              errorUpdateCount: 0,
              errorUpdatedAt: 0,
              fetchFailureCount: 0,
              fetchFailureReason: null,
              fetchMeta: null,
              isInvalidated: false,
              status: "success",
              fetchStatus: "idle",
            } as unknown as Parameters<typeof persister.persistClient>[0]["clientState"]["queries"][number]["state"],
          },
        ],
      },
    })

    const blob = await readPersistedBlob("u_1")
    const data = blob.clientState.queries[0].state.data as {
      lastReadMessageId: string
      lastReadSeq: number
    }
    expect(data.lastReadMessageId).toBe("m_42")
    expect(data.lastReadSeq).toBe(12)
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
    expect(await get(`alook:qc:v1:u_alice:client`)).toBeUndefined()
    const bobBlob = await readPersistedBlob("u_bob")
    expect(bobBlob.timestamp).toBe(2)
  })
})
