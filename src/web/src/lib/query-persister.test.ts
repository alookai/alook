import "fake-indexeddb/auto"
import { describe, expect, it, beforeEach } from "vitest"
import { get } from "idb-keyval"
import { QueryClient } from "@tanstack/react-query"
import type { PersistedClient } from "@tanstack/react-query-persist-client"
import { communityKeys } from "@/lib/query-keys"
import {
  clearPersistedCache,
  createIdbPersister,
  isTrustedMessagesPageZero,
  shouldPersistQuery,
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

  it("drops message queries whose pages[0] is a since-mode envelope (no hasMore flag on tail)", async () => {
    const qc = new QueryClient()
    // Simulate a since-mode envelope: only `hasMoreNewer` / `newerCursor` /
    // `latestSeq` — no `hasMore`, no `hasMoreOlder`. If we persisted this,
    // the next mount would compute `hasMoreOlder ?? hasMore ?? false === false`
    // and silently claim there's no more history.
    qc.setQueryData(communityKeys.channelMessages("ch_since"), {
      pages: [
        {
          messages: [
            { id: "m_1", content: "x", createdAt: "2026-07-01T00:00:00.000Z" },
          ],
          hasMoreNewer: true,
          newerCursor: "cur_new",
          latestSeq: 42,
        },
      ],
      pageParams: [{ mode: "since", since: "cur_since" }],
    })

    const persister = createIdbPersister("u_1")
    await persister.persistClient({
      timestamp: Date.now(),
      buster: "v1",
      clientState: {
        mutations: [],
        queries: [
          {
            queryKey: communityKeys.channelMessages("ch_since"),
            queryHash: JSON.stringify(communityKeys.channelMessages("ch_since")),
            state: qc.getQueryState(communityKeys.channelMessages("ch_since"))!,
          },
        ],
      },
    })

    const blob = await readPersistedBlob("u_1")
    // The whole query was dropped by scrubDehydratedClient — nothing to
    // rehydrate, so the next mount refetches from scratch (self-healing).
    expect(blob.clientState.queries).toHaveLength(0)
  })

  it("keeps message queries whose pages[0] is anchor-mode with tail attached (hasMoreNewer=false)", async () => {
    const qc = new QueryClient()
    qc.setQueryData(communityKeys.channelMessages("ch_anchor"), {
      pages: [
        {
          messages: [
            { id: "m_1", content: "x", createdAt: "2026-07-01T00:00:00.000Z" },
          ],
          hasMoreOlder: true,
          olderCursor: "cur_older",
          hasMoreNewer: false,
          latestSeq: 42,
        },
      ],
      pageParams: [{ mode: "anchor", anchor: "m_1" }],
    })

    const persister = createIdbPersister("u_1")
    await persister.persistClient({
      timestamp: Date.now(),
      buster: "v1",
      clientState: {
        mutations: [],
        queries: [
          {
            queryKey: communityKeys.channelMessages("ch_anchor"),
            queryHash: JSON.stringify(communityKeys.channelMessages("ch_anchor")),
            state: qc.getQueryState(communityKeys.channelMessages("ch_anchor"))!,
          },
        ],
      },
    })

    const blob = await readPersistedBlob("u_1")
    expect(blob.clientState.queries).toHaveLength(1)
  })

  it("keeps message queries whose pages[0] is legacy newest-mode (hasMore defined, no anchor flags)", async () => {
    const qc = new QueryClient()
    qc.setQueryData(communityKeys.channelMessages("ch_legacy"), {
      pages: [
        makePage([
          { id: "m_1", content: "x", createdAt: "2026-07-01T00:00:00.000Z" },
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
            queryKey: communityKeys.channelMessages("ch_legacy"),
            queryHash: JSON.stringify(communityKeys.channelMessages("ch_legacy")),
            state: qc.getQueryState(communityKeys.channelMessages("ch_legacy"))!,
          },
        ],
      },
    })

    const blob = await readPersistedBlob("u_1")
    expect(blob.clientState.queries).toHaveLength(1)
  })
})

// ── isTrustedMessagesPageZero + shouldPersistQuery invariants ────────────

describe("isTrustedMessagesPageZero", () => {
  it("trusts legacy newest-mode envelopes (hasMore defined, no anchor flags)", () => {
    expect(
      isTrustedMessagesPageZero({ messages: [], hasMore: false, latestSeq: 0 }),
    ).toBe(true)
    expect(
      isTrustedMessagesPageZero({ messages: [], hasMore: true, latestSeq: 0 }),
    ).toBe(true)
  })

  it("trusts anchor-mode envelopes with the tail attached (hasMoreNewer=false)", () => {
    expect(
      isTrustedMessagesPageZero({
        messages: [],
        hasMoreOlder: true,
        hasMoreNewer: false,
        latestSeq: 0,
      }),
    ).toBe(true)
  })

  it("rejects since-mode envelopes (no hasMore flag on tail)", () => {
    expect(
      isTrustedMessagesPageZero({
        messages: [],
        hasMoreNewer: true,
        newerCursor: "c",
        latestSeq: 0,
      }),
    ).toBe(false)
  })

  it("rejects anchor-mode envelopes that still have newer history above (hasMoreNewer=true)", () => {
    expect(
      isTrustedMessagesPageZero({
        messages: [],
        hasMoreOlder: false,
        hasMoreNewer: true,
        latestSeq: 0,
      }),
    ).toBe(false)
  })

  it("rejects undefined pages", () => {
    expect(isTrustedMessagesPageZero(undefined)).toBe(false)
  })
})

describe("shouldPersistQuery", () => {
  it("returns true for a message query with a trusted page[0]", () => {
    expect(
      shouldPersistQuery(communityKeys.channelMessages("ch_1"), {
        pages: [{ messages: [], hasMore: false, latestSeq: 0 }],
        pageParams: [],
      }),
    ).toBe(true)
  })

  it("returns false for a message query with an untrusted page[0]", () => {
    expect(
      shouldPersistQuery(communityKeys.channelMessages("ch_1"), {
        pages: [{ messages: [], hasMoreNewer: true, newerCursor: "c", latestSeq: 0 }],
        pageParams: [],
      }),
    ).toBe(false)
  })

  it("returns false for message queries with empty pages", () => {
    expect(
      shouldPersistQuery(communityKeys.channelMessages("ch_1"), {
        pages: [],
        pageParams: [],
      }),
    ).toBe(false)
  })

  it("returns false for keys outside the allowlist regardless of data", () => {
    expect(shouldPersistQuery(communityKeys.servers(), undefined)).toBe(false)
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
    expect(await get(`alook:qc:v1:u_alice:client`)).toBeUndefined()
    const bobBlob = await readPersistedBlob("u_bob")
    expect(bobBlob.timestamp).toBe(2)
  })
})
