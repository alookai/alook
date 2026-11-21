import "fake-indexeddb/auto"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { channelResourceFixture, fullResourceBundleFixture, messageReadPageFixture, messageResourceFixture, resourceBundleFixture, serverResourceFixture } from "@/test/community-resource-fixtures"
import { captureCommunityLiveSnapshotToken, ingestAttentionSnapshot, publishCommunityResourceBundle } from "@/lib/community-db/sync"
import { writeCommunityCollectionRows } from "@/lib/community-db/write"
import { messageWindowOptions } from "@/lib/community/message-window"
import { communityKeys } from "@/lib/query-keys"
import { InboxUnreadMessages } from "@/components/community/shell/inbox-unread-messages"
import { ApiError } from "@/lib/errors"
import { useInboxChannelMessages, useMarkInboxChannelRead } from "./use-inbox-channel-messages"
import { flushPendingReadIntents, getLocalReadingPosition, registerReadSurface, releaseReadSurface, submitReadIntent } from "./read-coordinator"

const mocks = vi.hoisted(() => ({ api: vi.fn(), reconcile: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => mocks.api(...args) }))
vi.mock("./community-ws/read-state-reconciliation", () => ({ reconcileAccountReadState: (...args: unknown[]) => mocks.reconcile(...args) }))
beforeEach(() => { mocks.api.mockReset(); mocks.reconcile.mockReset().mockResolvedValue(undefined) })

async function setup() {
  const account = `inbox-card-${crypto.randomUUID()}`
  const owner = await createCommunityQueryOwner(account)
  const channels = [
    channelResourceFixture({ id: "parent", creatorId: account }),
    channelResourceFixture({ id: "child", type: "thread", parentChannelId: "parent", parentMessageId: "opener", creatorId: account }),
    channelResourceFixture({ id: "sibling", creatorId: account }),
    channelResourceFixture({ id: "dm", type: "dm", serverId: null, creatorId: account }),
  ]
  await publishCommunityResourceBundle(owner.client,
    fullResourceBundleFixture(account, [serverResourceFixture({ ownerId: account })], channels),
    { token: captureCommunityLiveSnapshotToken(owner.client) })
  await writeCommunityCollectionRows(owner.registry, "readStates", channels.map(channel => ({ channelId: channel.id, lastReadMessageId: `${channel.id}-2`, lastReadAt: "2026-10-01T00:00:02.000Z", lastReadSeq: 2, observedRevision: 0 })), row => row.channelId)
  await writeCommunityCollectionRows(owner.registry, "readStateClock", [{ id: "account", revision: 0 }], row => row.id)
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
  return { ...owner, account, wrapper }
}

const row = (seq: number) => messageResourceFixture({ id: `m${seq}`, channelId: "parent", seq, authorId: "peer", createdAt: `2026-10-01T00:00:${String(seq).padStart(2, "0")}.000Z`, content: `Body ${seq}` })

const advancePreviewTime = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

async function waitForPreviewFailure(client: Awaited<ReturnType<typeof setup>>["client"], count: number) {
  await act(async () => {
    await vi.waitFor(() => expect(client.getQueryState(communityKeys.channelMessages("parent"))).toMatchObject({
      status: "error", fetchStatus: "idle", errorUpdateCount: count,
    }))
  })
  await advancePreviewTime(1)
  return client.getQueryState(communityKeys.channelMessages("parent"))!.errorUpdatedAt
}

describe("read-only Inbox channel messages", () => {
  it("projects only the unread interval and never advances any read state", async () => {
    const owner = await setup()
    mocks.api.mockResolvedValue(messageReadPageFixture({ messages: [row(1), row(3), row(4), row(6)], hasMore: false }))
    const view = renderHook(() => useInboxChannelMessages("parent", 5), { wrapper: owner.wrapper })
    await waitFor(() => expect(view.result.current.messages.map(message => message.id)).toEqual(["m3", "m4"]))
    expect(mocks.api).toHaveBeenCalledOnce()
    expect(mocks.api.mock.calls[0]![0]).toBe("/api/community/channels/parent/messages")
    expect(mocks.api.mock.calls[0]![1]?.method).toBeUndefined()
    expect(mocks.reconcile).not.toHaveBeenCalled()
    for (const channelId of ["parent", "child", "sibling", "dm"]) expect(owner.registry.collections.readStates.get(channelId)?.lastReadSeq).toBe(2)
    view.unmount()
    expect(mocks.api).toHaveBeenCalledOnce()
  })

  it.each([
    { boundary: "at history start", messages: [row(1), row(3), row(5)], hasMore: false, cursor: undefined },
    { boundary: "above older read history", messages: [row(3), row(5)], hasMore: true, cursor: `${row(3).createdAt}|m3` },
  ])("renders a complete shared conversation cache with zero requests $boundary", async ({ messages, hasMore, cursor }) => {
    const owner = await setup()
    mocks.api.mockResolvedValueOnce(messageReadPageFixture({ messages, hasMore, cursor }))
    await owner.client.infiniteQuery(messageWindowOptions(owner.client, "parent", { mode: "newest" }))
    mocks.api.mockClear()
    mocks.api.mockResolvedValueOnce(messageReadPageFixture({ messages: [row(1), row(2)], hasMore: false }))
    const view = renderHook(() => useInboxChannelMessages("parent", 5), { wrapper: owner.wrapper })
    await waitFor(() => expect(view.result.current.messages.map(message => message.id)).toEqual(["m3", "m5"]))
    await waitFor(() => expect(view.result.current.loading).toBe(false))
    expect(mocks.api).not.toHaveBeenCalled()
    expect(owner.client.getQueryCache().findAll({ queryKey: communityKeys.channelMessages("parent") }).map(query => query.queryKey))
      .toEqual([communityKeys.channelMessages("parent")])
    const edited = { ...owner.registry.collections.messages.get("m3")!, content: "Updated canonical body" }
    await act(async () => { await writeCommunityCollectionRows(owner.registry, "messages", [edited], message => message.id) })
    await waitFor(() => expect(view.result.current.messages[0]?.content).toBe("Updated canonical body"))
    expect(mocks.api).not.toHaveBeenCalled()
  })

  it("automatically fills only missing older shared pages and reuses them on reopen", async () => {
    const owner = await setup()
    const latestCursor = `${row(6).createdAt}|m6`
    const earlierCursor = `${row(4).createdAt}|m4`
    mocks.api.mockResolvedValueOnce(messageReadPageFixture({ messages: [row(6), row(7)], hasMore: true, cursor: latestCursor }))
    await owner.client.infiniteQuery(messageWindowOptions(owner.client, "parent", { mode: "newest" }))
    mocks.api.mockClear()
    let release!: (value: unknown) => void
    const held = new Promise(resolve => { release = resolve })
    mocks.api.mockReturnValueOnce(held)
      .mockResolvedValueOnce(messageReadPageFixture({ messages: [row(2), row(3)], hasMore: true, cursor: `${row(2).createdAt}|m2` }))
    const view = renderHook(() => useInboxChannelMessages("parent", 7), { wrapper: owner.wrapper })
    await waitFor(() => expect(view.result.current.messages.map(message => message.id)).toEqual(["m6", "m7"]))
    expect(view.result.current.loading).toBe(true)
    await act(async () => { release(messageReadPageFixture({ messages: [row(4), row(5)], hasMore: true, cursor: earlierCursor })); await held })
    const complete = ["m3", "m4", "m5", "m6", "m7"]
    await waitFor(() => expect(view.result.current.messages.map(message => message.id)).toEqual(complete))
    expect(view.result.current.loading).toBe(false)
    expect(mocks.api.mock.calls.map(([path]) => path)).toEqual([
      `/api/community/channels/parent/messages?cursor=${encodeURIComponent(latestCursor)}`,
      `/api/community/channels/parent/messages?cursor=${encodeURIComponent(earlierCursor)}`,
    ])
    expect(mocks.api.mock.calls.every(([, options]) => !options?.method)).toBe(true)
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(owner.registry.collections.readStates.get("parent")?.lastReadSeq).toBe(2)
    view.unmount()
    const reopened = renderHook(() => useInboxChannelMessages("parent", 7), { wrapper: owner.wrapper })
    await waitFor(() => expect(reopened.result.current.messages.map(message => message.id)).toEqual(complete))
    expect(mocks.api).toHaveBeenCalledTimes(2)
  })

  it("fills a stale shared tail using its newest cursor", async () => {
    const owner = await setup()
    mocks.api.mockResolvedValueOnce(messageReadPageFixture({ messages: [row(2), row(3), row(4)], hasMore: false }))
    await owner.client.infiniteQuery(messageWindowOptions(owner.client, "parent", { mode: "newest" }))
    mocks.api.mockClear()
    mocks.api.mockResolvedValueOnce(messageReadPageFixture({ messages: [row(6)], hasMoreNewer: false }))
    const view = renderHook(() => useInboxChannelMessages("parent", 6), { wrapper: owner.wrapper })
    await waitFor(() => expect(view.result.current.messages.map(message => message.id)).toEqual(["m3", "m4", "m6"]))
    expect(view.result.current.loading).toBe(false)
    expect(mocks.api.mock.calls.map(([path]) => path)).toEqual([
      `/api/community/channels/parent/messages?since=${encodeURIComponent(`${row(4).createdAt}|m4`)}`,
    ])
    expect(owner.registry.collections.readStates.get("parent")?.lastReadSeq).toBe(2)
  })

  it("retries the failed older cursor in the background and keeps cached messages", async () => {
    const owner = await setup()
    const cursor = `${row(4).createdAt}|m4`
    mocks.api.mockResolvedValueOnce(messageReadPageFixture({ messages: [row(4), row(5)], hasMore: true, cursor }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(messageReadPageFixture({ messages: [row(3)], hasMore: false }))
    vi.useFakeTimers()
    try {
      const view = renderHook(() => useInboxChannelMessages("parent", 5), { wrapper: owner.wrapper })
      await waitForPreviewFailure(owner.client, 1)
      expect(view.result.current.messages.map(message => message.id)).toEqual(["m4", "m5"])
      await advancePreviewTime(5_000)
      await act(async () => { await vi.waitFor(() => expect(owner.registry.collections.messages.has("m3")).toBe(true)) })
      await advancePreviewTime(1)
      expect(view.result.current.messages.map(message => message.id)).toEqual(["m3", "m4", "m5"])
      const earlier = `/api/community/channels/parent/messages?cursor=${encodeURIComponent(cursor)}`
      expect(mocks.api.mock.calls.map(([path]) => path)).toEqual(["/api/community/channels/parent/messages", earlier, earlier])
      expect(mocks.reconcile).not.toHaveBeenCalled()
      expect(owner.registry.collections.readStates.get("parent")?.lastReadSeq).toBe(2)
    } finally { vi.useRealTimers() }
  })

  it.each(["during expansion", "before expansion"])("silently recovers a first read failure %s", async stage => {
    const owner = await setup()
    mocks.api.mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(messageReadPageFixture({ messages: [row(3)], hasMore: false }))
    if (stage === "before expansion") {
      await expect(owner.client.infiniteQuery(messageWindowOptions(owner.client, "parent", { mode: "newest" }))).rejects.toThrow("offline")
    }
    vi.useFakeTimers()
    try {
      const view = render(createElement(InboxUnreadMessages, { channelId: "parent", throughSeq: 3, mentions: [] }), { wrapper: owner.wrapper })
      await waitForPreviewFailure(owner.client, 1)
      expect(mocks.api).toHaveBeenCalledOnce()
      expect(view.queryByRole("alert")).toBeNull()
      expect(view.queryByRole("button", { name: "Retry" })).toBeNull()
      expect(view.queryByText("No unread messages")).toBeNull()
      await advancePreviewTime(5_000)
      await act(async () => { await vi.waitFor(() => expect(owner.registry.collections.messages.has("m3")).toBe(true)) })
      await advancePreviewTime(1)
      expect(view.getByText("Body 3")).toBeVisible()
      expect(mocks.api.mock.calls.map(([path]) => path)).toEqual(["/api/community/channels/parent/messages", "/api/community/channels/parent/messages"])
      expect(mocks.reconcile).not.toHaveBeenCalled()
      expect(owner.registry.collections.readStates.get("parent")?.lastReadSeq).toBe(2)
    } finally { vi.useRealTimers() }
  })

  it("backs off and stops when an expanded preview repeatedly fails", async () => {
    const owner = await setup()
    mocks.api.mockRejectedValue(new Error("offline"))
    vi.useFakeTimers()
    try {
      const view = renderHook(({ throughSeq }) => useInboxChannelMessages("parent", throughSeq), {
        wrapper: owner.wrapper, initialProps: { throughSeq: 3 },
      })
      const firstFailureAt = await waitForPreviewFailure(owner.client, 1)
      await advancePreviewTime(2_000)
      view.rerender({ throughSeq: 4 })
      await advancePreviewTime(firstFailureAt + 4_999 - Date.now())
      expect(mocks.api).toHaveBeenCalledOnce()
      await advancePreviewTime(1)
      const secondFailureAt = await waitForPreviewFailure(owner.client, 2)
      await advancePreviewTime(secondFailureAt + 14_999 - Date.now())
      expect(mocks.api).toHaveBeenCalledTimes(2)
      await advancePreviewTime(1)
      await waitForPreviewFailure(owner.client, 3)
      await advancePreviewTime(60_000)
      expect(mocks.api).toHaveBeenCalledTimes(3)
    } finally { vi.useRealTimers() }
  })

  it.each(["after collapse", "after access changes", "on an access error"])("does not retry a failed preview %s", async reason => {
    const owner = await setup()
    mocks.api.mockRejectedValue(reason === "on an access error" ? new ApiError("denied", 403) : new Error("offline"))
    vi.useFakeTimers()
    try {
      const view = renderHook(() => useInboxChannelMessages("parent", 3), { wrapper: owner.wrapper })
      await waitForPreviewFailure(owner.client, 1)
      if (reason === "after collapse") view.unmount()
      if (reason === "after access changes") act(() => owner.runtime.ws.actions.revokeChannelAccess("s1", "parent"))
      await advancePreviewTime(60_000)
      expect(mocks.api).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it.each(["access", "account"])("withdraws a loaded preview immediately when its %s owner changes", async change => {
    const owner = await setup()
    mocks.api.mockResolvedValue(messageReadPageFixture({ messages: [row(3)], hasMore: false }))
    const view = renderHook(() => useInboxChannelMessages("parent", 3), { wrapper: owner.wrapper })
    await waitFor(() => expect(view.result.current.messages.map(message => message.id)).toEqual(["m3"]))
    act(() => {
      if (change === "access") owner.runtime.ws.actions.revokeChannelAccess("s1", "parent")
      else owner.runtime.ws.actions.activateProfileAccount("other")
    })
    await waitFor(() => expect(view.result.current.messages).toEqual([]))
    expect(view.result.current.accessAllowed).toBe(false)
    expect(mocks.api).toHaveBeenCalledOnce()
  })

  it.each(["access", "account"])("rejects a held preview after its %s owner changes", async change => {
    const owner = await setup()
    let release!: (value: unknown) => void
    const held = new Promise(resolve => { release = resolve })
    mocks.api.mockReturnValueOnce(held)
    const view = renderHook(() => useInboxChannelMessages("parent", 3), { wrapper: owner.wrapper })
    await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce())
    act(() => {
      if (change === "access") owner.runtime.ws.actions.revokeChannelAccess("s1", "parent")
      else owner.runtime.ws.actions.activateProfileAccount("other")
    })
    await act(async () => { release(messageReadPageFixture({ messages: [row(3)], hasMore: false })); await held })
    await waitFor(() => expect(owner.client.getQueryState(communityKeys.channelMessages("parent"))?.fetchStatus).not.toBe("fetching"))
    expect(view.result.current.messages).toEqual([])
    expect(owner.registry.collections.messages.get("m3")).toBeUndefined()
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

})

describe("exact Inbox channel check", () => {
  it("clears before target lookup and rolls a failed write back over a newer snapshot", async () => {
    const owner = await setup()
    const scope = {
      scopeId: "parent", channelId: "parent", serverId: "s1", parentChannelId: null,
      ordinaryUnread: true, lastUnreadSeq: 23, unreadCount: 2, attentionCount: 0,
    }
    const sibling = { ...scope, scopeId: "sibling", channelId: "sibling" }
    await writeCommunityCollectionRows(owner.registry, "attentionScopes", [scope, sibling], row => row.scopeId)
    let resolveTarget!: (value: { id: string }) => void
    const target = new Promise<{ id: string }>(resolve => { resolveTarget = resolve })
    mocks.api.mockReturnValueOnce(target).mockRejectedValueOnce(new Error("Read unavailable"))
    const view = renderHook(() => useMarkInboxChannelRead(), { wrapper: owner.wrapper })
    let result!: Promise<unknown>
    act(() => {
      result = view.result.current.mutateAsync({ channelId: "parent", throughSeq: 23 }).catch(error => error)
    })
    try {
      await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce())
      expect(owner.registry.collections.attentionScopes.get("parent")).toBeUndefined()
      expect(owner.registry.collections.attentionScopes.get("sibling")).toMatchObject(sibling)
      expect(view.result.current.actions.get("parent")).toEqual({ throughSeq: 23, status: "pending" })
      const newer = { ...scope, lastUnreadSeq: 24, unreadCount: 3 }
      await act(async () => {
        ingestAttentionSnapshot(owner.registry, {
          resources: resourceBundleFixture({ viewerId: owner.account }),
          included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
          scopes: [newer, sibling], items: [], limit: 100, truncated: false,
        })
      })
      expect(owner.registry.collections.attentionScopes.get("parent")?.lastUnreadSeq).toBe(24)
      await act(async () => {
        resolveTarget({ id: "captured-23" })
        expect(await result).toMatchObject({ message: "Read unavailable" })
      })
      expect(owner.registry.collections.attentionScopes.get("parent")).toMatchObject(newer)
      await waitFor(() => expect(view.result.current.actions.get("parent")).toEqual({ throughSeq: 23, status: "error" }))
      expect(mocks.reconcile).not.toHaveBeenCalled()
    } finally {
      resolveTarget({ id: "captured-23" })
      await result
    }
  })

  it.each(["parent", "child", "dm"])("reads only %s at the captured boundary", async channelId => {
    const owner = await setup()
    mocks.api.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === `/api/community/channels/${channelId}/messages/seq/23`) return { id: "captured-23" }
      if (path === `/api/community/channels/${channelId}/read` && options?.method === "PUT") return { changed: true, targetSeq: 23, revision: 4 }
      throw new Error(`Unexpected request ${path}`)
    })
    const view = renderHook(() => useMarkInboxChannelRead(), { wrapper: owner.wrapper })
    await act(async () => { await view.result.current.mutateAsync({ channelId, throughSeq: 23 }) })
    expect(mocks.api.mock.calls.map(([path]) => path)).toEqual([`/api/community/channels/${channelId}/messages/seq/23`, `/api/community/channels/${channelId}/read`])
    expect(mocks.api.mock.calls[1]![1]).toMatchObject({ method: "PUT", body: JSON.stringify({ lastReadMessageId: "captured-23" }), authenticationAccount: owner.account })
    expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(owner.client, { targetRevision: 4 })
  })

  it.each([
    { receiptChannel: "child", targetSeq: 23, error: null },
    { receiptChannel: "sibling", targetSeq: 23, error: {
      name: "CommunityResourceError", status: 200, cause: { message: "Community read resource scope mismatch" },
    } },
    { receiptChannel: "child", targetSeq: 24, error: { message: "Unread receipt mismatch" } },
  ])("uses the real client for $receiptChannel sequence $targetSeq", async ({ receiptChannel, targetSeq, error }) => {
    const owner = await setup()
    const { apiFetch } = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client")
    mocks.api.mockImplementation(apiFetch)
    const headers = { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) }
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ id: "captured-23" }, { headers }))
      .mockResolvedValueOnce(Response.json({
        contractVersion: BUSINESS_SCHEMA_VERSION, channelId: receiptChannel, changed: true, targetSeq, revision: 4,
      }, { headers }))
    try {
      const view = renderHook(() => useMarkInboxChannelRead(), { wrapper: owner.wrapper })
      await act(async () => {
        const result = view.result.current.mutateAsync({ channelId: "child", throughSeq: 23 })
        if (error) await expect(result).rejects.toMatchObject(error)
        else await expect(result).resolves.toEqual({ changed: true, targetSeq: 23, revision: 4 })
      })
      expect(fetch.mock.calls.map(([url]) => new URL(String(url), window.location.origin).pathname)).toEqual([
        "/api/community/channels/child/messages/seq/23", "/api/community/channels/child/read",
      ])
      expect(fetch.mock.calls[1]![1]).toMatchObject({ method: "PUT", body: JSON.stringify({ lastReadMessageId: "captured-23" }) })
      if (error) expect(mocks.reconcile).not.toHaveBeenCalled()
      else expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(owner.client, { targetRevision: 4 })
    } finally {
      fetch.mockRestore()
    }
  })

  it("waits for the same channel's timeline transport and sends the captured boundary", async () => {
    const owner = await setup()
    const lease = registerReadSurface(owner.client, owner.account, { kind: "timeline", channelId: "parent" })
    let finishTimeline!: (receipt: { changed: boolean; targetSeq: number; revision: number }) => void
    const held = new Promise<{ changed: boolean; targetSeq: number; revision: number }>(resolve => { finishTimeline = resolve })
    const timelineReceipt = { changed: true, targetSeq: 24, revision: 4 }
    const sentIds: string[] = []
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/api/community/channels/parent/messages/seq/23") return Promise.resolve({ id: "captured-23" })
      if (path !== "/api/community/channels/parent/read" || options?.method !== "PUT") throw new Error(`Unexpected request ${path}`)
      const id = JSON.parse(String(options.body)).lastReadMessageId as string
      sentIds.push(id)
      if (id === "timeline-24") return held
      if (id === "captured-23") return Promise.resolve({ changed: false, targetSeq: 23, revision: 4 })
      throw new Error(`Unexpected read id ${id}`)
    })
    try {
      expect(submitReadIntent(lease, { kind: "timeline", channelId: "parent", messageId: "timeline-24", seq: 24 })).toBe(true)
      const timeline = flushPendingReadIntents(owner.client)
      await waitFor(() => expect(sentIds).toEqual(["timeline-24"]))
      const view = renderHook(() => useMarkInboxChannelRead(), { wrapper: owner.wrapper })
      let inbox!: Promise<unknown>
      act(() => { inbox = view.result.current.mutateAsync({ channelId: "parent", throughSeq: 23 }) })
      await waitFor(() => expect(owner.client.getMutationCache().getAll().some(mutation =>
        mutation.options.meta?.observabilityDelegate && mutation.state.isPaused)).toBe(true))
      expect(sentIds).toEqual(["timeline-24"])
      await act(async () => {
        finishTimeline(timelineReceipt)
        await expect(timeline).resolves.toMatchObject({ consumed: true })
        await expect(inbox).resolves.toEqual({ changed: false, targetSeq: 23, revision: 4 })
      })
      expect(sentIds).toEqual(["timeline-24", "captured-23"])
      expect(getLocalReadingPosition(owner.client, "parent")).toMatchObject({ messageId: "timeline-24", seq: 24 })
    } finally {
      finishTimeline(timelineReceipt)
      releaseReadSurface(lease)
    }
  })

  it.each(["access", "account"])("rejects a delayed target after the original %s changes", async change => {
    const owner = await setup()
    let release!: (value: { id: string }) => void
    const held = new Promise<{ id: string }>(resolve => { release = resolve })
    mocks.api.mockReturnValueOnce(held)
    const view = renderHook(() => useMarkInboxChannelRead(), { wrapper: owner.wrapper })
    let pending!: Promise<unknown>
    act(() => { pending = view.result.current.mutateAsync({ channelId: "child", throughSeq: 23 }).catch(error => error) })
    await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce())
    act(() => {
      if (change === "access") owner.runtime.ws.actions.revokeChannelAccess("s1", "child")
      else owner.runtime.ws.actions.activateProfileAccount("other")
    })
    let error!: unknown
    await act(async () => { release({ id: "captured-23" }); error = await pending })
    expect(error).toMatchObject({ name: "AbortError" })
    expect(mocks.api).toHaveBeenCalledOnce()
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })
})
