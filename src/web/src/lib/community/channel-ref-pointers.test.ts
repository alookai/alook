import "fake-indexeddb/auto"
import { get } from "idb-keyval"
import { afterEach, describe, expect, it, vi } from "vitest"
import { dehydrate, hydrate, QueryClient } from "@tanstack/react-query"
import { channelResourceFixture, messageResourceFixture, profileResourceFixture, serverResourceFixture } from "@/test/community-resource-fixtures"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { canonicalChannelRow } from "@/lib/community-db/schema"
import {
  captureCommunityLiveSnapshotToken,
  publishCommunityMessages,
  purgeCommunityServer,
  restoreCommunityCollections,
  retireCommunityChannelReading,
} from "@/lib/community-db/sync"
import { retireCommunityAccount } from "@/lib/community/account-cache-lifecycle"
import { parseChannelRefDestination } from "@/lib/community/channel-ref"
import {
  readChannelRefPointers,
  resolveChannelRefFromCommunityDb,
} from "@/lib/community/channel-ref-pointers"
import { communityKeys } from "@/lib/query-keys"
import * as persistence from "@/lib/query-persister"

const blobKey = (user: string) => `${persistence.PERSIST_CACHE_PREFIX}:${user}:client`

afterEach(() => vi.restoreAllMocks())

describe("pure-ID channel ref pointers persistence, merge, and retirement", () => {
  it("persists pure-ID thread pointers without duplicating names and restores synchronously into a fresh owner", async () => {
    const user = "ref-pointer-roundtrip"
    const client = new QueryClient()
    const registry = createCommunityDbRegistry(client, user)
    await registry.preload()

    const server = serverResourceFixture({ id: "s1", name: "Alook", discriminator: "5620", position: 3 })
    const forum = channelResourceFixture({ id: "forum", serverId: "s1", type: "forum", name: "fix", parentChannelId: null })
    const post = channelResourceFixture({ id: "post_381", serverId: "s1", type: "thread", name: "UniquePostTitle381", parentChannelId: "forum", parentMessageId: "m_open", archived: true })
    const dm = channelResourceFixture({ id: "dm_1", serverId: null, type: "dm", name: null })
    const msg = messageResourceFixture({ id: "m1", channelId: "dm_1", authorId: user, seq: 1, content: "See /Alook#5620/fix/#381 and /Alook#5620/fix" })
    const profile = profileResourceFixture({ id: user, name: "Viewer" })

    await publishCommunityMessages(client, {
      channelId: "dm_1",
      messages: [msg],
      profiles: [profile],
      refs: {
        servers: [server],
        channels: [forum, post],
        resolvedRefs: [
          { ref: "/alook#5620/fix/#381", status: "ready", serverId: "s1", channelId: "post_381" },
          { ref: "/alook#5620/fix", status: "ready", serverId: "s1", channelId: "forum" },
        ],
      },
      proof: { token: captureCommunityLiveSnapshotToken(client, "dm_1") },
    })

    // Only thread refs are stored in channelRefPointers; top-level channels resolve straight from community-db
    const inMemoryPointers = readChannelRefPointers(client.getQueryData(communityKeys.channelRefPointers()))
    expect(inMemoryPointers?.pointers).toEqual({
      "/alook#5620/fix/#381": { serverId: "s1", channelId: "post_381" },
    })
    expect(JSON.stringify(inMemoryPointers)).not.toContain("UniquePostTitle381")
    expect(JSON.stringify(inMemoryPointers)).not.toContain("Alook")

    // Persist to IDB via real persister
    const writer = persistence.createIdbPersister(user)
    await writer.persistClient({
      timestamp: Date.now(),
      buster: persistence.PERSIST_BUSTER,
      clientState: dehydrate(client, { shouldDehydrateQuery: persistence.shouldDehydrateCommunityQuery }),
    })
    writer.stopPersisting()

    // Inspect raw disk JSON: zero duplicated names in channel-ref-pointers query
    const rawDisk = await get<string>(blobKey(user))
    expect(rawDisk).toEqual(expect.any(String))
    const parsedDisk = JSON.parse(rawDisk!) as { clientState: { queries: Array<{ queryKey: unknown[]; state: { data: unknown } }> } }
    const diskPointerQuery = parsedDisk.clientState.queries.find((q) => q.queryKey[1] === "channel-ref-pointers")
    expect(diskPointerQuery).toBeDefined()
    expect(diskPointerQuery!.state.data).toEqual({
      schemaVersion: expect.any(Number),
      accountId: user,
      pointers: {
        "/alook#5620/fix/#381": { serverId: "s1", channelId: "post_381" },
      },
    })
    expect(JSON.stringify(diskPointerQuery!.state.data)).not.toContain("UniquePostTitle381")

    await registry.cleanup()
    client.clear()

    // Restore into a completely fresh owner
    const reader = persistence.createIdbPersister(user)
    const { persister: restorePersister, takeCollections } = persistence.createCommunityRestorePersister(reader, user)
    const restoredClient = await restorePersister.restoreClient()
    expect(restoredClient).toBeDefined()

    const nextClient = new QueryClient()
    hydrate(nextClient, restoredClient!.clientState)
    const nextRegistry = createCommunityDbRegistry(nextClient, user)
    await restoreCommunityCollections(nextRegistry, takeCollections())
    await nextRegistry.preload()

    expect(resolveChannelRefFromCommunityDb(nextRegistry, parseChannelRefDestination("/Alook#5620/fix/#381#9")!)).toEqual({
      status: "ready",
      target: { server: { id: "s1", name: "Alook" }, channel: { id: "post_381", name: "UniquePostTitle381", parentChannelId: "forum" } },
    })
    expect(resolveChannelRefFromCommunityDb(nextRegistry, parseChannelRefDestination("/Alook#5620/fix")!)).toEqual({
      status: "ready",
      target: { server: { id: "s1", name: "Alook" }, channel: { id: "forum", name: "fix", parentChannelId: null } },
    })

    // Retiring parent channel on disk scrubs child thread pointer too
    await reader.retireChannels(["forum"], true)
    const afterRetire = await reader.restoreClient()
    expect(afterRetire?.clientState.queries.find((q) => q.queryKey[1] === "channel-ref-pointers")).toBeUndefined()

    await nextRegistry.cleanup()
    nextClient.clear()
    expect(dm.id).toBe("dm_1")
  })

  it("drops pointers on purgeCommunityServer, retireCommunityChannelReading, missing entities, and retireCommunityAccount", async () => {
    const user = "ref-pointer-cleanup"
    const client = new QueryClient()
    const registry = createCommunityDbRegistry(client, user)
    await registry.preload()

    const server1 = serverResourceFixture({ id: "s1", name: "Alook", discriminator: "5620" })
    const server2 = serverResourceFixture({ id: "s2", name: "Studio", discriminator: "0042" })
    const forum1 = channelResourceFixture({ id: "forum1", serverId: "s1", type: "forum", name: "fix" })
    const post1 = channelResourceFixture({ id: "post1", serverId: "s1", type: "thread", name: "Post 1", parentChannelId: "forum1", parentMessageId: "op1" })
    const forum2 = channelResourceFixture({ id: "forum2", serverId: "s2", type: "forum", name: "ideas" })
    const post2 = channelResourceFixture({ id: "post2", serverId: "s2", type: "thread", name: "Post 2", parentChannelId: "forum2", parentMessageId: "op2" })
    const profile = profileResourceFixture({ id: user, name: "Viewer" })

    await publishCommunityMessages(client, {
      channelId: "dm_x",
      messages: [messageResourceFixture({ id: "m1", channelId: "dm_x", authorId: user, seq: 1, content: "refs" })],
      profiles: [profile],
      refs: {
        servers: [server1, server2],
        channels: [forum1, post1, forum2, post2],
        resolvedRefs: [
          { ref: "/alook#5620/fix/#1", status: "ready", serverId: "s1", channelId: "post1" },
          { ref: "/studio#0042/ideas/#2", status: "ready", serverId: "s2", channelId: "post2" },
        ],
      },
      proof: { token: captureCommunityLiveSnapshotToken(client, "dm_x") },
    })

    // Retiring parent forum1 prunes post1 pointer while keeping post2
    retireCommunityChannelReading(registry, "forum1", { reason: "read-denied", serverId: "s1" })
    expect(readChannelRefPointers(client.getQueryData(communityKeys.channelRefPointers()))?.pointers).toEqual({
      "/studio#0042/ideas/#2": { serverId: "s2", channelId: "post2" },
    })

    // Purging server2 prunes post2 pointer
    purgeCommunityServer(registry, "s2")
    expect(client.getQueryData(communityKeys.channelRefPointers())).toBeUndefined()

    // Missing entity in DB invalidates pointer
    client.setQueryData(communityKeys.channelRefPointers(), {
      schemaVersion: persistence.PERSIST_VERSION,
      accountId: user,
      pointers: { "/ghost#0001/fix/#9": { serverId: "ghost_s", channelId: "ghost_c" } },
    })
    expect(resolveChannelRefFromCommunityDb(registry, parseChannelRefDestination("/ghost#0001/fix/#9")!)).toEqual({ status: "miss" })

    // Account retirement clears query cache including pointers
    retireCommunityAccount(registry)
    expect(client.getQueryData(communityKeys.channelRefPointers())).toBeUndefined()
  })

  it("preserves richer existing channel and server fields when merging ref resources into community-db", async () => {
    const user = "ref-merge-preserve"
    const client = new QueryClient()
    const registry = createCommunityDbRegistry(client, user)

    const existingServer = serverResourceFixture({ id: "s1", name: "Alook", discriminator: "5620", position: 7 })
    const existingChannel = canonicalChannelRow({
      ...channelResourceFixture({ id: "ch_fix", serverId: "s1", categoryId: "cat_1", type: "forum", name: "fix", topic: "Existing topic", position: 4 }),
      muted: true,
      tags: ["bug", "p0"],
      preview: "Existing preview",
      pending: false,
    })
    client.setQueryData(communityKeys.communityDbCollection(user, "servers"), [existingServer])
    client.setQueryData(communityKeys.communityDbCollection(user, "channels"), [existingChannel])
    await registry.preload()

    await publishCommunityMessages(client, {
      channelId: "dm_1",
      messages: [messageResourceFixture({ id: "m1", channelId: "dm_1", authorId: user, seq: 1, content: "/Alook#5620/fix" })],
      profiles: [profileResourceFixture({ id: user, name: "Viewer" })],
      refs: {
        servers: [serverResourceFixture({ id: "s1", name: "Alook", discriminator: "5620", position: 0 })],
        channels: [channelResourceFixture({ id: "ch_fix", serverId: "s1", categoryId: null, type: "forum", name: "fix-renamed", topic: "", position: 0 })],
        resolvedRefs: [{ ref: "/alook#5620/fix", status: "ready", serverId: "s1", channelId: "ch_fix" }],
      },
      proof: { token: captureCommunityLiveSnapshotToken(client, "dm_1") },
    })

    const mergedServer = registry.collections.servers.get("s1")
    const mergedChannel = registry.collections.channels.get("ch_fix")
    expect(mergedServer?.position).toBe(7)
    expect(mergedChannel).toMatchObject({
      id: "ch_fix",
      name: "fix-renamed",
      categoryId: "cat_1",
      position: 4,
      topic: "Existing topic",
      muted: true,
      tags: ["bug", "p0"],
      preview: "Existing preview",
      pending: false,
    })

    await registry.cleanup()
    client.clear()
  })
})
