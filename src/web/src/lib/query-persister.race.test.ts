import "fake-indexeddb/auto"
import { del, get, set } from "idb-keyval"
import { afterEach, describe, expect, it, vi } from "vitest"
import { QueryClient, dehydrate } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { canonicalChannelRow } from "@/lib/community-db/schema"
import type { PersistedClient } from "@tanstack/react-query-persist-client"
import { clearPersistedCache, createIdbPersister, PERSIST_BUSTER, cacheInvalidation } from "./query-persister"

const client: PersistedClient = {
  timestamp: 1,
  buster: PERSIST_BUSTER,
  clientState: { mutations: [], queries: [] },
}
const blobKey = (user: string) => `alook:qc:${PERSIST_BUSTER}:${user}:client`
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
  setRows("messages", ["dm-A", "dm-B"].map((channelId) => ({ id: `m-${channelId}`, channelId, type: "chat", authorId: user, authorName: "Viewer", authorAvatar: "V", authorAvatarVersion: 0, seq: 1, content: `body-${channelId}` })))
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
      expect.objectContaining({ id: "dm-A", preview: "", unread: false }),
      expect.objectContaining({ id: "dm-B", preview: "body-dm-B", unread: true }),
    ]))
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
    await expect(owner.retireChannels(["dm-A"])).rejects.toThrow(SyntaxError)
    await set(blobKey(user), JSON.stringify({ ...client, channelFences: "invalid" }))
    await owner.retireChannels(["dm-A"])
    expect(await get(blobKey(user))).toBeUndefined()
    expect(await owner.restoreClient()).toBeUndefined()
    expect(await owner.isCurrent()).toBe(true)
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
