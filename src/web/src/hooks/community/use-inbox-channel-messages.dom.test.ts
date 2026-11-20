import "fake-indexeddb/auto"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { channelResourceFixture, fullResourceBundleFixture, messageReadPageFixture, messageResourceFixture, serverResourceFixture } from "@/test/community-resource-fixtures"
import { captureCommunityLiveSnapshotToken, publishCommunityResourceBundle } from "@/lib/community-db/sync"
import { writeCommunityCollectionRows } from "@/lib/community-db/write"
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

  it("uses the original older cursor and stops exposing pagination at the read boundary", async () => {
    const owner = await setup()
    mocks.api.mockResolvedValueOnce(messageReadPageFixture({ messages: [row(4), row(5)], hasMore: true, cursor: `${row(4).createdAt}|m4` }))
      .mockResolvedValueOnce(messageReadPageFixture({ messages: [row(1), row(3)], hasMore: false }))
    const view = renderHook(() => useInboxChannelMessages("parent", 5), { wrapper: owner.wrapper })
    await waitFor(() => expect(view.result.current.hasEarlierUnread).toBe(true))
    await act(async () => { await view.result.current.fetchNextPage() })
    await waitFor(() => expect(view.result.current.messages.map(message => message.id)).toEqual(["m3", "m4", "m5"]))
    expect(view.result.current.hasEarlierUnread).toBe(false)
    expect(mocks.api.mock.calls[1]![0]).toBe(`/api/community/channels/parent/messages?cursor=${encodeURIComponent(`${row(4).createdAt}|m4`)}`)
    expect(mocks.api.mock.calls.every(([, options]) => !options?.method)).toBe(true)
    expect(owner.registry.collections.readStates.get("parent")?.lastReadSeq).toBe(2)
  })

  it("retries a failed preview through the read-only message door", async () => {
    const owner = await setup()
    mocks.api.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(messageReadPageFixture({ messages: [row(3)], hasMore: false }))
    const view = renderHook(() => useInboxChannelMessages("parent", 3), { wrapper: owner.wrapper })
    await waitFor(() => expect(view.result.current.isError).toBe(true))
    await act(async () => { await view.result.current.refetch() })
    await waitFor(() => expect(view.result.current.messages.map(message => message.id)).toEqual(["m3"]))
    expect(mocks.api.mock.calls.map(([path]) => path)).toEqual(["/api/community/channels/parent/messages", "/api/community/channels/parent/messages"])
    expect(mocks.reconcile).not.toHaveBeenCalled()
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
    await waitFor(() => expect(view.result.current.isFetching).toBe(false))
    expect(view.result.current.messages).toEqual([])
    expect(owner.registry.collections.messages.get("m3")).toBeUndefined()
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

})

describe("exact Inbox channel check", () => {
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
