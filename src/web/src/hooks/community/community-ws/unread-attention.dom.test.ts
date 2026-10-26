import { captureCommunityLiveSnapshotToken, publishCommunityConversationReadState } from "@/lib/community-db/sync"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { capturedOnMessage, capturedQueryClient, canonicalRegistry, cleanupCommunityWsHarness, getCommunityApiFetchMock, mountHook, resetCommunityWsHarness, unreadBump } from "./test-harness"

const at = "2026-10-27T00:00:00.000Z"
function attention(seq: number, kind: "text" | "dm" | "child" = "text") {
  const parent = { id: "parent", serverId: "s1", name: "Parent", type: "forum", parentChannelId: null, parentMessageId: null, creatorId: "peer", archived: false, lastMessageAt: at }
  const channel = { ...parent, id: "c1", name: "Channel", type: kind === "child" ? "thread" : "text", parentChannelId: kind === "child" ? "parent" : null, parentMessageId: kind === "child" ? "opener" : null, ...(kind === "child" ? { openerSeq: 1, openerUnread: false } : {}) }
  return {
    scopes: [{ scopeId: "c1", channelId: "c1", serverId: kind === "dm" ? null : "s1", parentChannelId: kind === "child" ? "parent" : null, ordinaryUnread: true, lastUnreadSeq: seq, attentionCount: 0, lastAttentionSeq: null, ...(kind === "dm" ? { unreadCount: seq } : {}) }],
    items: [], limit: 100, truncated: false,
    included: {
      servers: kind === "dm" ? [] : [{ id: "s1", name: "Server", discriminator: "0001" }],
      channels: kind === "dm" ? [] : kind === "child" ? [parent, channel] : [channel],
      dms: kind === "dm" ? [{ id: "c1", userId: "peer", name: "Peer", discriminator: "0002", avatar: "P", avatarVersion: 0, lastMessageAt: at, lastUnreadSeq: seq }] : [],
      profiles: [{ userId: "peer", name: "Peer", discriminator: "0002", avatar: "P", avatarVersion: 0 }],
      messages: kind === "child" ? [{ id: "opener", channelId: "parent", authorId: "peer", type: "chat", content: "Opener", seq: 1, createdAt: at }] : [],
    },
  }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function transport(read: () => Promise<ReturnType<typeof attention>>) {
  getCommunityApiFetchMock().mockImplementation(async (path: unknown) => {
    if (path === "/api/community/users/me/attention") return read()
    if (path === "/api/community/users/me/read-state") return { revision: 0, readStates: [] }
    if (String(path).includes("/messages")) return { messages: [], hasMore: false }
    throw new Error(`Unexpected transport ${String(path)}`)
  })
}
beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)

it.each(["text", "dm", "child"] as const)("uses qualified HTTP attention for a %s arrival without writing structural unread", async kind => {
  await mountHook({ viewerUserId: "u_me" })
  const gate = deferred<ReturnType<typeof attention>>()
  transport(() => gate.promise)
  const original = { categories: [{ channels: [{ id: "c1", unread: true }] }] }
  capturedQueryClient.setQueryData(communityKeys.server("s1"), original)
  await act(async () => { await capturedOnMessage!(unreadBump("c1", "u_me", { ...(kind === "dm" ? {} : { serverId: "s1", railChannelId: kind === "child" ? "parent" : "c1" }) })) })
  expect(canonicalRegistry!.collections.attentionScopes.size).toBe(0)
  expect(capturedQueryClient.getQueryData(communityKeys.server("s1"))).toBe(original)
  await act(async () => { gate.resolve(attention(4, kind)) })
  await waitFor(() => expect(canonicalRegistry!.collections.attentionScopes.get("c1")?.lastUnreadSeq).toBe(4))
  expect(canonicalRegistry!.collections.channels.get("c1")).not.toHaveProperty("unread")
  expect([...canonicalRegistry!.collections.servers.values()].every(row => !("unread" in row) && !("mentions" in row))).toBe(true)
  expect(getCommunityApiFetchMock().mock.calls.filter(([path]) => path === "/api/community/users/me/attention")).toHaveLength(1)
  expect(getCommunityApiFetchMock().mock.calls.some(([path]) => path === "/api/community/servers" || String(path).endsWith("/unreads"))).toBe(false)
})

it("rejects an ignored-abort old attention response after a newer arrival", async () => {
  await mountHook({ viewerUserId: "u_me" })
  const old = deferred<ReturnType<typeof attention>>()
  let requests = 0
  transport(() => ++requests === 1 ? old.promise : Promise.resolve(attention(5)))
  await act(async () => { await capturedOnMessage!(unreadBump("c1", "u_me", { serverId: "s1" })) })
  await waitFor(() => expect(requests).toBe(1))
  await act(async () => { await capturedOnMessage!(unreadBump("c1", "u_me", { serverId: "s1" })) })
  await waitFor(() => expect(canonicalRegistry!.collections.attentionScopes.get("c1")?.lastUnreadSeq).toBe(5))
  await act(async () => { old.resolve(attention(4)) })
  expect(canonicalRegistry!.collections.attentionScopes.get("c1")?.lastUnreadSeq).toBe(5)
  expect(requests).toBe(2)
})

it("ignores another account's bump without creating unread or issuing attention IO", async () => {
  await mountHook({ viewerUserId: "u_me" })
  const requests = getCommunityApiFetchMock().mock.calls.length
  await act(async () => { await capturedOnMessage!(unreadBump("c1", "someone-else", { serverId: "s1" })) })
  expect(canonicalRegistry!.collections.attentionScopes.size).toBe(0)
  expect(getCommunityApiFetchMock().mock.calls).toHaveLength(requests)
})


it("rejects a pre-confirmation attention count and retries with the same original account owner", async () => {
  await mountHook({ viewerUserId: "u_me" })
  vi.useFakeTimers()
  try {
    const old = deferred<ReturnType<typeof attention>>()
    let requests = 0
    const fresh = attention(5, "dm")
    fresh.scopes[0]!.unreadCount = 3
    transport(() => ++requests === 1 ? old.promise : Promise.resolve(fresh))
    await act(async () => { await capturedOnMessage!(unreadBump("c1", "u_me")) })
    expect(requests).toBe(1)
    await act(async () => {
      publishCommunityConversationReadState(capturedQueryClient, { channelId: "c1", lastReadMessageId: "m2", lastReadAt: at, lastReadSeq: 2 }, 2, { token: captureCommunityLiveSnapshotToken(capturedQueryClient) }, "advance")
      old.resolve(attention(4, "dm"))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(canonicalRegistry!.collections.attentionScopes.get("c1")).toBeUndefined()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(requests).toBe(2)
    expect(canonicalRegistry!.collections.attentionScopes.get("c1")).toMatchObject({ lastUnreadSeq: 5, unreadCount: 3 })
  } finally { vi.useRealTimers() }
})
