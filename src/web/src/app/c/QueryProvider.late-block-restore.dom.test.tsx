import "fake-indexeddb/auto"
import React from "react"
import { dehydrate, useIsRestoring } from "@tanstack/react-query"
import { it, expect, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { seedConversationEntry, dmConversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { createIdbPersister, PERSIST_BUSTER, PERSIST_CACHE_PREFIX } from "@/lib/query-persister"
import { QueryProvider } from "@/app/c/QueryProvider"
import { CommunityRestoreBoundary } from "@/components/community/shell/community-restore-bootstrap"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import { dispatchCommunityWsEvents } from "@/hooks/community/community-ws/registry"
import { writeCommunityCollectionRows } from "@/lib/community-db/write"
import { installCommunityDocumentSeed, type CommunityDocumentSeed } from "@/lib/community/document-seed"
import { communityCollectionQuery, communityJoinedMessagesQuery } from "@/lib/community-db/queries"
import { preloadCommunityProjection, dehydrateCommunityProjections } from "@/lib/community-db/live-query"
import { useDmMessages } from "@/hooks/community/use-messages"
import { communityKeys } from "@/lib/query-keys"
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: { user: { id: "viewer" } }, isPending: false, error: null }), currentSessionViewer: () => "viewer" }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/c/me/c1" }))
it.each([null, false, true].flatMap(blockMode => (["accepted", "incoming"] as const).map(kind => [blockMode, kind] as const)))("finishes original IDB restore with full block mode=%s relationship=%s", async (blockMode, kind) => {
  const blocked = blockMode !== null
  const old = await createCommunityQueryOwner()
  await seedConversationEntry(old.client, dmConversationEntryFixture())
  await writeCommunityCollectionRows(old.registry, "friendships", [{ id: "friend-peer", userId: "peer", kind }, { id: "friend-other", userId: "other", kind: "incoming" }], row => row.id)
  await writeCommunityCollectionRows(old.registry, "attentionItems", [
    { id: "friend_request:other", kind: "friend_request", sourceId: "friend-other", actorUserId: "other", createdAt: "2026-10-01T00:00:00Z" },
    ...(kind === "incoming" ? [{ id: "friend_request:peer", kind: "friend_request", sourceId: "friend-peer", actorUserId: "peer", createdAt: "2026-10-01T00:00:00Z" }] : []),
  ], row => row.id)
  const disk = createIdbPersister("viewer")
  await disk.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(old.client) })
  const fresh = dmConversationEntryFixture()
  fresh.messages = [{ ...fresh.messages[0], id: "m2", seq: 2, content: "Fresh RSC" }]
  fresh.readState = { ...fresh.readState, lastReadMessageId: "m2", lastReadSeq: 2 }
  fresh.selection = { reason: "read_pointer", anchorMessageId: "m2" }
  const selfProfile = { id: "viewer", name: "Viewer", discriminator: "0001", avatar: "V", avatarVersion: 0, aboutMe: "", bannerColor: null, statusEmoji: "", statusText: "" }
  const source = await createCommunityQueryOwner()
  const seed: CommunityDocumentSeed = { viewerId: "viewer", href: "/c/me/c1", generatedAt: Date.now(), selfProfile, entries: [{ target: { channelId: "c1", serverId: null }, data: fresh }], db: { collections: [] } }
  installCommunityDocumentSeed(source.client, source.registry, seed, "viewer")
  const descriptors = [communityCollectionQuery(source.registry, "profiles"), communityCollectionQuery(source.registry, "channels"), communityCollectionQuery(source.registry, "channelMemberships"), communityCollectionQuery(source.registry, "readStates"), communityJoinedMessagesQuery(source.registry, "c1", ["m2"])]
  const bindings = await Promise.all(descriptors.map(d => preloadCommunityProjection(source.registry, d)))
  seed.db = { ...dehydrateCommunityProjections(source.registry, bindings), collections: [] }
  const original = IDBObjectStore.prototype.get
  let reads = 0, held = 0
  let release: (() => void) | undefined
  vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, query) {
    const request = original.call(this, query)
    if (this.transaction.db.name === "keyval-store" && this.name === "keyval" && query === `${PERSIST_CACHE_PREFIX}:viewer:client` && ++reads === 2) {
      const handler = (event: Event) => {
        request.removeEventListener("success", handler)
        event.stopImmediatePropagation(); held++
        const NativeEvent = event.constructor as new (type: string) => Event
        release = () => { request.dispatchEvent(new NativeEvent("success")) }
      }
      request.addEventListener("success", handler, { once: true })
    }
    return request
  })
  const marks: string[] = []
  vi.spyOn(performance, "mark").mockImplementation(name => { marks.push(name); return {} as PerformanceMark })
  let registry: ReturnType<typeof useOptionalCommunityDbRegistry>
  let restoring = true
  let ids: string[] = []
  function Probe() { registry = useOptionalCommunityDbRegistry(); restoring = useIsRestoring(); const body = useDmMessages("c1"); ids = body.messages.map(m => m.id); return null }
  const view = render(<QueryProvider userId="viewer" initialSeed={JSON.parse(JSON.stringify(seed))}><CommunityRestoreBoundary><Probe /></CommunityRestoreBoundary></QueryProvider>)
  try {
    await waitFor(() => expect(held).toBe(1))
    expect(restoring).toBe(true)
    expect(ids).toContain("m2")
    if (blocked) act(() => dispatchCommunityWsEvents([{ type: "community:friend.block", userId: "peer", ...(blockMode ? { blockedByViewer: true } : {}) }], {
      deliveryMode: "batch", contract: 2, queryClient: registry!.queryClient, communityStore: registry!.runtime.ui, wsStore: registry!.runtime.ws,
      sub: { dmConversationId: "c1" }, viewerUserIdRef: { current: "viewer" }, matchesFocus: event => event.channelId === "c1", scheduleInboxInvalidate: () => {},
    }))
    expect(registry!.runtime.ws.actions.isChannelAccessRevoked("c1", null)).toBe(blocked)
    await act(async () => { release!(); await Promise.resolve() })
    await waitFor(() => expect(restoring).toBe(false), { timeout: 1500 })
    expect(marks.filter(name => name === "alook:restore:complete")).toHaveLength(1)
    if (blocked) expect(registry!.queryClient.getQueryData<Array<{ id: string }>>(communityKeys.communityDbCollection("viewer", "messages"))?.map(m => m.id)).not.toContain("m1")
    if (blocked) expect(ids).not.toContain("m2")
    else expect(ids).toContain("m2")
    expect({
      peerFriend: registry!.collections.friendships.has("friend-peer"),
      peerAttention: registry!.collections.attentionItems.has("friend_request:peer"),
      currentBlock: registry!.collections.friendships.has("blocked:peer"),
      unrelatedFriend: registry!.collections.friendships.has("friend-other"),
      unrelatedAttention: registry!.collections.attentionItems.has("friend_request:other"),
    }).toEqual({ peerFriend: !blocked, peerAttention: !blocked && kind === "incoming", currentBlock: blockMode === true, unrelatedFriend: true, unrelatedAttention: true })
  } finally {
    release?.();view.unmount();vi.restoreAllMocks();old.client.clear();source.client.clear()
  }
})
