import "fake-indexeddb/auto"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import * as ts from "typescript"
import * as idb from "idb-keyval"
import * as nativeStore from "@tanstack/store"
import * as asyncPersister from "@tanstack/query-async-storage-persister"
import { QueryClient, dehydrate } from "@tanstack/react-query"
import type { PersistedClient } from "@tanstack/react-query-persist-client"
import { describe, expect, it } from "vitest"
import * as forum from "@/lib/community/forum-sidebar-window"
import * as messages from "@/lib/community/models/message"
import * as legacyCache from "@/lib/legacy-chat-persistence"
import * as workerCache from "@/lib/service-worker/public-cache-storage"
import * as restore from "@/lib/observability/restore"
import * as lists from "@/lib/community/list-persistence"
import * as schemas from "@/lib/community-db/schema"
import { communityKeys } from "@/lib/query-keys"
import { createIdbPersister, PERSIST_BUSTER, PERSIST_CACHE_PREFIX, PERSIST_VERSION, type QualifiedPersister } from "./query-persister"

function oldDocument() {
  const source = readFileSync(new URL("./test-fixtures/query-persister-07fa.ts.txt", import.meta.url), "utf8")
  expect(createHash("sha256").update(source).digest("hex")).toBe("d1e237f2265acd04afa98d58f28b118930b76bfd7056382de40a8e4afe4672e6")
  const modules: Record<string, unknown> = {
    "idb-keyval": idb, "@tanstack/store": nativeStore,
    "@tanstack/query-async-storage-persister": asyncPersister,
    "@/lib/community/forum-sidebar-window": forum,
    "@/lib/community/models/message": messages,
    "@/lib/legacy-chat-persistence": legacyCache,
    "@/lib/service-worker/public-cache-storage": workerCache,
    "@/lib/observability/restore": restore,
    "@/lib/community/list-persistence": lists,
    "@/lib/community-db/schema": schemas,
  }
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: { createIdbPersister?: (userId: string) => QualifiedPersister; clearAllPersistedCaches?: () => Promise<void> } = {}
  new Function("require", "exports", output)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected frozen source import: ${name}`)
    return modules[name]
  }, exports)
  return exports as Required<typeof exports>
}

function snapshot(userId: string): PersistedClient {
  const queryClient = new QueryClient()
  queryClient.setQueryData(communityKeys.communityDbCollection(userId, "profiles"), [
    { id: userId, name: "Current identity", discriminator: "1234", avatar: null, avatarVersion: 2 },
  ])
  const result = { timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(queryClient) }
  queryClient.clear()
  return result
}

const key = (userId: string) => `${PERSIST_CACHE_PREFIX}:${userId}:client`

describe("frozen 07fa document against current IDB owner", () => {
  it("keeps current payload and qualification after actual old constructor reconstruction", async () => {
    const userId = crypto.randomUUID()
    const current = createIdbPersister(userId)
    const value = snapshot(userId)
    await current.persistClient(value)
    const before = await idb.get(key(userId))
    expect(before).toBeTypeOf("string")
    const old = oldDocument().createIdbPersister(userId)
    await old.restoreClient()
    expect(await idb.get(key(userId))).toBe(before)
    expect(await current.isCurrent()).toBe(true)
    expect(await current.restoreClient()).toEqual(value)
  })

  it("executes old wrong-version deletion including its legacy-prefix scan without touching the current payload", async () => {
    const userId = crypto.randomUUID()
    const current = createIdbPersister(userId)
    const value = snapshot(userId)
    await current.persistClient(value)
    const before = await idb.get(key(userId))
    const oldKey = `alook:qc:cache:${userId}:client`
    const scannedKey = `alook:qc:different:${userId}:client`
    await idb.set(oldKey, before)
    await idb.set(`${oldKey}:epoch`, { version: 7, epoch: crypto.randomUUID() })
    await idb.set(scannedKey, "legacy scan control")
    await oldDocument().createIdbPersister(userId).restoreClient()
    expect(await idb.get(oldKey)).toBeUndefined()
    expect(await idb.get(scannedKey)).toBeUndefined()
    expect(await idb.get(key(userId))).toBe(before)
    expect(await current.isCurrent()).toBe(true)
  })

  it("fences current owner on actual old account retirement", async () => {
    const userId = crypto.randomUUID()
    const current = createIdbPersister(userId)
    await current.persistClient(snapshot(userId))
    const old = oldDocument().createIdbPersister(userId)
    await old.restoreClient()
    await old.retireAccount()
    expect(await current.isCurrent()).toBe(false)
    expect(await current.restoreClient()).toBeUndefined()
    expect(await createIdbPersister(userId).restoreClient()).toBeUndefined()
  })

  it("fences current owner on actual old device clear", async () => {
    const userId = crypto.randomUUID()
    const current = createIdbPersister(userId)
    await current.persistClient(snapshot(userId))
    await oldDocument().clearAllPersistedCaches()
    expect(await current.isCurrent()).toBe(false)
    expect(await current.restoreClient()).toBeUndefined()
    expect(await createIdbPersister(userId).restoreClient()).toBeUndefined()
  })

  it("scrubs a retired channel after actual old channel retirement", async () => {
    const userId = crypto.randomUUID()
    const channelId = crypto.randomUUID()
    const value = snapshot(userId)
    const channel = schemas.canonicalChannelRow({ id: channelId, type: "dm", serverId: null, categoryId: null,
      name: null, topic: "", parentChannelId: null, parentMessageId: null, creatorId: userId,
      position: 0, archived: false, createdAt: "2026-10-28T00:00:00Z", lastMessageAt: null, messageCount: 0 })
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.communityDbCollection(userId, "channels"), [channel])
    value.clientState.queries.push(...dehydrate(queryClient).queries)
    queryClient.clear()
    const current = createIdbPersister(userId)
    await current.persistClient(value)
    const old = oldDocument().createIdbPersister(userId)
    await old.restoreClient()
    await old.retireChannels([channelId], true)
    expect(await current.isCurrent()).toBe(true)
    const restored = await current.restoreClient()
    expect(restored?.clientState.queries.find(query => query.queryKey[3] === "channels")?.state.data).toEqual([])
    await current.persistClient(value)
    expect((await current.restoreClient())?.clientState.queries.find(query => query.queryKey[3] === "channels")?.state.data).toEqual([])
  })
  it("fences the actual frozen old writer captured before current qualification", async () => {
    const userId = crypto.randomUUID()
    const old = oldDocument().createIdbPersister(userId)
    const value = snapshot(userId)
    await old.persistClient({ ...value, buster: "6" })
    const oldKey = `alook:qc:cache:${userId}:client`
    expect(await idb.get(oldKey)).toBeTypeOf("string")
    const current = createIdbPersister(userId)
    expect(await current.restoreClient()).toBeUndefined()
    await current.persistClient(value)
    expect(await old.isCurrent()).toBe(false)
    await old.persistClient({ ...value, buster: "6", timestamp: 99 })
    expect(await idb.get(oldKey)).toBeUndefined()
    expect(await current.restoreClient()).toEqual(value)
  })

  it("cleans only this account's older business payloads and never restores their late recreation", async () => {
    const userId = crypto.randomUUID(), otherId = crypto.randomUUID()
    const current = createIdbPersister(userId), other = createIdbPersister(otherId)
    const value = snapshot(userId), otherValue = snapshot(otherId)
    await current.persistClient(value)
    await other.persistClient(otherValue)
    const before = await idb.get(key(userId)), otherBefore = await idb.get(key(otherId))
    const futureKey = `alook:business:v${PERSIST_VERSION + 1}:${userId}:client`
    const futureScope = { version: PERSIST_VERSION + 1, epoch: crypto.randomUUID() }
    await idb.set(futureKey, "future-owned-payload")
    await idb.set(`${futureKey}:epoch`, futureScope)
    const oldKeys = ["", ":application"].map(domain => `alook:business:v${PERSIST_VERSION - 1}:${userId}${domain}:client`)
    const epochs = oldKeys.map(() => ({ version: PERSIST_VERSION - 1, epoch: crypto.randomUUID() }))
    for (const [index, oldKey] of oldKeys.entries()) {
      await idb.set(oldKey, "older-owned-payload")
      await idb.set(`${oldKey}:epoch`, epochs[index])
    }
    const fresh = createIdbPersister(userId)
    expect(await fresh.restoreClient()).toEqual(value)
    for (const [index, oldKey] of oldKeys.entries()) {
      expect(await idb.get(oldKey)).toBeUndefined()
      expect(await idb.get(`${oldKey}:epoch`)).not.toEqual(epochs[index])
      await idb.set(oldKey, "late-older-recreation")
    }
    expect(await current.isCurrent()).toBe(true)
    expect(await fresh.restoreClient()).toEqual(value)
    expect(await idb.get(key(userId))).toBe(before)
    expect(await idb.get(key(otherId))).toBe(otherBefore)
    expect(await other.isCurrent()).toBe(true)
    expect(await idb.get(futureKey)).toBe("future-owned-payload")
    expect(await idb.get(`${futureKey}:epoch`)).toEqual(futureScope)
    expect(await createIdbPersister(userId).restoreClient()).toEqual(value)
    for (const oldKey of oldKeys) expect(await idb.get(oldKey)).toBeUndefined()
  })

})
