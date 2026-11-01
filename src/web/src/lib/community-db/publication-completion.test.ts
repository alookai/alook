import { QueryClient } from "@tanstack/react-query"
import { afterEach, expect, it, vi } from "vitest"
import { createCommunityDbRegistry, registerCommunityDbRegistry, type CommunityDbRegistry } from "./collections"
import { captureCommunityLiveSnapshotToken, completeCommunityPublication, patchCanonicalCommunityMessage, publishCommunityCreatedChannel, publishCommunityConversationReadState, ingestServerDetail } from "./sync"
import { withCommunityCollectionWrites, writeCommunityCollectionRows, writeCommunityCollectionChanges, parseCommunityCollectionRows } from "./write"
import { profileSchema, messageSchema, canonicalChannelRow } from "./schema"
import { writeCommunityProfilePatches } from "@/lib/community/profile-seed"
import { retireCommunityAccount } from "@/lib/community/account-cache-lifecycle"
import { publishConversationEntry, conversationEntryOptions } from "@/lib/community/conversation-entry"
import { dmConversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { profileResourceFixture, messageResourceFixture, channelResourceFixture, serverResourceFixture } from "@/test/community-resource-fixtures"
import { communityKeys } from "@/lib/query-keys"

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
  return db
}
function heldCompletion(db: CommunityDbRegistry) {
  let resolve!: () => void, reject!: (error: Error) => void
  const held = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const utils = db.collections.profiles.utils
  const write = utils.writeBatch.bind(utils)
  vi.spyOn(utils, "writeBatch").mockImplementation(callback => write(callback).then(() => held))
  return { resolve, reject }
}

it.each(["complete", "reject", "retire"] as const)("keeps the entry window unpublished until native completion: %s", async outcome => {
  const db = await setup(), held = heldCompletion(db)
  const target = { channelId: "c1", serverId: null }
  const initial = dmConversationEntryFixture()
  const key = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m1" })
  const operation = Promise.resolve(publishConversationEntry(db.queryClient, target, initial, { token: captureCommunityLiveSnapshotToken(db.queryClient, "c1") }))
  let settled = false
  void operation.then(() => { settled = true }, () => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(db.queryClient.getQueryData(key)).toBeUndefined()
  expect(db.queryClient.getQueryData(conversationEntryOptions(db.queryClient, target).queryKey)).toBeUndefined()
  if (outcome === "reject") {
    const error = new Error("native completion rejected")
    held.reject(error)
    await expect(operation).rejects.toBe(error)
    expect(db.collections.messages.get("m1")?.content).toBe("Body")
    expect(db.queryClient.getQueryData(key)).toBeUndefined()
  } else if (outcome === "retire") {
    retireCommunityAccount(db)
    held.resolve()
    await expect(operation).rejects.toMatchObject({ name: "AbortError" })
    expect(db.queryClient.getQueryData(key)).toBeUndefined()
  } else {
    held.resolve()
    const resource = await operation
    expect(db.queryClient.getQueryData(resource.windowKey)).toMatchObject({ pages: [{ messages: [{ id: "m1" }] }] })
  }
})

it("handles already-started completion rejection when synchronous publication fails", async () => {
  const db = await setup(), held = heldCompletion(db)
  const error = new Error("synchronous publication failed")
  expect(() => withCommunityCollectionWrites(db, () => {
    writeCommunityProfilePatches([{ id: "peer", identityAbout: { name: "Peer", discriminator: "0042" }, avatar: { avatar: null, avatarVersion: 0 } }], db)
    throw error
  })).toThrow(error)
  held.reject(new Error("native rejected after body failure"))
  await Promise.resolve()
  await Promise.resolve()
})

it.each([0, 1000])("validates only changed profile keys with %s unrelated profiles", async count => {
  const db = await setup()
  await writeCommunityCollectionRows(db, "profiles", [profileResourceFixture({ id: "peer" }), ...Array.from({ length: count }, (_, i) => profileResourceFixture({ id: `unrelated-${i}` }))], row => row.id)
  const untouched = db.collections.profiles.get("unrelated-0")
  const parse = vi.spyOn(profileSchema, "parse"), safeParse = vi.spyOn(profileSchema, "safeParse")
  await writeCommunityProfilePatches([{ id: "peer", identityAbout: { name: "changed" } }], db)
  expect(parse).toHaveBeenCalledTimes(1)
  expect(safeParse.mock.calls.length).toBeLessThanOrEqual(2)
  expect([...parse.mock.calls, ...safeParse.mock.calls].every(([row]) => (row as { id: string }).id === "peer")).toBe(true)
  expect(db.collections.profiles.get("unrelated-0")).toBe(untouched)
  expect(db.collections.profiles.get("peer")?.name).toBe("changed")
})

it.each([0, 1000])("validates a keyed message patch independently of %s unrelated messages", async count => {
  const db = await setup()
  await writeCommunityCollectionRows(db, "messages", [messageResourceFixture({ id: "target" }), ...Array.from({ length: count }, (_, i) => messageResourceFixture({ id: `unrelated-${i}`, channelId: "other" }))], row => row.id)
  const parse = vi.spyOn(messageSchema, "parse"), safeParse = vi.spyOn(messageSchema, "safeParse")
  await completeCommunityPublication(db, () => patchCanonicalCommunityMessage(db.queryClient, "target", row => ({ ...row, content: "changed" })))
  expect(parse).toHaveBeenCalledTimes(1)
  expect(safeParse).toHaveBeenCalledTimes(1)
  expect([...parse.mock.calls, ...safeParse.mock.calls].every(([row]) => (row as { id: string }).id === "target")).toBe(true)
  expect(db.collections.messages.get("target")?.content).toBe("changed")
})

it.each([false, true])("still rejects mutated parsed inputs at native or pre-ready admission: ready=%s", async ready => {
  const db = createCommunityDbRegistry(new QueryClient(), "viewer")
  owners.push(db)
  if (ready) await db.preload()
  const key = communityKeys.communityDbCollection(db.scopeId, "profiles")
  const before = db.queryClient.getQueryData(key)
  await expect(async () => withCommunityCollectionWrites(db, () => {
    const [row] = parseCommunityCollectionRows(db, "profiles", [profileResourceFixture({ id: "peer" })])
    row!.avatar = undefined as never
    return writeCommunityCollectionChanges(db, "profiles", [row])
  })).rejects.toThrow()
  expect(db.queryClient.getQueryData(key)).toBe(before)
})

function heldAcceptance(db: CommunityDbRegistry, name: "profiles" | "channels" | "readStates") {
  const utils = db.collections[name].utils
  const write = utils.writeBatch.bind(utils)
  const pending: Array<() => Promise<void>> = []
  const spy = vi.spyOn(utils, "writeBatch").mockImplementation(callback => new Promise<void>((resolve, reject) => {
    pending.push(() => write(callback).then(resolve, reject))
  }))
  return async () => { spy.mockRestore(); await Promise.all(pending.splice(0).map(publish => publish())) }
}

it("keeps newer message avatar hints after a profile acceptance wait", async () => {
  const db = await setup(), release = heldAcceptance(db, "profiles")
  const entry = dmConversationEntryFixture()
  entry.messages = entry.messages.map(message => ({ ...message, authorAvatar: "new-avatar", authorAvatarVersion: 7 }))
  const operation = Promise.resolve(publishConversationEntry(db.queryClient, { channelId: "c1", serverId: null }, entry, { token: captureCommunityLiveSnapshotToken(db.queryClient, "c1") }))
  try {
    expect(db.collections.profiles.get("peer")).toBeUndefined()
  } finally { await release() }
  await operation
  expect(db.collections.profiles.get("peer")).toMatchObject({ avatar: "new-avatar", avatarVersion: 7 })
})

it("records creator membership only after the new channel is accepted", async () => {
  const db = await setup()
  ingestServerDetail(db, { server: serverResourceFixture({ id: "server" }), categories: [], channels: [] })
  const release = heldAcceptance(db, "channels")
  let settle!: () => void
  const held = new Promise<void>(resolve => { settle = resolve })
  const transaction = db.dbClient.createTransaction({ mutationFn: () => held })
  transaction.mutate(() => db.collections.channels.insert(canonicalChannelRow({ ...channelResourceFixture({ id: "new", serverId: "server" }), pending: true })))
  const operation = Promise.resolve(completeCommunityPublication(db, () => publishCommunityCreatedChannel(db.queryClient, { ...channelResourceFixture({ id: "new", serverId: "server" }), pending: false }, { token: captureCommunityLiveSnapshotToken(db.queryClient) })))
  try {
    expect(db.collections.channels.get("new")?.pending).toBe(true)
    expect(db.queryClient.getQueryData(communityKeys.server("server"))).toMatchObject({ channelIds: [] })
    await release()
    await operation
    expect(db.queryClient.getQueryData(communityKeys.server("server"))).toMatchObject({ channelIds: ["new"] })
  } finally { await release(); settle(); await transaction.when("settled") }
  expect(db.collections.channels.get("new")?.pending).toBe(false)
  expect(db.collections.channelMemberships.get("new:viewer:access")).toMatchObject({ channelId: "new", userId: "viewer", relation: "access" })
})

it("projects confirmed attention after the read-state row is accepted", async () => {
  const db = await setup()
  await writeCommunityCollectionRows(db, "attentionScopes", [{ scopeId: "c1", channelId: "c1", serverId: null, parentChannelId: null, ordinaryUnread: true, lastUnreadSeq: 3, lastAttentionSeq: null, attentionCount: 0 }], row => row.scopeId)
  const release = heldAcceptance(db, "readStates")
  const operation = Promise.resolve(publishCommunityConversationReadState(db.queryClient, { channelId: "c1", lastReadMessageId: "m3", lastReadAt: "2026-11-01T00:00:00Z", lastReadSeq: 3 }, 1, { token: captureCommunityLiveSnapshotToken(db.queryClient) }))
  try { expect(db.collections.attentionScopes.get("c1")?.ordinaryUnread).toBe(true) }
  finally { await release() }
  await operation
  expect(db.collections.attentionScopes.has("c1")).toBe(false)
})
