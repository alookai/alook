import { QueryClient } from "@tanstack/react-query"
import type { AccountAttentionSnapshot } from "@alook/shared"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { apiFetch } from "@/lib/api/client"
import {
  createCommunityDbRegistry,
  type CommunityDbRegistry,
} from "./collections"
import {
  clearAttentionOptimistically,
  clearAttentionScopeOptimistically,
  commitAttentionItemsOptimisticSnapshot,
  commitAttentionOptimisticSnapshot,
  commitAttentionScopeOptimisticSnapshot,
  removeAttentionItemsOptimistically,
  ingestAttentionIncluded,
} from "./sync"
import { createAccountAttentionResourceQueryFn } from "./account-attention-resource"
import { dmsResourceKey, type DmsResource } from "./dms-resource"

vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn() }))

const emptyIncluded = {
  servers: [],
  channels: [],
  dms: [],
  profiles: [],
  messages: [],
}

function attentionSnapshot(): AccountAttentionSnapshot {
  return {
    scopes: [{
      scopeId: "channel-1",
      channelId: "channel-1",
      serverId: "server-1",
      parentChannelId: null,
      ordinaryUnread: true,
      lastUnreadSeq: 4,
      lastAttentionSeq: 4,
      attentionCount: 1,
    }],
    items: [{
      id: "mention:message-4",
      kind: "mention",
      sourceId: "message-4",
      scopeId: "channel-1",
      messageId: "message-4",
      actorUserId: "peer-1",
      createdAt: "2026-09-29T00:00:00.000Z",
    }],
    limit: 100,
    truncated: false,
    included: {
      servers: [{ id: "server-1", name: "Server", discriminator: "0001" }],
      channels: [{
        id: "channel-1",
        serverId: "server-1",
        name: "General",
        type: "text",
        parentChannelId: null,
        parentMessageId: null,
        creatorId: null,
        archived: false,
        lastMessageAt: "2026-09-29T00:00:00.000Z",
      }],
      dms: [],
      profiles: [{
        userId: "peer-1",
        name: "Peer",
        discriminator: "0002",
        avatar: "",
        avatarVersion: 0,
      }],
      messages: [{
        id: "message-4",
        channelId: "channel-1",
        type: "chat",
        authorId: "peer-1",
        authorName: "Peer",
        seq: 4,
        createdAt: "2026-09-29T00:00:00.000Z",
        content: "hello",
      }],
    },
  }
}

let registry: CommunityDbRegistry | null = null
let currentAttention: AccountAttentionSnapshot

beforeEach(() => {
  currentAttention = attentionSnapshot()
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === "/api/community/users/me/read-state") {
      return { revision: 0, readStates: [] }
    }
    if (path === "/api/community/users/me/server-folders") return { folders: [] }
    if (path === "/api/community/users/me/notifications") return []
    if (path === "/api/community/users/me/attention") return currentAttention
    if (path === "/api/community/users/me/dms") return { conversations: [] }
    if (path === "/api/community/servers") return { servers: [] }
    throw new Error(`unexpected API fetch: ${path}`)
  })
})

afterEach(async () => {
  await registry?.cleanup()
  registry = null
  vi.clearAllMocks()
})

async function readyRegistry() {
  registry = createCommunityDbRegistry(
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    "viewer",
  )
  await registry.preload()
  return registry
}

async function refetchAttention(db: CommunityDbRegistry) {
  await db.collections.attentionScopes.utils.refetch({ throwOnError: true })
}

describe("account attention resource descriptor", () => {
  it("rejects a stale attention snapshot before canonical selection", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ ...attentionSnapshot(), stale: true } as never)
    const query = createAccountAttentionResourceQueryFn(
      new QueryClient(),
      () => [],
    )

    await expect(query({} as never)).rejects.toMatchObject({
      name: "StaleAttentionReadError",
      message: "stale D1 attention read",
    })
  })

  it("shares one raw acquisition across both canonical collections", async () => {
    const db = await readyRegistry()

    expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => (
      path === "/api/community/users/me/attention"
    ))).toHaveLength(1)
    expect(db.collections.attentionScopes.get("channel-1"))
      .toMatchObject({ attentionCount: 1 })
    expect(db.collections.attentionItems.get("mention:message-4"))
      .toMatchObject({ messageId: "message-4" })
  })

  it("keeps clear, scope, and item fences over stale reads until each fence settles", async () => {
    const db = await readyRegistry()

    const clear = clearAttentionOptimistically(db)
    await refetchAttention(db)
    expect([...db.collections.attentionScopes.values()]).toEqual([])
    expect([...db.collections.attentionItems.values()]).toEqual([])
    commitAttentionOptimisticSnapshot(db, clear)
    await refetchAttention(db)
    expect(db.collections.attentionScopes.get("channel-1")).toBeDefined()
    expect(db.collections.attentionItems.get("mention:message-4")).toBeDefined()

    const scope = clearAttentionScopeOptimistically(db, "channel-1", 4)
    await refetchAttention(db)
    expect(db.collections.attentionScopes.get("channel-1")).toBeUndefined()
    expect(db.collections.attentionItems.get("mention:message-4")).toBeUndefined()
    commitAttentionScopeOptimisticSnapshot(db, scope)
    await refetchAttention(db)
    expect(db.collections.attentionScopes.get("channel-1")).toBeDefined()
    expect(db.collections.attentionItems.get("mention:message-4")).toBeDefined()

    const item = removeAttentionItemsOptimistically(db, (row) => (
      row.id === "mention:message-4"
    ))
    await refetchAttention(db)
    expect(db.collections.attentionScopes.get("channel-1"))
      .toMatchObject({ attentionCount: 0, lastAttentionSeq: null })
    expect(db.collections.attentionItems.get("mention:message-4")).toBeUndefined()
    commitAttentionItemsOptimisticSnapshot(db, item)
    await refetchAttention(db)
    expect(db.collections.attentionScopes.get("channel-1"))
      .toMatchObject({ attentionCount: 1, lastAttentionSeq: 4 })
    expect(db.collections.attentionItems.get("mention:message-4")).toBeDefined()
  })

  it("replaces the complete attention truth on an explicit refetch", async () => {
    const db = await readyRegistry()
    currentAttention = {
      scopes: [],
      items: [],
      limit: 100,
      truncated: false,
      included: emptyIncluded,
    }

    await refetchAttention(db)

    expect([...db.collections.attentionScopes.values()]).toEqual([])
    expect([...db.collections.attentionItems.values()]).toEqual([])
  })

  it("anchors included owners in the account channel resource", async () => {
    const db = await readyRegistry()

    ingestAttentionIncluded(db, currentAttention.included)
    await Promise.resolve()

    expect(db.queryClient.getQueryData<DmsResource>(dmsResourceKey("viewer")))
      .toMatchObject({
        channels: [expect.objectContaining({ id: "channel-1" })],
        profiles: [expect.objectContaining({ userId: "peer-1" })],
      })
    expect(db.collections.channels.get("channel-1")).toBeDefined()
    expect(db.collections.profiles.get("peer-1")).toBeDefined()
    expect(db.collections.messages.get("message-4")).toBeDefined()
  })
})
