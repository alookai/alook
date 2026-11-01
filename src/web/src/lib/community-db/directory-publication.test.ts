import { QueryClient } from "@tanstack/react-query"
import { afterEach, expect, it, vi } from "vitest"
import { createCommunityDbRegistry, registerCommunityDbRegistry, type CommunityDbRegistry } from "./collections"
import { ingestMessages, ingestServerDetail, projectCommunityWsEventToDb, completeCommunityPublication } from "./sync"
import { readCommunityCollectionRow, writeCommunityCollectionChanges } from "./write"
import { recordServerDirectoryWindow, reconcileExistingServerDirectoryWindows } from "@/lib/community/server-directory-window"
import { communityKeys } from "@/lib/query-keys"
import { channelResourceFixture, messageResourceFixture, serverResourceFixture } from "@/test/community-resource-fixtures"

const owners: CommunityDbRegistry[] = []
const releases: Array<() => void> = []
afterEach(async () => {
  releases.splice(0).forEach(release => release())
  await Promise.all(owners.splice(0).map(owner => owner.cleanup()))
  vi.restoreAllMocks()
})
async function setup() {
  const db = createCommunityDbRegistry(new QueryClient(), "viewer")
  owners.push(db)
  await db.preload()
  releases.push(registerCommunityDbRegistry(db))
  for (const id of ["s1", "s2"]) ingestServerDetail(db, {
    server: serverResourceFixture({ id }), categories: [],
    channels: [channelResourceFixture({ id: `${id}-parent`, serverId: id })],
  })
  return db
}
function directoryWrites(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.filter(([key]) => Array.isArray(key) && key.length === 3 && key[0] === "community" && key[1] === "servers").map(([key]) => (key as unknown[])[2])
}

it("batches repeated thread facts once and retains sequential optional fields without touching directories", async () => {
  const db = await setup()
  for (const id of ["a", "b"]) projectCommunityWsEventToDb(db.queryClient, { type: "community:channel.create", serverId: "s1", channel: channelResourceFixture({ id, serverId: "s1", type: "thread", parentChannelId: "s1-parent", parentMessageId: `opener-${id}` }) })
  const writes = vi.spyOn(db.collections.channels.utils, "writeBatch")
  const cache = vi.spyOn(db.queryClient, "setQueryData")
  const rows = [
    messageResourceFixture({ id: "m1", channelId: "s1-parent", thread: { id: "a", name: "first", messageCount: 1, tags: ["kept"], lastReplyAt: "2026-11-01T00:00:00Z" } }),
    messageResourceFixture({ id: "m2", channelId: "s1-parent", thread: { id: "b", name: "second", messageCount: 2 } }),
    messageResourceFixture({ id: "m3", channelId: "s1-parent", thread: { id: "a", name: "final", messageCount: 3 } }),
  ]
  ingestMessages(db, "s1-parent", rows)
  expect(db.collections.channels.get("a")).toMatchObject({ name: "final", messageCount: 3, tags: ["kept"], lastMessageAt: "2026-11-01T00:00:00Z" })
  expect(db.collections.channels.get("b")).toMatchObject({ name: "second", messageCount: 2 })
  expect(writes).toHaveBeenCalledTimes(1)
  expect(directoryWrites(cache)).toEqual([])
  writes.mockClear()
  ingestMessages(db, "s1-parent", rows)
  expect(writes).not.toHaveBeenCalled()
})

it("retains accepted thread fields through an unrelated optimistic overlay", async () => {
  const db = await setup()
  projectCommunityWsEventToDb(db.queryClient, { type: "community:channel.create", serverId: "s1", channel: channelResourceFixture({ id: "thread", serverId: "s1", type: "thread", parentChannelId: "s1-parent", parentMessageId: "opener" }) })
  await writeCommunityCollectionChanges(db, "channels", [{ ...readCommunityCollectionRow(db, "channels", "thread"), tags: ["accepted"] }])
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const transaction = db.dbClient.createTransaction({ mutationFn: () => held })
  transaction.mutate(() => db.collections.channels.update("thread", row => { row.tags = ["optimistic"] }))
  try {
    await completeCommunityPublication(db, () => ingestMessages(db, "s1-parent", [messageResourceFixture({ id: "message", channelId: "s1-parent", thread: { id: "thread", name: "Confirmed", messageCount: 3 } })]))
    expect(readCommunityCollectionRow(db, "channels", "thread")).toMatchObject({ name: "Confirmed", tags: ["accepted"] })
  } finally { release(); await transaction.when("settled") }
  expect(db.collections.channels.get("thread")).toMatchObject({ name: "Confirmed", tags: ["accepted"] })
})

it("does not republish an unchanged ID window and preserves the existing window object", async () => {
  const db = await setup()
  const before = db.queryClient.getQueryData(communityKeys.server("s1"))
  const cache = vi.spyOn(db.queryClient, "setQueryData")
  expect(recordServerDirectoryWindow(db, "s1")).toBe(before)
  expect(directoryWrites(cache)).toEqual([])
})

it("only publishes the directory whose top-level membership changes", async () => {
  const db = await setup()
  const cache = vi.spyOn(db.queryClient, "setQueryData")
  projectCommunityWsEventToDb(db.queryClient, { type: "community:channel.create", serverId: "s1", channel: channelResourceFixture({ id: "new", serverId: "s1" }) })
  expect(directoryWrites(cache)).toEqual(["s1"])
  expect(db.queryClient.getQueryData(communityKeys.server("s1"))).toMatchObject({ channelIds: ["s1-parent", "new"] })
  cache.mockClear()
  projectCommunityWsEventToDb(db.queryClient, { type: "community:channel.update", serverId: "s1", channelId: "new", changes: { name: "renamed" } })
  expect(directoryWrites(cache)).toEqual([])
  projectCommunityWsEventToDb(db.queryClient, { type: "community:channel.delete", serverId: "s1", channelId: "new" })
  expect(directoryWrites(cache)).toEqual(["s1"])
})

it("reconciles both existing scopes when a confirmed directory row moves servers", async () => {
  const db = await setup()
  const cache = vi.spyOn(db.queryClient, "setQueryData")
  ingestServerDetail(db, { server: serverResourceFixture({ id: "s2" }), categories: [], channels: [channelResourceFixture({ id: "s1-parent", serverId: "s2" })] })
  expect(new Set(directoryWrites(cache))).toEqual(new Set(["s1", "s2"]))
  expect(db.queryClient.getQueryData(communityKeys.server("s1"))).toMatchObject({ channelIds: [] })
  expect(db.queryClient.getQueryData(communityKeys.server("s2"))).toMatchObject({ channelIds: ["s1-parent"] })
})

it("keeps authoritative empty snapshots and does not create uncached directories during reconciliation", async () => {
  const db = await setup()
  const cache = vi.spyOn(db.queryClient, "setQueryData")
  ingestServerDetail(db, { server: serverResourceFixture({ id: "s1" }), categories: [], channels: [] })
  expect(directoryWrites(cache)).toEqual(["s1"])
  expect(db.queryClient.getQueryData(communityKeys.server("s1"))).toMatchObject({ categoryIds: [], channelIds: [] })
  cache.mockClear()
  reconcileExistingServerDirectoryWindows(db, new Set(["unknown"]))
  expect(directoryWrites(cache)).toEqual([])
  expect(db.queryClient.getQueryData(communityKeys.server("unknown"))).toBeUndefined()
})
