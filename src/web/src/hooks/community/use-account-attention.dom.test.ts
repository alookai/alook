import { createElement, type PropsWithChildren } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { COMMUNITY_CONTRACT_HEADER, type AccountAttentionSnapshot } from "@alook/shared"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { accountAttentionMatchesReadState, scheduleAccountAttentionReconcile, useAccountAttention, useAccountAttentionProjection } from "./use-account-attention"
import { reconcileAccountReadState } from "./community-ws/read-state-reconciliation"
import { communityKeys } from "@/lib/query-keys"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))
beforeEach(() => { apiFetchMock.mockReset() })

const message = { id: "message", channelId: "channel", type: "chat", seq: 4, authorId: "peer", authorName: "Peer", authorAvatar: null, authorAvatarVersion: 0, content: "background message", createdAt: "2026-10-24T00:00:00Z", replyToId: null, clientNonce: null, attachments: [], embeds: [], reactions: [], resourceComplete: true }
function snapshot(lastUnreadSeq = 4): AccountAttentionSnapshot {
  return {
    scopes: [{ scopeId: "channel", channelId: "channel", serverId: "server", parentChannelId: null, ordinaryUnread: true, lastUnreadSeq, lastAttentionSeq: null, attentionCount: 0 }],
    items: [], limit: 100, truncated: false,
    included: {
      servers: [{ id: "server", name: "Server", discriminator: "0001" }],
      channels: [{ id: "channel", serverId: "server", name: "general", type: "text", parentChannelId: null, parentMessageId: null, creatorId: null, archived: false, lastMessageAt: message.createdAt }],
      dms: [], profiles: [], messages: [],
    },
  }
}

async function mountOwner(value: AccountAttentionSnapshot) {
  const owner = await createCommunityQueryOwner()
  apiFetchMock.mockImplementation(async (path) => {
    if (path === "/api/community/users/me/attention") return value
    if (path === "/api/community/channels/channel/messages?limit=1") return { messages: [message] }
    if (path === "/api/community/messages/message") return message
    throw new Error(`Unexpected content read ${path}`)
  })
  function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: owner.client }, createElement(CommunityDbProvider, { registry: owner.registry }, children))
  }
  const hook = renderHook(() => useAccountAttention(), { wrapper: Wrapper })
  await waitFor(() => {
    if (hook.result.current.error) throw hook.result.current.error
    expect(hook.result.current.data).toEqual({ loaded: true, readRevision: -1 })
  })
  return { ...owner, hook }
}

describe("closed-Inbox account attention message hydration", () => {
  it("lets the native shell retry a stale D1 response even when transport retries are disabled", async () => {
    const owner = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce({ ...snapshot(), stale: true }).mockResolvedValue(snapshot())
    function Wrapper({ children }: PropsWithChildren) {
      return createElement(QueryClientProvider, { client: owner.client }, createElement(CommunityDbProvider, { registry: owner.registry }, children))
    }
    vi.useFakeTimers()
    const hook = renderHook(useAccountAttention, { wrapper: Wrapper })
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(apiFetchMock).toHaveBeenCalledOnce()
      expect(owner.registry.collections.attentionScopes.size).toBe(0)
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      expect(apiFetchMock).toHaveBeenCalledTimes(2)
      expect(owner.client.getQueryData(communityKeys.accountAttention())).toEqual({ loaded: true, readRevision: -1 })
      expect(owner.registry.collections.attentionScopes.get("channel")?.lastUnreadSeq).toBe(4)
    } finally {
      hook.unmount()
      await owner.client.cancelQueries()
      vi.useRealTimers()
      await owner.registry.cleanup()
      owner.client.clear()
    }
  })

  it("retains the configured transport retry policy and recovers through the same native owner", async () => {
    const owner = await createCommunityQueryOwner()
    apiFetchMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(snapshot())
    function Wrapper({ children }: PropsWithChildren) {
      return createElement(QueryClientProvider, { client: owner.client }, createElement(CommunityDbProvider, { registry: owner.registry }, children))
    }
    const hook = renderHook(useAccountAttention, { wrapper: Wrapper })
    try {
      await waitFor(() => expect(hook.result.current.error?.message).toBe("offline"))
      expect(apiFetchMock).toHaveBeenCalledOnce()
      await act(async () => { await hook.result.current.refetch() })
      expect(owner.client.getQueryData(communityKeys.accountAttention())).toEqual({ loaded: true, readRevision: -1 })
      expect(apiFetchMock).toHaveBeenCalledTimes(2)
    } finally {
      hook.unmount()
      await owner.client.cancelQueries()
      await owner.registry.cleanup()
      owner.client.clear()
    }
  })

  it("finishes the newer exact read while the cancelled old HTTP remains physically held", async () => {
    const owner = await createCommunityQueryOwner()
    let releaseAttention: ((value: AccountAttentionSnapshot) => void) | undefined
    let oldReleased = false
    const signals: AbortSignal[] = []
    let revision = 0
    apiFetchMock.mockImplementation(async (path: string, options: { signal: AbortSignal }) => {
      if (path.endsWith("/read-state")) return { revision, readStates: [] }
      signals.push(options.signal)
      if (signals.length === 1) return new Promise<AccountAttentionSnapshot>(resolve => {
        releaseAttention = value => { oldReleased = true; resolve(value) }
      })
      const value = snapshot(3)
      value.scopes[0].unreadCount = 3
      return value
    })
    await reconcileAccountReadState(owner.client, { reconcileAttention: false })
    function Wrapper({ children }: PropsWithChildren) {
      return createElement(QueryClientProvider, { client: owner.client }, createElement(CommunityDbProvider, { registry: owner.registry }, children))
    }
    const hook = renderHook(() => ({ shell: useAccountAttention(), consumer: useAccountAttentionProjection() }), { wrapper: Wrapper })
    let settled: Promise<unknown> | undefined
    try {
      await waitFor(() => expect(releaseAttention).toBeTypeOf("function"))
      const original = owner.client.getQueryCache().find({ queryKey: communityKeys.accountAttention(), exact: true })
      hook.rerender()
      revision = 1
      settled = Promise.all([reconcileAccountReadState(owner.client), reconcileAccountReadState(owner.client)]).then(() => null, error => error)
      await waitFor(() => expect(owner.registry.collections.attentionScopes.get("channel")?.unreadCount).toBe(3))
      expect(await settled).toBeNull()
      expect(oldReleased).toBe(false)
      expect(signals).toHaveLength(2)
      expect(signals[0].aborted).toBe(true)
      expect(owner.client.getQueryCache().find({ queryKey: communityKeys.accountAttention(), exact: true })).toBe(original)
      await act(async () => { releaseAttention!(snapshot(5)); await Promise.resolve() })
      expect(owner.client.getQueryData(communityKeys.accountAttention())).toEqual({ loaded: true, readRevision: 1 })
      expect(owner.registry.collections.attentionScopes.get("channel")).toMatchObject({ lastUnreadSeq: 3, unreadCount: 3 })
      expect(accountAttentionMatchesReadState(owner.registry)).toBe(true)
    } finally {
      releaseAttention?.(snapshot())
      hook.unmount()
      await owner.client.cancelQueries()
      await settled
      await owner.registry.cleanup()
      owner.client.clear()
    }
  })

  it("keeps the original shell read qualified across read-only consumer renders and auth settlement", async () => {
    const owner = await createCommunityQueryOwner()
    let releaseRead: (() => void) | undefined
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/read-state")) return { revision: 0, readStates: [] }
      return snapshot()
    })
    await reconcileAccountReadState(owner.client, { reconcileAttention: false })
    function Wrapper({ children }: PropsWithChildren) {
      return createElement(QueryClientProvider, { client: owner.client }, createElement(CommunityDbProvider, { registry: owner.registry }, children))
    }
    const hook = renderHook(() => ({ shell: useAccountAttention(), consumer: useAccountAttentionProjection() }), { wrapper: Wrapper })
    try {
      await waitFor(() => expect(hook.result.current.shell.isSuccess).toBe(true))
      const original = owner.client.getQueryCache().find({ queryKey: communityKeys.accountAttention(), exact: true })
      apiFetchMock.mockClear()
      apiFetchMock.mockImplementation(async (path: string) => {
        if (path.endsWith("/read-state")) {
          await new Promise<void>(resolve => { releaseRead = resolve })
          return { revision: 0, readStates: [] }
        }
        return snapshot()
      })
      const settled = reconcileAccountReadState(owner.client).then(() => null, error => error)
      await waitFor(() => expect(releaseRead).toBeTypeOf("function"))
      await waitFor(() => expect(hook.result.current.consumer.isFetching).toBe(false))
      hook.rerender()
      await act(async () => { releaseRead!(); expect(await settled).toBeNull() })
      expect(owner.client.getQueryCache().find({ queryKey: communityKeys.accountAttention(), exact: true })).toBe(original)
      expect(accountAttentionMatchesReadState(owner.registry)).toBe(true)
      expect(apiFetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/community/users/me/read-state", "/api/community/users/me/attention"])
      expect(owner.registry.collections.attentionScopes.get("channel")?.ordinaryUnread).toBe(true)
    } finally {
      releaseRead?.()
      hook.unmount()
      await owner.client.cancelQueries()
      await owner.registry.cleanup()
      owner.client.clear()
    }
  })

  it("hydrates an ID-bearing mention without any Inbox component or message window", async () => {
    const owner = await mountOwner(snapshot())
    const attentionCall = apiFetchMock.mock.calls.find(([path]) => path.endsWith("/attention"))!
    expect(new Headers(attentionCall[1].headers).get(COMMUNITY_CONTRACT_HEADER)).toBe("3")
    scheduleAccountAttentionReconcile(owner.client, { messageId: message.id, channelId: "channel" })
    await waitFor(() => expect(owner.registry.collections.messages.get(message.id)?.resourceComplete).toBe(true))
    expect(owner.registry.collections.messages.get(message.id)?.content).toBe(message.content)
    expect(apiFetchMock.mock.calls.filter(([path]) => path.includes("/seq/"))).toHaveLength(0)
    expect(apiFetchMock.mock.calls.every(([path]) => !path.endsWith("/read"))).toBe(true)
    owner.hook.unmount()
  })

  it("hydrates a hint-only unread while its account index reconciliation is still held", async () => {
    const owner = await mountOwner(snapshot())
    expect(owner.registry.collections.messages.get(message.id)).toBeUndefined()
    let release!: (value: AccountAttentionSnapshot) => void
    apiFetchMock.mockImplementation(async (path) => {
      if (path.endsWith("/attention")) return new Promise((resolve) => { release = resolve })
      if (path === "/api/community/channels/channel/messages?limit=1") return { messages: [message] }
      throw new Error(`Unexpected content read ${path}`)
    })
    scheduleAccountAttentionReconcile(owner.client, { channelId: "channel" })
    await waitFor(() => expect(owner.registry.collections.messages.get(message.id)?.resourceComplete).toBe(true))
    await waitFor(() => expect(release).toBeTypeOf("function"))
    expect(owner.hook.result.current.isFetching).toBe(true)
    expect(apiFetchMock.mock.calls.filter(([path]) => path.includes("/seq/"))).toHaveLength(0)
    release(snapshot())
    await waitFor(() => expect(owner.hook.result.current.isFetching).toBe(false))
    owner.hook.unmount()
  })

  it("hydrates both channels when a later hint cancels an earlier account-index read", async () => {
    const owner = await mountOwner(snapshot())
    const other = { ...message, id: "other", channelId: "other-channel" }
    const reads: Array<{ signal: AbortSignal; release: (value: AccountAttentionSnapshot) => void }> = []
    apiFetchMock.mockImplementation(async (path, options) => {
      if (path.endsWith("/attention")) return new Promise((resolve) => { reads.push({ signal: options.signal, release: resolve }) })
      if (path === "/api/community/channels/channel/messages?limit=1") return { messages: [message] }
      if (path === "/api/community/channels/other-channel/messages?limit=1") return { messages: [other] }
      throw new Error(`Unexpected content read ${path}`)
    })
    scheduleAccountAttentionReconcile(owner.client, { channelId: "channel" })
    await waitFor(() => expect(reads).toHaveLength(1))
    scheduleAccountAttentionReconcile(owner.client, { channelId: other.channelId })
    await waitFor(() => expect(reads).toHaveLength(2))
    expect(reads[0].signal.aborted).toBe(true)
    reads[0].release(snapshot())
    reads[1].release(snapshot())
    await waitFor(() => {
      expect(owner.registry.collections.messages.get(message.id)?.resourceComplete).toBe(true)
      expect(owner.registry.collections.messages.get(other.id)?.resourceComplete).toBe(true)
      expect(owner.hook.result.current.isFetching).toBe(false)
    })
    expect(apiFetchMock.mock.calls.filter(([path]) => path.includes("messages?limit=1"))).toHaveLength(2)
    expect(apiFetchMock.mock.calls.every(([path]) => !path.endsWith("/read"))).toBe(true)
    owner.hook.unmount()
  })

  it.each(["missing-scope", "empty-scope"])("hydrates without depending on a potentially lagging index: %s", async (mode) => {
    const value = snapshot(0)
    if (mode === "missing-scope") value.scopes = []
    const owner = await mountOwner(value)
    scheduleAccountAttentionReconcile(owner.client, { channelId: "channel" })
    await waitFor(() => expect(owner.registry.collections.messages.get(message.id)?.resourceComplete).toBe(true))
    expect(apiFetchMock.mock.calls.every(([path]) => !path.endsWith("/read"))).toBe(true)
    owner.hook.unmount()
  })

  it.each(["no-hint", "inactive"])("does not hydrate an unrelated or retired scope: %s", async (mode) => {
    const owner = await mountOwner(snapshot())
    if (mode === "inactive") owner.runtime.lifecycle.setState((state) => ({ active: false, generation: state.generation + 1 }))
    scheduleAccountAttentionReconcile(owner.client, mode === "no-hint" ? undefined : { channelId: "channel" })
    if (mode !== "inactive") {
      await waitFor(() => expect(apiFetchMock.mock.calls.filter(([path]) => path.endsWith("/attention"))).toHaveLength(2))
      await waitFor(() => expect(owner.hook.result.current.isFetching).toBe(false))
    }
    expect(apiFetchMock.mock.calls.filter(([path]) => path.includes("/messages"))).toHaveLength(0)
    owner.hook.unmount()
  })
})
