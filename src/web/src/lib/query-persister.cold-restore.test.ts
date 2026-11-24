import { channelResourceFixture, messageResourceFixture, profileResourceFixture } from "@/test/community-resource-fixtures"
import { buildDecisionCardEmbed, DecisionCardInputSchema, extractDecisionCardFromEmbeds } from "@alook/shared"
import "fake-indexeddb/auto"
import { del, get, set } from "idb-keyval"
import { afterEach, describe, expect, it, vi } from "vitest"
import { dehydrate, hydrate, QueryClient } from "@tanstack/react-query"
import { persistQueryClientRestore, type PersistedClient } from "@tanstack/react-query-persist-client"
import { canonicalChannelRow } from "./community-db/schema"
import { communityKeys } from "./query-keys"
import * as persistence from "./query-persister"
import { createCommunityDbRegistry } from "./community-db/collections"
import { markDecisionCardRespondedOptimistically } from "./community-db/sync"

const key = (user: string) => `${persistence.PERSIST_CACHE_PREFIX}:${user}:client`
const accountKey = (user: string) => `${persistence.PERSIST_ACCOUNT_PREFIX}:${user}:account-epoch`

function snapshot(user: string, content = "Cached"): PersistedClient {
  const client = new QueryClient()
  client.setQueryData(communityKeys.communityDbCollection(user, "channels"), ["a", "b"].map(id => canonicalChannelRow({ ...channelResourceFixture({ id, type: "dm", serverId: null, name: id }), preview: content })))
  client.setQueryData(communityKeys.communityDbCollection(user, "messages"), ["a", "b"].map(channelId => messageResourceFixture({ id: `m-${channelId}`, channelId, authorId: user, authorName: "Viewer", authorAvatar: "V", authorAvatarVersion: 0, seq: 1, content })))
  const result = { timestamp: Date.now(), buster: persistence.PERSIST_BUSTER, clientState: dehydrate(client) }
  client.clear()
  return result
}

function messages(value: PersistedClient | undefined) {
  return value?.clientState.queries.find(query => query.queryKey[3] === "messages")?.state.data
}

afterEach(() => vi.restoreAllMocks())

describe("cold IDB snapshot processing", () => {
  it("restores only a confirmed answer after the original tab closes while its request is pending", async () => {
    const user = "cold-question-pending"
    const client = new QueryClient()
    hydrate(client, snapshot(user).clientState)
    const card = buildDecisionCardEmbed(DecisionCardInputSchema.parse({
      summary: "Confirm rollout",
      questions: [{ question: "Roll out now?", options: [{ label: "Yes" }, { label: "No" }] }],
    }), [])
    client.setQueryData(communityKeys.communityDbCollection(user, "messages"), [
      messageResourceFixture({ id: "pending-card", channelId: "a", authorId: "peer", authorName: "Peer", seq: 1, embeds: [card] }),
    ])
    client.setQueryData(communityKeys.communityDbCollection(user, "profiles"), [profileResourceFixture({ id: "peer", name: "Peer" })])
    const registry = createCommunityDbRegistry(client, user)
    await registry.preload()
    expect(markDecisionCardRespondedOptimistically(registry, "pending-card", user)).toBeDefined()
    expect(extractDecisionCardFromEmbeds(registry.collections.messages.get("pending-card")?.embeds).card?.respondedUserIds).toContain(user)
    const writer = persistence.createIdbPersister(user)
    await writer.persistClient({
      timestamp: Date.now(),
      buster: persistence.PERSIST_BUSTER,
      clientState: dehydrate(client, { shouldDehydrateQuery: persistence.shouldDehydrateCommunityQuery }),
    })
    writer.stopPersisting()
    await registry.cleanup()
    client.clear()
    const reader = persistence.createIdbPersister(user)
    const restored = messages(await reader.restoreClient()) as { id: string; embeds?: unknown[] }[] | undefined
    const restoredCard = extractDecisionCardFromEmbeds(restored?.find(message => message.id === "pending-card")?.embeds).card
    expect(restoredCard).toBeDefined()
    expect(restoredCard?.respondedUserIds ?? []).not.toContain(user)
  })

  it("decodes unchanged qualified bytes once without a restore JSON round trip", async () => {
    const user = "cold-once", writer = persistence.createIdbPersister(user)
    await writer.persistClient(snapshot(user, "cached body".repeat(2000)))
    const raw = await get<string>(key(user))
    expect(raw).toEqual(expect.any(String))
    const parse = vi.spyOn(JSON, "parse")
    const stringify = vi.spyOn(JSON, "stringify")
    const reader = persistence.createIdbPersister(user)
    const restored = await reader.restoreClient()
    expect(messages(restored)).toHaveLength(2)
    expect(parse.mock.calls.filter(([input]) => input === raw)).toHaveLength(1)
    expect(stringify).not.toHaveBeenCalled()
  })

  it("rereads a payload changed after qualification instead of publishing the provisional decode", async () => {
    const user = "cold-changed", writer = persistence.createIdbPersister(user)
    await writer.persistClient(snapshot(user, "Old"))
    const reader = persistence.createIdbPersister(user)
    expect(await reader.isCurrent()).toBe(true)
    await set(key(user), JSON.stringify({ ...JSON.parse((await get<string>(key(user)))!), ...snapshot(user, "New"), version: persistence.PERSIST_VERSION, channelFences: [] }))
    expect(messages(await reader.restoreClient())).toEqual(expect.arrayContaining([expect.objectContaining({ content: "New" })]))
  })

  it.each(["removed", "corrupt", "version", "buster"])("rejects a %s payload written after qualification", async kind => {
    const user = `cold-${kind}`, writer = persistence.createIdbPersister(user)
    await writer.persistClient(snapshot(user))
    const reader = persistence.createIdbPersister(user)
    await reader.isCurrent()
    if (kind === "removed") await del(key(user))
    else if (kind === "corrupt") await set(key(user), "{")
    else await set(key(user), JSON.stringify({ ...JSON.parse((await get<string>(key(user)))!), ...snapshot(user), version: kind === "version" ? 5 : persistence.PERSIST_VERSION, buster: kind === "buster" ? "old" : persistence.PERSIST_BUSTER, channelFences: [] }))
    expect(await reader.restoreClient()).toBeUndefined()
    expect(await get(key(user))).toBeUndefined()
  })

  it.each(["device", "account", "scope"])("rejects a late %s retirement without deleting a newer owner's bytes", async kind => {
    const user = `cold-fence-${kind}`, writer = persistence.createIdbPersister(user)
    await writer.persistClient(snapshot(user))
    const reader = persistence.createIdbPersister(user)
    await reader.isCurrent()
    const raw = await get(key(user))
    const fenceKey = kind === "device" ? "alook:qc:device-epoch" : kind === "account" ? accountKey(user) : `${key(user)}:epoch`
    await set(fenceKey, kind === "scope" ? { version: persistence.PERSIST_VERSION, epoch: crypto.randomUUID() } : crypto.randomUUID())
    expect(await reader.restoreClient()).toBeUndefined()
    await reader.removeClient()
    expect(await get(key(user))).toBe(raw)
  })

  it("applies freshly read channel fences even when the payload bytes did not change", async () => {
    const user = "cold-channel-fence", writer = persistence.createIdbPersister(user)
    await writer.persistClient(snapshot(user))
    const raw = await get(key(user))
    const reader = persistence.createIdbPersister(user)
    await reader.isCurrent()
    await set(`${accountKey(user)}:channels`, new Map([["a", { epoch: crypto.randomUUID(), deleted: true }]]))
    expect(messages(await reader.restoreClient())).toEqual([expect.objectContaining({ channelId: "b" })])
    expect(await get(key(user))).toBe(raw)
  })

  it.each(["expired", "missing-timestamp"])("keeps native removal and subsequent fresh persistence after %s", async kind => {
    const user = `cold-native-${kind}`, writer = persistence.createIdbPersister(user)
    await writer.persistClient({ ...snapshot(user), timestamp: kind === "expired" ? Date.now() - persistence.PERSIST_MAX_AGE_MS - 1 : 0 })
    const reader = persistence.createIdbPersister(user), client = new QueryClient()
    await persistQueryClientRestore({ queryClient: client, persister: reader, maxAge: persistence.PERSIST_MAX_AGE_MS, buster: persistence.PERSIST_BUSTER })
    expect(client.getQueryCache().getAll()).toEqual([])
    expect(await get(key(user))).toBeUndefined()
    expect(await reader.isCurrent()).toBe(true)
    await reader.persistClient(snapshot(user, "Fresh"))
    expect(messages(await reader.restoreClient())).toEqual(expect.arrayContaining([expect.objectContaining({ content: "Fresh" })]))
    client.clear()
  })

  it("repeats key-only legacy cleanup for later old-software writes while preserving sibling data", async () => {
    const user = "cold-legacy", writer = persistence.createIdbPersister(user)
    await writer.persistClient(snapshot(user))
    const legacy = `alook:qc:v2:${user}:client`
    await set(legacy, "first legacy body")
    await set("alook:qc:v2:other:client", "other account")
    await set(`alook:qc:v2:${user}:preference`, "preference")
    await set(`${persistence.PERSIST_CACHE_PREFIX}:${user}:application:client`, "application")
    const valueCursor = vi.spyOn(IDBObjectStore.prototype, "openCursor")
    const reader = persistence.createIdbPersister(user)
    await reader.restoreClient()
    expect(await get(legacy)).toBeUndefined()
    await set(legacy, "later legacy body")
    await reader.retireChannels(["a"], true)
    expect(await get(legacy)).toBeUndefined()
    expect(valueCursor).not.toHaveBeenCalled()
    expect(await get("alook:qc:v2:other:client")).toBe("other account")
    expect(await get(`alook:qc:v2:${user}:preference`)).toBe("preference")
    expect(await get(`${persistence.PERSIST_CACHE_PREFIX}:${user}:application:client`)).toBe("application")
    expect(messages(await reader.restoreClient())).toEqual([expect.objectContaining({ channelId: "b" })])
  })
})
