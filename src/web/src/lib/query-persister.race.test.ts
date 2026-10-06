import "fake-indexeddb/auto"
import { del, get, set } from "idb-keyval"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PersistedClient } from "@tanstack/react-query-persist-client"
import { clearPersistedCache, createIdbPersister } from "./query-persister"

const client: PersistedClient = {
  timestamp: 1,
  buster: "v2",
  clientState: { mutations: [], queries: [] },
}
const blobKey = (user: string) => `alook:qc:v3:${user}:client`
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
