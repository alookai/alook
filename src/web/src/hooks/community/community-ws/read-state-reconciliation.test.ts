import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import { captureCommunityLiveSnapshotToken, publishCommunityConversationReadState } from "@/lib/community-db/sync"
import { currentConversationReadState } from "@/lib/community/conversation-entry"
import { disposeAccountReadStateReconciliation, projectReadStateEnvelope, reconcileAccountReadState } from "./read-state-reconciliation"

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))
let owner: Awaited<ReturnType<typeof createCommunityQueryOwner>>
const row = (seq: number) => ({ channelId: "c1", lastReadMessageId: `m${seq}`, lastReadAt: `2026-10-27T00:00:0${seq}.000Z`, lastReadSeq: seq })
const snapshot = (revision: number, seq = revision) => ({ revision, readStates: [row(seq)] })
const attention = { scopes: [], items: [], limit: 100, truncated: false, included: { servers: [], channels: [], dms: [], profiles: [], messages: [] } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(async () => { apiFetch.mockReset(); owner = await createCommunityQueryOwner(); apiFetch.mockImplementation(async (path: string) => path.endsWith("/attention") ? attention : snapshot(1)) })
afterEach(async () => { await owner.client.cancelQueries(); await owner.registry.cleanup(); owner.client.clear(); vi.useRealTimers() })

describe("native account read-state reconciliation", () => {
  it("publishes canonical cursors and caches only the transport revision", async () => {
    await reconcileAccountReadState(owner.client)
    expect(currentConversationReadState(owner.client, "c1")).toMatchObject(row(1))
    expect(owner.client.getQueryData(communityKeys.accountReadStateSnapshot())).toEqual({ revision: 1 })
    expect(apiFetch.mock.calls.map(([path]) => path)).toEqual(["/api/community/users/me/read-state", "/api/community/users/me/attention", "/api/community/users/me/attention"])
    expect(projectReadStateEnvelope(owner.client, { revision: 1, inboxChanged: true })).toBe("stale")
    expect(projectReadStateEnvelope(owner.client, { revision: 2, inboxChanged: true })).toBe("gap")
  })

  it("shares both native transports without a second attention read when the confirmed revision stays current", async () => {
    await reconcileAccountReadState(owner.client, { reconcileAttention: false })
    apiFetch.mockClear()
    await Promise.all([reconcileAccountReadState(owner.client), reconcileAccountReadState(owner.client)])
    expect(apiFetch.mock.calls.map(([path]) => path)).toEqual(["/api/community/users/me/read-state", "/api/community/users/me/attention"])
  })

  it("rechecks an early attention count only after a held read-state advances its confirmed revision", async () => {
    const gate = deferred<ReturnType<typeof snapshot>>()
    let attentionReads = 0
    apiFetch.mockImplementation(async (path: string) => path.endsWith("/read-state") ? gate.promise : {
      ...attention,
      scopes: [{ scopeId: "c1", channelId: "c1", serverId: null, parentChannelId: null, ordinaryUnread: true, lastUnreadSeq: 5, unreadCount: ++attentionReads === 1 ? 5 : 3, attentionCount: 0, lastAttentionSeq: null }],
      included: { ...attention.included, dms: [{ id: "c1", userId: "peer", name: "Peer", discriminator: "0002", avatar: "P", avatarVersion: 0, lastMessageAt: "2026-10-27T00:00:05.000Z", lastUnreadSeq: 5 }], profiles: [{ userId: "peer", name: "Peer", discriminator: "0002", avatar: "P", avatarVersion: 0 }] },
    })
    const outcome = reconcileAccountReadState(owner.client).then(() => null, error => error)
    try {
      await vi.waitFor(() => expect(owner.registry.collections.attentionScopes.get("c1")?.unreadCount).toBe(5))
    } finally {
      gate.resolve(snapshot(3, 2))
      expect(await outcome).toBeNull()
    }
    expect(owner.registry.collections.readStates.get("c1")?.lastReadSeq).toBe(2)
    expect(owner.registry.collections.attentionScopes.get("c1")).toMatchObject({ lastUnreadSeq: 5, unreadCount: 3 })
    expect(attentionReads).toBe(2)
  })

  it("joins simultaneous reads through the original native Query", async () => {
    const gate = deferred<ReturnType<typeof snapshot>>()
    apiFetch.mockReturnValue(gate.promise)
    const first = reconcileAccountReadState(owner.client, { reconcileAttention: false })
    const second = reconcileAccountReadState(owner.client, { reconcileAttention: false })
    expect(apiFetch).toHaveBeenCalledOnce()
    gate.resolve(snapshot(2))
    expect((await Promise.all([first, second])).map(value => value.revision)).toEqual([2, 2])
    expect(apiFetch).toHaveBeenCalledOnce()
  })

  it("retries an old in-flight snapshot against a later revision target without publishing it", async () => {
    vi.useFakeTimers()
    const gate = deferred<ReturnType<typeof snapshot>>()
    apiFetch.mockReturnValueOnce(gate.promise).mockResolvedValue(snapshot(5))
    const first = reconcileAccountReadState(owner.client, { targetRevision: 2, reconcileAttention: false })
    const second = reconcileAccountReadState(owner.client, { targetRevision: 5, reconcileAttention: false })
    gate.resolve(snapshot(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(owner.registry.collections.readStates.get("c1")?.lastReadSeq).not.toBe(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await Promise.all([first, second])).map(value => value.revision)).toEqual([5, 5])
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it("reads the newer target when it arrives during native successful-result publication", async () => {
    vi.useFakeTimers()
    const newer = deferred<ReturnType<typeof snapshot>>()
    apiFetch.mockResolvedValueOnce(snapshot(2)).mockReturnValueOnce(newer.promise).mockResolvedValue(snapshot(5))
    let second: ReturnType<typeof reconcileAccountReadState> | undefined
    const unsubscribe = owner.client.getQueryCache().subscribe(event => {
      if (event.type === "updated" && event.action.type === "success"
        && event.query.queryHash === owner.client.getQueryCache().find({ queryKey: communityKeys.accountReadStateSnapshot(), exact: true })?.queryHash
        && (event.query.state.data as { revision?: number } | undefined)?.revision === 2) {
        second = reconcileAccountReadState(owner.client, { targetRevision: 5, reconcileAttention: false })
      }
    })
    const first = reconcileAccountReadState(owner.client, { targetRevision: 2, reconcileAttention: false })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(apiFetch).toHaveBeenCalledTimes(2)
      newer.resolve(snapshot(3))
      await vi.advanceTimersByTimeAsync(1_000)
      expect((await Promise.all([first, second!])).map(value => value.revision)).toEqual([5, 5])
      expect(apiFetch).toHaveBeenCalledTimes(3)
      expect(owner.registry.collections.readStates.get("c1")?.lastReadSeq).toBe(5)
    } finally {
      unsubscribe()
      newer.resolve(snapshot(5))
      await Promise.allSettled([first, second])
    }
  })

  it("preserves a newer confirmed ACK floor across an older full snapshot", async () => {
    publishCommunityConversationReadState(owner.client, row(7), 7, { token: captureCommunityLiveSnapshotToken(owner.client), signal: undefined })
    apiFetch.mockResolvedValue(snapshot(6))
    await reconcileAccountReadState(owner.client, { reconcileAttention: false })
    expect(currentConversationReadState(owner.client, "c1")).toMatchObject(row(7))
    expect(owner.registry.collections.readStateClock.get("account")?.revision).toBe(6)
  })

  it.each(["query", "account", "access", "owner"] as const)("rejects an ignored-abort response after original %s retirement", async (kind) => {
    const gate = deferred<ReturnType<typeof snapshot>>()
    apiFetch.mockReturnValue(gate.promise)
    const pending = reconcileAccountReadState(owner.client, { reconcileAttention: false }).catch(error => error)
    if (kind === "query") owner.client.removeQueries({ queryKey: communityKeys.accountReadStateSnapshot(), exact: true })
    if (kind === "account") owner.runtime.ws.actions.activateProfileAccount("different")
    if (kind === "access") owner.runtime.ws.actions.revokeChannelAccess("s1", "c1")
    if (kind === "owner") disposeAccountReadStateReconciliation(owner.client)
    gate.resolve(snapshot(8))
    expect(await pending).toBeInstanceOf(Error)
    expect(owner.registry.collections.readStates.get("c1")).toBeUndefined()
  })

  it("reports a transport failure without blocking later lifecycle reconciliation", async () => {
    apiFetch.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(snapshot(3))
    await expect(reconcileAccountReadState(owner.client, { targetRevision: 3, reconcileAttention: false })).rejects.toThrow("offline")
    expect(owner.client.getQueryState(communityKeys.accountReadStateSnapshot())?.status).toBe("error")
    expect((await reconcileAccountReadState(owner.client, { targetRevision: 3, reconcileAttention: false })).revision).toBe(3)
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })
})
