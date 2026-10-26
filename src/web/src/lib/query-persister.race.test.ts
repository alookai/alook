import "fake-indexeddb/auto"
import { createStore, del, get, promisifyRequest, set } from "idb-keyval"
import { afterEach, describe, expect, it, vi } from "vitest"
import { QueryClient, dehydrate } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { canonicalChannelRow } from "@/lib/community-db/schema"
import type { PersistedClient } from "@tanstack/react-query-persist-client"
import { clearPersistedCache, createIdbPersister, PERSIST_BUSTER,
  PERSIST_VERSION,
  PERSIST_CACHE_PREFIX, cacheInvalidation } from "./query-persister"

const client: PersistedClient = {
  timestamp: 1,
  buster: PERSIST_BUSTER,
  clientState: { mutations: [], queries: [] },
}
const blobKey = (user: string) => `${PERSIST_CACHE_PREFIX}:${user}:client`
afterEach(() => vi.restoreAllMocks())

describe("native IDB persistence retirement", () => {
  it("never imports an old-version bare write after device clear", async () => {
    const user = "u_old_version_tab"
    const { clearAllPersistedCaches } = await import("./query-persister")
    await clearAllPersistedCaches()
    await set(`alook:qc:v2:${user}:client`, JSON.stringify(client))
    const fresh = createIdbPersister(user)
    expect(await fresh.restoreClient()).toBeUndefined()
    await fresh.persistClient({ ...client, timestamp: 3 })
    await set(`alook:qc:v2:${user}:client`, JSON.stringify({ ...client, timestamp: 99 }))
    expect((await fresh.restoreClient())?.timestamp).toBe(3)
  })

  it("commits clear after a write that already passed eligibility in another module", async () => {
    const user = "u_native_inflight"
    await clearPersistedCache(user)
    const stale = createIdbPersister(user)
    await stale.restoreClient()
    vi.resetModules()
    const otherDocument = await import("./query-persister")
    let pendingClear: Promise<void> | undefined
    const put = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore, value: unknown, key?: IDBValidKey,
    ) {
      if (key === blobKey(user) && !pendingClear) {
        pendingClear = otherDocument.clearPersistedCache(user)
      }
      return put.call(this, value, key)
    })

    await stale.persistClient(client)
    expect(pendingClear).toBeDefined()
    await pendingClear
    expect(await get(blobKey(user))).toBeUndefined()
  })

  it("device clear fences another module's account before its first payload exists", async () => {
    const user = "u_never_persisted_other_document"
    const stale = createIdbPersister(user)
    await stale.restoreClient()
    expect(await get(blobKey(user))).toBeUndefined()
    vi.resetModules()
    const otherDocument = await import("./query-persister")
    await otherDocument.clearAllPersistedCaches()
    await stale.persistClient(client)
    expect(await get(blobKey(user))).toBeUndefined()
    const fresh = otherDocument.createIdbPersister(user)
    await fresh.persistClient({ ...client, timestamp: 2 })
    expect((await fresh.restoreClient())?.timestamp).toBe(2)
  })

  it.each([undefined, PERSIST_VERSION - 1, "invalid"])("discards version %s within the account cache and fences existing owners", async (version) => {
    const user = `u_mismatch_${version}`
    const old = createIdbPersister(user), sibling = createIdbPersister(`${user}_other`)
    await old.persistClient(client)
    await sibling.persistClient(client)
    await set(blobKey(user), JSON.stringify({ ...client, version, channelFences: [] }))
    const fresh = createIdbPersister(user)
    await expect(fresh.restoreClient()).resolves.toBeUndefined()
    expect(await get(blobKey(user))).toBeUndefined()
    await expect(old.isCurrent()).resolves.toBe(false)
    await old.persistClient({ ...client, timestamp: 9 })
    expect(await get(blobKey(user))).toBeUndefined()
    await expect(sibling.restoreClient()).resolves.toEqual(client)
    await fresh.persistClient({ ...client, timestamp: 2 })
    await expect(fresh.restoreClient()).resolves.toMatchObject({ timestamp: 2 })
    await set(blobKey(user), JSON.stringify({ ...client, version, channelFences: [] }))
    await expect(fresh.restoreClient()).resolves.toBeUndefined()
    expect(await get(blobKey(user))).toBeUndefined()
  })

  it("a retired remover cannot delete a newly qualified owner's payload", async () => {
    const user = "u_retired_remove"
    const stale = createIdbPersister(user)
    await stale.restoreClient()
    await clearPersistedCache(user)
    const fresh = createIdbPersister(user)
    await fresh.persistClient(client)
    await stale.removeClient()
    expect((await fresh.restoreClient())?.timestamp).toBe(1)
    await fresh.removeClient()
    await fresh.persistClient({ ...client, timestamp: 2 })
    expect((await fresh.restoreClient())?.timestamp).toBe(2)
  })

  it.each(["missing", "corrupt"])("fails closed for a %s device epoch", async (kind) => {
    const user = `u_device_epoch_${kind}`
    const stale = createIdbPersister(user)
    await stale.restoreClient()
    if (kind === "missing") await del("alook:qc:device-epoch")
    else await set("alook:qc:device-epoch", 0)
    await stale.persistClient(client)
    expect(await get(blobKey(user))).toBeUndefined()
    const fresh = createIdbPersister(user)
    await fresh.persistClient(client)
    await stale.removeClient()
    expect((await fresh.restoreClient())?.timestamp).toBe(1)
  })

  it("fails closed when the account tombstone disappears", async () => {
    const user = "u_missing_account_epoch"
    const stale = createIdbPersister(user)
    await stale.restoreClient()
    await del(`${blobKey(user)}:epoch`)
    await stale.persistClient(client)
    expect(await get(blobKey(user))).toBeUndefined()
  })
})


describe("qualified native owner disk retirement", () => {
  it("an original stale owner cannot retire a new same-account writer", async () => {
    const original = createIdbPersister("A")
    await original.restoreClient()
    await original.retireAccount()
    const fresh = createIdbPersister("A")
    await fresh.restoreClient()
    await original.retireAccount()
    expect(await fresh.isCurrent()).toBe(true)
    expect(await original.isCurrent()).toBe(false)
  })
})

function readingSnapshot(user: string): PersistedClient {
  const queryClient = new QueryClient()
  const setRows = (name: string, rows: unknown[]) => queryClient.setQueryData(communityKeys.communityDbCollection(user, name), rows)
  setRows("channels", ["dm-A", "dm-B"].map((id) => canonicalChannelRow({ id, type: "dm", name: id, preview: `body-${id}`, unread: true })))
  setRows("attentionScopes", ["dm-A", "dm-B"].map(channelId => ({ scopeId: channelId, channelId, serverId: null, parentChannelId: null, ordinaryUnread: true, lastUnreadSeq: 1, attentionCount: 0, lastAttentionSeq: null })))
  setRows("messages", ["dm-A", "dm-B"].map((channelId) => ({ id: `m-${channelId}`, channelId, type: "chat", resourceComplete: false, authorId: user, authorName: "Viewer", authorAvatar: "V", authorAvatarVersion: 0, seq: 1, content: `body-${channelId}` })))
  setRows("channelMemberships", ["dm-A", "dm-B"].map((channelId) => ({ id: `${channelId}:peer:access`, channelId, userId: "peer", relation: "access" })))
  return { timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(queryClient) }
}
function readingRows(snapshot: PersistedClient | undefined, name: string) {
  return snapshot?.clientState.queries.find((query) => query.queryKey[3] === name)?.state.data as Array<Record<string, unknown>> | undefined
}

describe("native channel persistence fence", () => {
  it.each([
    ["account", false], ["account", true], ["channel", false], ["channel", true],
  ] as const)("retires existing v3 eligibility on %s retirement with payload=%s", async (kind, hasPayload) => {
    const user = `u_v3_qualified_${kind}_${hasPayload}`
    await clearPersistedCache(user)
    const owner = createIdbPersister(user)
    const before = readingSnapshot(user)
    await owner.persistClient(before)
    const other = createIdbPersister(`${user}_other`)
    await other.persistClient(client)
    const device = await get("alook:qc:device-epoch")
    const oldNamespace = `alook:qc:v3:${user}`
    const oldKeys = [`${oldNamespace}:account-epoch`, `${oldNamespace}:client:epoch`, `${oldNamespace}:application:client:epoch`]
    const epochs = oldKeys.map(() => crypto.randomUUID())
    for (let i = 0; i < oldKeys.length; i++) await set(oldKeys[i]!, epochs[i])
    if (hasPayload) await set(`${oldNamespace}:client`, JSON.stringify(client))
    const otherEpoch = crypto.randomUUID(), otherKey = `alook:qc:v3:${user}_other:account-epoch`
    await set(otherKey, otherEpoch)
    const unrelated = `${oldNamespace}:preference`
    await set(unrelated, "keep")
    if (!hasPayload) expect(await get(`${oldNamespace}:client`)).toBeUndefined()
    if (kind === "account") await owner.retireAccount()
    else await owner.retireChannels(["dm-A"])
    for (let i = 0; i < oldKeys.length; i++) expect(await get(oldKeys[i]!)).not.toBe(epochs[i])
    expect(await get(`${oldNamespace}:client`)).toBeUndefined()
    expect(await get(otherKey)).toBe(otherEpoch)
    expect(await get(unrelated)).toBe("keep")
    expect(await get("alook:qc:device-epoch")).toBe(device)
    expect(await other.isCurrent()).toBe(true)
    expect(await owner.isCurrent()).toBe(kind === "channel")
    if (kind === "channel") {
      const restored = await owner.restoreClient()
      expect(readingRows(restored, "messages")).toEqual(readingRows(before, "messages")!.filter((row) => row.channelId === "dm-B"))
    }
  })

  it("clearPersistedCache deletes prior namespace payloads and invalidates their existing qualifications only for the account", async () => {
    const user = "u_v3_existing_payload"
    const namespace = `alook:qc:v3:${user}`
    const account = crypto.randomUUID(), scope = crypto.randomUUID()
    await set(`${namespace}:account-epoch`, account)
    await set(`${namespace}:client:epoch`, scope)
    await set(`${namespace}:client`, JSON.stringify(client))
    await set(`${namespace}:application:client`, "application")
    const otherKey = `alook:qc:v3:${user}_other:client`
    await set(otherKey, "other account bytes")
    await clearPersistedCache(user)
    expect(await get(`${namespace}:client`)).toBeUndefined()
    expect(await get(`${namespace}:application:client`)).toBeUndefined()
    expect(await get(`${namespace}:account-epoch`)).not.toBe(account)
    expect(await get(`${namespace}:client:epoch`)).not.toBe(scope)
    expect(await get(otherKey)).toBe("other account bytes")
  })

  it("keeps sibling bytes and the account owner while fencing a later old-document write", async () => {
    const user = "u_channel_late_writer"
    await clearPersistedCache(user)
    const old = createIdbPersister(user)
    const before = readingSnapshot(user)
    await old.persistClient(before)
    const invalidation = cacheInvalidation.get()
    vi.resetModules()
    const otherDocument = await import("./query-persister")
    await otherDocument.createIdbPersister(user).retireChannels(["dm-A"])
    expect(await old.isCurrent()).toBe(true)
    expect(cacheInvalidation.get()).toBe(invalidation)
    await old.persistClient(before)
    const restored = await otherDocument.createIdbPersister(user).restoreClient()
    expect(readingRows(restored, "messages")?.map((row) => row.channelId)).toEqual(["dm-B"])
    expect(readingRows(restored, "channels")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "dm-A", preview: "" }),
      expect.objectContaining({ id: "dm-B", preview: "body-dm-B" }),
    ]))
    expect(readingRows(restored, "channels")?.every(row => !("unread" in row))).toBe(true)
    expect(readingRows(restored, "attentionScopes")?.map(row => row.channelId)).toEqual(["dm-B"])
    expect(readingRows(restored, "channelMemberships")).toHaveLength(2)
    const fresh = otherDocument.createIdbPersister(user)
    await fresh.persistClient(before)
    expect(readingRows(await fresh.restoreClient(), "messages")).toHaveLength(2)
  })

  it("scrubs a transaction that already passed writer eligibility", async () => {
    const user = "u_channel_inflight_writer"
    await clearPersistedCache(user)
    const old = createIdbPersister(user)
    await old.restoreClient()
    let retirement: Promise<void> | undefined
    const put = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (key === blobKey(user) && !retirement) retirement = old.retireChannels(["dm-A"])
      return put.call(this, value, key)
    })
    await old.persistClient(readingSnapshot(user))
    expect(retirement).toBeDefined()
    await retirement
    expect(readingRows(await createIdbPersister(user).restoreClient(), "messages")?.map((row) => row.channelId)).toEqual(["dm-B"])
  })

  it("distinguishes physical deletion from denied DM identity", async () => {
    const user = "u_channel_deleted"
    await clearPersistedCache(user)
    const persister = createIdbPersister(user)
    const before = readingSnapshot(user)
    await persister.persistClient(before)
    await persister.retireChannels(["dm-A"], true)
    await persister.persistClient(before)
    const restored = await createIdbPersister(user).restoreClient()
    expect(readingRows(restored, "channels")?.map((row) => row.id)).toEqual(["dm-B"])
    expect(readingRows(restored, "channelMemberships")?.map((row) => row.channelId)).toEqual(["dm-B"])
  })

  it("compares stored epochs before a fresh owner restores an earlier snapshot", async () => {
    const user = "u_channel_old_snapshot"
    await clearPersistedCache(user)
    const owner = createIdbPersister(user)
    await owner.persistClient(readingSnapshot(user))
    const before = await get(blobKey(user))
    await owner.retireChannels(["dm-A"])
    await set(blobKey(user), before)
    expect(readingRows(await createIdbPersister(user).restoreClient(), "messages")?.map((row) => row.channelId)).toEqual(["dm-B"])
  })

  it("scrubs only retired channel notification settings and preserves server and sibling settings", async () => {
    const user = "u_notification_scope_retire", owner = createIdbPersister(user), snapshot = readingSnapshot(user)
    const qc = new QueryClient()
    qc.setQueryData(communityKeys.communityDbCollection(user, "notificationSettings"), [
      { id: "A", channelId: "dm-A", serverId: null, level: "all" },
      { id: "B", channelId: "dm-B", serverId: null, level: "mentions" },
      { id: "server", channelId: null, serverId: "server", level: "all" },
    ])
    snapshot.clientState.queries.push(...dehydrate(qc).queries)
    await owner.persistClient(snapshot)
    await owner.retireChannels(["dm-A"])
    expect(readingRows(await owner.restoreClient(), "notificationSettings")?.map(row => row.id)).toEqual(["B", "server"])
  })

  it("deletes an undecodable payload during native channel retirement", async () => {
    const user = "u_corrupt_payload_retire", owner = createIdbPersister(user)
    await owner.persistClient(readingSnapshot(user))
    await set(blobKey(user), "not-json")
    await expect(owner.retireChannels(["dm-A"])).resolves.toBeUndefined()
    expect(await get(blobKey(user))).toBeUndefined()
    await set(blobKey(user), JSON.stringify({ ...client, channelFences: "invalid" }))
    await owner.retireChannels(["dm-A"])
    expect(await get(blobKey(user))).toBeUndefined()
    expect(await owner.restoreClient()).toBeUndefined()
    expect(await owner.isCurrent()).toBe(true)
  })

  it("retires attention by scope, child and read target while keeping unrelated items and friend requests", async () => {
    const user = "u_attention_retirement", owner = createIdbPersister(user)
    const snapshot = readingSnapshot(user), qc = new QueryClient()
    const createdAt = "2026-10-08T00:00:00Z"
    const reply = (id: string, scopeId: string) => ({ id, kind: "reply", sourceId: id, scopeId, messageId: `m-${scopeId}`, actorUserId: "peer", createdAt })
    const forumPost = (id: string, childChannelId: string, channelId: string) => ({ id, kind: "forum_post", sourceId: childChannelId, scopeId: "forum", messageId: `opener-${id}`, childChannelId, openerSeq: 1, readTarget: { channelId, seq: 1 }, createdAt })
    qc.setQueryData(communityKeys.communityDbCollection(user, "attentionItems"), [
      reply("scope", "dm-A"), forumPost("child", "dm-A", "forum"),
      forumPost("target", "other-child", "dm-A"), reply("sibling", "dm-B"),
      reply("unrelated", "other-scope"), { id: "friend", kind: "friend_request", sourceId: "friend", actorUserId: "peer", createdAt },
    ])
    snapshot.clientState.queries.push(...dehydrate(qc).queries)
    await owner.persistClient(snapshot)
    await owner.retireChannels(["dm-A"])
    const restored = await owner.restoreClient()
    expect(readingRows(restored, "attentionItems")?.map(row => row.id)).toEqual(["unrelated", "sibling", "friend"])
    expect(readingRows(restored, "messages")?.map(row => row.channelId)).toEqual(["dm-B"])
    await owner.persistClient(snapshot)
    expect(readingRows(await owner.restoreClient(), "attentionItems")?.map(row => row.id)).toEqual(["unrelated", "sibling", "friend"])
  })

  it.each(["missing", "corrupt"])("fails closed for %s stored channel fence metadata", async (kind) => {
    const user = `u_channel_snapshot_${kind}`
    await clearPersistedCache(user)
    const owner = createIdbPersister(user)
    await owner.persistClient(readingSnapshot(user))
    const raw = JSON.parse(await get<string>(blobKey(user)) ?? "null") as Record<string, unknown>
    if (kind === "missing") delete raw.channelFences
    else raw.channelFences = [["dm-A", { epoch: "invalid", deleted: false }]]
    await set(blobKey(user), JSON.stringify(raw))
    expect(await owner.restoreClient()).toBeUndefined()
  })
})

it("a retired account owner cannot fence a newer same-account snapshot", async () => {
  const user = "u_stale_account_channel_retire"
  const old = createIdbPersister(user)
  await old.restoreClient()
  await old.retireAccount()
  const fresh = createIdbPersister(user)
  await fresh.persistClient(readingSnapshot(user))
  await old.retireChannels(["dm-A"], true)
  expect(readingRows(await fresh.restoreClient(), "messages")).toHaveLength(2)
  expect(readingRows(await fresh.restoreClient(), "channels")).toHaveLength(2)
})

// The old writer compares the captured UUID directly in the same native IDB
// transaction. This fixture checks that guard; it is not an old-browser receipt.
describe("v6 community scope qualification", () => {
  it.each([false, true])("retires a v5 UUID scope with payload=%s while preserving other domains", async (hasPayload) => {
    const user = `u_v6_scope_${hasPayload}`
    const owner = createIdbPersister(user)
    await owner.restoreClient()
    const namespace = `${PERSIST_CACHE_PREFIX}:${user}`
    const device = await get("alook:qc:device-epoch")
    const account = await get(`${namespace}:account-epoch`)
    const fences = new Map([["channel", { epoch: crypto.randomUUID(), deleted: true }]])
    await set(`${namespace}:account-epoch:channels`, fences)
    const oldScope = crypto.randomUUID()
    await set(`${blobKey(user)}:epoch`, oldScope)
    if (hasPayload) await set(blobKey(user), JSON.stringify({ ...client, version: 5, buster: "5", channelFences: [] }))
    else await del(blobKey(user))
    const applicationKey = `${namespace}:application:client`
    const applicationScope = crypto.randomUUID()
    await set(applicationKey, "application payload")
    await set(`${applicationKey}:epoch`, applicationScope)
    const legacyStore = createStore("keyval-store", "keyval")
    const legacyPayload = JSON.stringify({ ...client, version: 5, buster: "5", channelFences: [] })
    const legacyOperation = (operation: "write" | "remove" | "channel" | "account") => legacyStore("readwrite", async (store) => {
      const committed = promisifyRequest(store.transaction)
      const [currentDevice, currentScope, currentAccount, currentFences] = await Promise.all([
        promisifyRequest<unknown>(store.get("alook:qc:device-epoch")),
        promisifyRequest<unknown>(store.get(`${blobKey(user)}:epoch`)),
        promisifyRequest<unknown>(store.get(`${namespace}:account-epoch`)),
        promisifyRequest<unknown>(store.get(`${namespace}:account-epoch:channels`)),
      ])
      const validFences = currentFences instanceof Map && [...currentFences].every(([id, fence]) => (
        typeof id === "string" && id.length > 0 && fence !== null && typeof fence === "object"
        && typeof fence.epoch === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fence.epoch)
        && typeof fence.deleted === "boolean"
      ))
      const eligible = currentDevice === device && currentScope === oldScope && currentAccount === account && validFences
      if (eligible) {
        if (operation === "write") store.put(legacyPayload, blobKey(user))
        else store.delete(blobKey(user))
        if (operation === "channel") store.put(new Map([["channel", { epoch: crypto.randomUUID(), deleted: true }]]), `${namespace}:account-epoch:channels`)
        if (operation === "account") {
          store.put(crypto.randomUUID(), `${namespace}:account-epoch`)
          store.put(new Map(), `${namespace}:account-epoch:channels`)
          for (const key of [blobKey(user), applicationKey]) {
            store.delete(key)
            store.put(crypto.randomUUID(), `${key}:epoch`)
          }
        }
      }
      await committed
      return eligible
    })
    expect(await legacyOperation(hasPayload ? "write" : "remove")).toBe(true)
    expect(await get(blobKey(user))).toBe(hasPayload ? legacyPayload : undefined)
    const sibling = createIdbPersister(`${user}_other`)
    await sibling.persistClient(client)
    const fresh = createIdbPersister(user)
    expect(await fresh.restoreClient()).toBeUndefined()
    const qualified = await get<{ version: number; epoch: string }>(`${blobKey(user)}:epoch`)
    expect(qualified).toEqual({ version: 6, epoch: expect.any(String) })
    expect(qualified!.epoch).not.toBe(oldScope)
    expect(await get("alook:qc:device-epoch")).toBe(device)
    expect(await get(`${namespace}:account-epoch`)).toBe(account)
    expect(await get(`${namespace}:account-epoch:channels`)).toEqual(fences)
    expect(await get(applicationKey)).toBe("application payload")
    expect(await get(`${applicationKey}:epoch`)).toBe(applicationScope)
    expect(await sibling.restoreClient()).toEqual(client)
    await fresh.persistClient(client)
    const before = await get(blobKey(user))
    for (const operation of ["write", "remove", "channel", "account"] as const) {
      expect(await legacyOperation(operation)).toBe(false)
      expect(await get(blobKey(user))).toBe(before)
      expect(await get("alook:qc:device-epoch")).toBe(device)
      expect(await get(`${namespace}:account-epoch`)).toBe(account)
      expect(await get(`${namespace}:account-epoch:channels`)).toEqual(fences)
      expect(await get(applicationKey)).toBe("application payload")
      expect(await get(`${applicationKey}:epoch`)).toBe(applicationScope)
      expect(await sibling.restoreClient()).toEqual(client)
    }
    await owner.persistClient({ ...client, timestamp: 99 })
    await owner.removeClient()
    await owner.retireChannels(["channel"], true)
    await owner.retireAccount()
    expect(await get(blobKey(user))).toBe(before)
    expect(await get(`${namespace}:account-epoch:channels`)).toEqual(fences)
    expect(await fresh.isCurrent()).toBe(true)
  })

  it.each([false, true])("allows two v6 owners to share a valid scope with payload=%s", async (hasPayload) => {
    const user = `u_two_v6_${hasPayload}`
    const first = createIdbPersister(user)
    await first.restoreClient()
    if (hasPayload) await first.persistClient(client)
    const scope = await get(`${blobKey(user)}:epoch`)
    const second = createIdbPersister(user)
    await second.restoreClient()
    expect(await get(`${blobKey(user)}:epoch`)).toEqual(scope)
    expect(await first.isCurrent()).toBe(true)
    expect(await second.isCurrent()).toBe(true)
    await first.persistClient(client)
    expect(await second.restoreClient()).toEqual(client)
    await second.persistClient({ ...client, timestamp: 2 })
    expect(await first.restoreClient()).toMatchObject({ timestamp: 2 })
  })
})
