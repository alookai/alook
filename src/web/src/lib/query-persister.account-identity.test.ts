import "fake-indexeddb/auto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { dehydrate, QueryClient } from "@tanstack/react-query"
import { del, get, set } from "idb-keyval"
import { capturePersistedAccountIdentity } from "./persisted-account-identity"
import { profileSchema } from "./community-db/schema"
import { communityKeys } from "./query-keys"
import { clearAllPersistedCaches, clearPersistedCache, createIdbPersister, PERSIST_BUSTER, PERSIST_CACHE_PREFIX, readPersistedAccountIdentity, retirePersistedAccountIdentity } from "./query-persister"

const user = { id: "identity-a", email: "a@example.test" }
const blob = `${PERSIST_CACHE_PREFIX}:${user.id}:client`
async function populate(factory = createIdbPersister) {
  const client = new QueryClient()
  client.setQueryData(communityKeys.communityDbCollection(user.id, "profiles"), [profileSchema.parse({ id: user.id, name: "Cached A", discriminator: "0042", avatar: "A", avatarVersion: 1, aboutMe: "Cached self", bannerColor: null, statusEmoji: null, statusText: "" })])
  const owner = factory(user.id)
  await owner.rememberAccountIdentity(user, () => undefined)
  await owner.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(client) })
  client.clear()
  return owner
}
afterEach(async () => { vi.restoreAllMocks(); await clearAllPersistedCaches() })

describe("established account recovery", () => {
  it("recovers only an online-established identity with its qualified cached self profile", async () => {
    expect(await readPersistedAccountIdentity()).toBeUndefined()
    await populate()
    expect(await readPersistedAccountIdentity()).toEqual(user)
    const newDocument = createIdbPersister(user.id)
    expect((await newDocument.restoreClient())?.clientState.queries[0]?.state.data).toEqual([expect.objectContaining({ id: user.id, name: "Cached A" })])
  })
  it("does not admit a descriptor without cached data", async () => {
    const owner = createIdbPersister(user.id)
    await owner.rememberAccountIdentity(user, () => undefined)
    expect(await readPersistedAccountIdentity()).toBeUndefined()
  })
  it.each(["missing", "corrupt", "wrong-self", "incomplete-self", "schema", "device", "account", "scope"])("rejects %s cached ownership", async kind => {
    await populate()
    if (kind === "missing") await del(blob)
    if (kind === "corrupt") await set(blob, "{")
    if (kind === "wrong-self" || kind === "incomplete-self" || kind === "schema") {
      const snapshot = JSON.parse((await get<string>(blob))!)
      if (kind === "wrong-self") snapshot.clientState.queries[0].state.data[0].id = "other-account"
      else if (kind === "incomplete-self") delete snapshot.clientState.queries[0].state.data[0].aboutMe
      else snapshot.version = -1
      await set(blob, JSON.stringify(snapshot))
    }
    if (kind === "device") await set("alook:qc:device-epoch", crypto.randomUUID())
    if (kind === "account") await set(`alook:qc:cache:${user.id}:account-epoch`, crypto.randomUUID())
    if (kind === "scope") await set(`${blob}:epoch`, { version: Number(PERSIST_BUSTER), epoch: crypto.randomUUID() })
    expect(await readPersistedAccountIdentity()).toBeUndefined()
  })
  it("prevents a retired account's delayed identity writer from replacing B", async () => {
    const old = await populate()
    await clearPersistedCache(user.id)
    const b = createIdbPersister("identity-b")
    await b.rememberAccountIdentity({ id: "identity-b", email: "b@example.test" }, () => undefined)
    const descriptor = await get("alook:qc:last-account")
    await old.rememberAccountIdentity(user, () => undefined)
    expect(await get("alook:qc:last-account")).toEqual(descriptor)
  })
  it("checks the live session at the identity write and rejection transaction", async () => {
    const owner = await populate()
    const origin = (await capturePersistedAccountIdentity())!
    const superseded = new DOMException("Superseded", "AbortError")
    await expect(owner.rememberAccountIdentity(user, () => { throw superseded })).rejects.toBe(superseded)
    await expect(retirePersistedAccountIdentity(origin, () => { throw superseded })).rejects.toBe(superseded)
    expect(await readPersistedAccountIdentity()).toEqual(user)
    await retirePersistedAccountIdentity(origin, () => undefined)
    expect(await owner.isCurrent()).toBe(false)
    expect(await readPersistedAccountIdentity()).toBeUndefined()
  })
})


it("captures the request account epochs without reading a private payload", async () => {
  await populate()
  const read = vi.spyOn(IDBObjectStore.prototype, "get")
  expect(await capturePersistedAccountIdentity()).toMatchObject(user)
  expect(read.mock.calls.map(([key]) => key)).not.toContain(blob)
})

it("retries the shared native connection after an unavailable cold account capture", async () => {
  vi.resetModules()
  const freshIdentity = await import("./persisted-account-identity")
  const freshPersistence = await import("./query-persister")
  const open = vi.spyOn(indexedDB, "open").mockImplementationOnce(() => {
    const request = new IDBOpenDBRequest()
    Object.defineProperty(request, "error", { value: new DOMException("Account capture unavailable", "UnknownError") })
    queueMicrotask(() => request.onerror?.call(request, new Event("error")))
    return request
  })
  await expect(freshIdentity.capturePersistedAccountIdentity()).rejects.toThrow("Account capture unavailable")
  await populate(freshPersistence.createIdbPersister)
  expect(await freshPersistence.readPersistedAccountIdentity()).toEqual(user)
  expect(open).toHaveBeenCalledTimes(2)
})
