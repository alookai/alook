import { dehydrate } from "@tanstack/react-query"
import { afterEach, expect, it, vi } from "vitest"
import { COMMUNITY_CONTRACT_HEADER, COMMUNITY_CONTRACT_VERSION } from "@alook/shared"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { dmConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { PERSIST_BUSTER, readCommunityRestoredCollections } from "@/lib/query-persister"
import { writeCommunityCollectionRows } from "@/lib/community-db/write"
import { retireCommunityAccount } from "./account-cache-lifecycle"
import { communityKeys } from "@/lib/query-keys"
import { assessConversationScope, conversationEntryOptions, currentConversationReadState, findConversationEntryWindow } from "./conversation-entry"
import type { MessageWindowData } from "./message-window"
import { restoreConversationDisplayWindows } from "./restored-conversation-window"

afterEach(() => vi.restoreAllMocks())

async function setup() {
  const owner = await createCommunityQueryOwner()
  const entry = dmConversationEntryFixture()
  entry.messages = [1, 3, 4].map(seq => ({ ...entry.messages[0], id: `m${seq}`, seq, createdAt: `2026-10-01T00:00:0${seq}.000Z` }))
  entry.page.latestSeq = 4
  await seedConversationEntry(owner.client, entry)
  const input = readCommunityRestoredCollections({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(owner.client) }, "viewer")
  const key = communityKeys.channelMessages("c1")
  const networkWindow = owner.client.getQueryData(key)
  owner.client.removeQueries({ queryKey: key })
  owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
  owner.registry.bindAuthentication(() => undefined, async () => {})
  return { ...owner, input, key, networkWindow }
}

it("restores only the newest contiguous canonical suffix without claiming either history boundary", async () => {
  const { registry, client, input, key } = await setup()
  restoreConversationDisplayWindows(registry, input)
  const data = client.getQueryData<MessageWindowData>(key)!
  expect(data.pages[0].messages.map(row => row.id)).toEqual(["m3", "m4"])
  expect(data.pages[0]).toMatchObject({ hasMoreOlder: true, hasMoreNewer: true, latestSeq: 4,
    olderCursor: "2026-10-01T00:00:03.000Z|m3", newerCursor: "2026-10-01T00:00:04.000Z|m4" })
  const target = { channelId: "c1", serverId: null }
  expect(findConversationEntryWindow(client, target, assessConversationScope(client, target).scope!, currentConversationReadState(client, "c1"))).toBeUndefined()
  expect(() => registry.assertOnlineAccount()).toThrow(expect.objectContaining({ name: "AbortError" }))
})

it("preserves a network window that settled before restoration", async () => {
  const { registry, client, input, key, networkWindow } = await setup()
  client.setQueryData(key, networkWindow)
  restoreConversationDisplayWindows(registry, input)
  expect(client.getQueryData(key)).toBe(networkWindow)
})

it.each(["unchanged tail", "new message"] as const)("confirms an %s through the original request and reconciliation after cached display", async condition => {
  const { registry, client, input, key } = await setup()
  restoreConversationDisplayWindows(registry, input)
  registry.bindAuthentication(() => "viewer", async () => {})
  registry.confirmAuthentication()
  const entry = dmConversationEntryFixture()
  entry.messages = (condition === "new message" ? [1, 3, 4, 5] : [3, 4]).map(seq => ({ ...entry.messages[0], id: seq === 5 ? "fresh" : `m${seq}`, seq, content: seq === 5 ? "Fresh" : "Body", createdAt: `2026-10-01T00:00:0${seq}.000Z` }))
  entry.page.latestSeq = condition === "new message" ? 5 : 4
  const load = vi.spyOn(globalThis, "fetch").mockImplementation(async input => Response.json(
    new URL(String(input), "https://fixture.test").searchParams.has("entry") ? entry : { contractVersion: entry.contractVersion, channelId: entry.channelId, surfaceReceipt: entry.surfaceReceipt, page: entry.page, messages: entry.messages, profiles: entry.profiles },
    { headers: { [COMMUNITY_CONTRACT_HEADER]: String(COMMUNITY_CONTRACT_VERSION) } },
  ))
  await client.query(conversationEntryOptions(client, { channelId: "c1", serverId: null }))
  await client.getQueryCache().find({ queryKey: [...key, "reconcile"], exact: true })?.promise
  await vi.waitFor(() => expect(client.getQueryData<MessageWindowData>(key)?.pages[0].hasMoreNewer).toBe(false))
  if (condition === "new message") expect(registry.collections.messages.get("fresh")?.content).toBe("Fresh")
  expect(findConversationEntryWindow(client, { channelId: "c1", serverId: null }, assessConversationScope(client, { channelId: "c1", serverId: null }).scope!, currentConversationReadState(client, "c1"))).toBeDefined()
  expect(load).toHaveBeenCalled()
})

it.each(["other account", "missing access", "revoked", "retired", "missing profile", "missing body"] as const)("cannot create a display window with %s", async condition => {
  const { registry, client, input, key } = await setup()
  if (condition === "other account") registry.bindAuthentication(() => "B", async () => {})
  if (condition === "missing access") await writeCommunityCollectionRows(registry, "channelMemberships", [], row => row.id)
  if (condition === "revoked") registry.runtime.ws.actions.revokeChannelAccess(null, "c1")
  if (condition === "retired") retireCommunityAccount(registry)
  if (condition === "missing profile") await writeCommunityCollectionRows(registry, "profiles", [], row => row.id)
  if (condition === "missing body") await writeCommunityCollectionRows(registry, "messages", [], row => row.id)
  restoreConversationDisplayWindows(registry, input)
  expect(client.getQueryData(key)).toBeUndefined()
})
