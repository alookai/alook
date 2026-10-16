import React, { useEffect } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClientProvider } from "@tanstack/react-query"
import type { ApiRequestOptions } from "@/lib/api/client"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { dmConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { retireCommunityAccount } from "@/lib/community/account-cache-lifecycle"
import { communityKeys } from "@/lib/query-keys"
import { retireCommunityChannelReading, publishCommunityLiveSnapshot, captureCommunityLiveSnapshotToken, ingestReadStateSnapshot } from "@/lib/community-db/sync"
import { useChannelMetadata } from "@/hooks/community/use-channel-metadata"
import { useDmMessages } from "@/hooks/community/use-messages"
import { prepareNavigationMetadata } from "@/lib/community/navigation-metadata"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: async (path: string, options?: ApiRequestOptions) => { options?.assertActive?.(); const result = await load(path, options); options?.assertActive?.(); return result } }))
beforeEach(() => { load.mockReset() })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
describe("native navigation warming and DM consumer mounting", () => {
  it.each([
    [false, "held"], [true, "held"],
    [false, "resolved"], [true, "resolved"],
    [false, "return"], [true, "return"],
  ] as const)("uses one entry with strict=%s warming=%s", async (strict, mode) => {
    const owner = await createCommunityQueryOwner()
    const entry = dmConversationEntryFixture()
    if (mode === "return") {
      await seedConversationEntry(owner.client, entry)
      ingestReadStateSnapshot(owner.registry, { revision: 22, readStates: [{ channelId: "c1", lastReadMessageId: "m28", lastReadSeq: 28, lastReadAt: "later" }] })
      entry.messages = Array.from({ length: 26 }, (_, n) => ({ ...entry.messages[0], id: `m${n + 3}`, seq: n + 3 }))
      entry.channel.messageCount = 28
      entry.readState = { ...entry.readState, lastReadMessageId: "m28", lastReadSeq: 28, lastReadAt: "later" }
      entry.readStateRevision = 22
      entry.selection = { reason: "read_pointer", anchorMessageId: "m28" }
      entry.page.latestSeq = 28
    } else {
      publishCommunityLiveSnapshot(owner.client, { snapshot: { kind: "dms", data: { conversations: [{ id: "c1", userId: "peer", name: "Peer", discriminator: "0042", avatarVersion: 0, avatar: "P", status: "offline", preview: "" }] } }, proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(owner.client), signal: undefined } })
    }
    const pending = deferred<typeof entry>()
    load.mockReturnValue(pending.promise)
    const warming = prepareNavigationMetadata(owner.client, "/c/me/c1", "foreground")
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    if (mode !== "held") await act(async () => { pending.resolve(entry); await warming })
    const navigation = { entryIntent: { href: "/c/me/c1" } }
    const wrapper = ({ children }: React.PropsWithChildren) => <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}><CommunityRouteContext value={{ navigation } as never}>{children}</CommunityRouteContext></CommunityDbProvider></QueryClientProvider>
    const lifetime = { setup: 0, cleanup: 0 }
    const hook = renderHook(() => {
      useEffect(() => { lifetime.setup += 1; return () => { lifetime.cleanup += 1 } }, [])
      return { metadata: useChannelMetadata(null, "c1"), messages: useDmMessages("c1") }
    }, { wrapper, reactStrictMode: strict })
    if (mode === "held") await act(async () => { pending.resolve(entry); await warming })
    await waitFor(() => expect(hook.result.current.metadata.canRead).toBe(true))
    await waitFor(() => expect(hook.result.current.messages.messages.some(m => m.id === (mode === "return" ? "m28" : "m1"))).toBe(true))
    const rows = load.mock.calls.map(([path, options]) => ({ path, aborted: (options as ApiRequestOptions | undefined)?.signal?.aborted ?? false }))
    console.log(JSON.stringify({ strict, mode, lifetime, calls: rows }))
    expect(lifetime.setup).toBe(strict ? 2 : 1)
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
    await waitFor(() => expect(owner.client.getQueryCache().findAll({ queryKey: communityKeys.conversationEntries("c1") }).reduce((n, q) => n + q.getObserversCount(), 0)).toBe(0))
  })
  it.each(["account", "channel"] as const)("still cancels warming and rejects late data after %s retirement", async kind => {
    const owner = await createCommunityQueryOwner()
    const entry = dmConversationEntryFixture()
    publishCommunityLiveSnapshot(owner.client, { snapshot: { kind: "dms", data: { conversations: [{ id: "c1", userId: "peer", name: "Peer", discriminator: "0042", avatarVersion: 0, avatar: "P", status: "offline", preview: "" }] } }, proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(owner.client), signal: undefined } })
    const pending = deferred<typeof entry>()
    load.mockReturnValue(pending.promise)
    const warming = prepareNavigationMetadata(owner.client, "/c/me/c1", "foreground")
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    const signal = (load.mock.calls[0][1] as ApiRequestOptions).signal!
    const originals = owner.client.getQueryCache().findAll({ queryKey: communityKeys.conversationEntries("c1") })
    expect(originals).toHaveLength(1)
    const original = originals[0]
    if (kind === "account") retireCommunityAccount(owner.registry)
    else retireCommunityChannelReading(owner.registry, "c1", { reason: "read-denied", serverId: null })
    await warming
    expect(original.getObserversCount()).toBe(0)
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve(entry); await Promise.resolve() })
    expect(owner.registry.collections.channels.get("c1")?.resourceComplete).not.toBe(true)
    expect(owner.client.getQueryCache().findAll({ queryKey: communityKeys.conversationEntries("c1") }).reduce((n, q) => n + q.getObserversCount(), 0)).toBe(0)
    expect(load).toHaveBeenCalledOnce()
  })

})
