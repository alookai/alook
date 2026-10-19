import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture as fixture } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { ingestMessages, ingestReadStateSnapshot } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import type { MessageWindowData } from "@/lib/community/message-window"
import { ConversationReadTimeoutError } from "@/lib/community/conversation-read"
import { useMessages } from "./use-messages"
import { reconcileFocusedMessageQueries } from "./community-ws/reconnect-messages"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => load(...args) }))
beforeEach(() => { load.mockReset() })
afterEach(() => { vi.restoreAllMocks() })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function setup() {
  const owner = await createCommunityQueryOwner()
  const wrapper = ({ children }: React.PropsWithChildren) => <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}>{children}</CommunityDbProvider></QueryClientProvider>
  return { ...owner, wrapper }
}

async function holdSelectedWindowRepair() {
  const owner = await setup()
  const old = fixture()
  old.selection = { reason: "tail", anchorMessageId: null }
  old.readState = { channelId: "c1", lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 }
  old.readStateRevision = 0
  load.mockResolvedValueOnce(old)
  const useSurface = () => useMessages("c1", { serverId: "s1", viewerUserId: "viewer" })
  const first = renderHook(useSurface, { wrapper: owner.wrapper })
  await waitFor(() => expect(first.result.current.initialPositionKnown).toBe(true))
  first.unmount()
  await act(async () => ingestReadStateSnapshot(owner.registry, { revision: 1, readStates: [{
    channelId: "c1", lastReadMessageId: "m1", lastReadAt: old.messages[0].createdAt, lastReadSeq: 1,
  }] }))
  const fresh = fixture()
  fresh.readStateRevision = 1
  fresh.messages.push({ ...fresh.messages[0], id: "m2", seq: 2, createdAt: "2026-10-01T00:00:02.000Z" })
  fresh.page.latestSeq = 2
  const late = deferred<{ messages: typeof fresh.messages; latestSeq: number; hasMoreNewer: boolean }>()
  load.mockImplementation((url: string) => new URL(url, "https://example.test").searchParams.has("entry")
    ? Promise.resolve(fresh) : late.promise)
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000)
  const hook = renderHook(useSurface, { wrapper: owner.wrapper })
  await waitFor(() => expect(load.mock.calls.some(([url]) => url === "/api/community/channels/c1/messages")).toBe(true))
  const call = load.mock.calls.find(([url]) => url === "/api/community/channels/c1/messages")!
  expect(hook.result.current.messages.map(message => message.id)).toEqual(["m1"])
  expect(hook.result.current.readSnapshot?.lastReadSeq).toBe(1)
  return { ...owner, hook, late, signal: call[1].signal as AbortSignal,
    key: communityKeys.channelMessagesWindow("c1", { mode: "newest" }), fresh }
}

describe("returned entry and selected message window", () => {
  it.each(["different-key newest", "same-key anchor"] as const)("publishes the new entry into the actual feed after %s return", async kind => {
    const { wrapper, client, registry } = await setup()
    const old = fixture()
    old.readStateRevision = 1
    old.page.hasMoreOlder = false
    old.page.olderCursor = null
    if (kind === "different-key newest") {
      old.readState = { channelId: "c1", lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 }
      old.readStateRevision = 0
      old.selection = { reason: "tail", anchorMessageId: null }
    }
    load.mockResolvedValueOnce(old)
    const useSurface = () => useMessages("c1", { serverId: "s1", viewerUserId: "viewer" })
    const first = renderHook(useSurface, { wrapper })
    await waitFor(() => expect(first.result.current.initialPositionKnown).toBe(true))
    expect(first.result.current.messages.map(message => message.id)).toEqual(["m1"])
    first.unmount()
    await act(async () => ingestReadStateSnapshot(registry, { revision: 1, readStates: [{
      channelId: "c1", lastReadMessageId: "m1", lastReadAt: old.messages[0].createdAt, lastReadSeq: 1,
    }] }))

    const fresh = fixture()
    fresh.readStateRevision = 1
    fresh.messages = Array.from({ length: 13 }, (_, index) => ({
      ...fresh.messages[0], id: `m${index + 1}`, seq: index + 1,
      content: `Mention ${index + 1}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString(),
    }))
    fresh.channel.messageCount = 13
    fresh.channel.lastMessageAt = fresh.messages.at(-1)!.createdAt
    fresh.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 13 }
    await act(async () => ingestMessages(registry, "c1", fresh.messages.map(message => ({ ...message, resourceComplete: true }))))
    expect(fresh.messages.every(message => registry.collections.messages.get(message.id)?.resourceComplete === true)).toBe(true)
    const response = deferred<ReturnType<typeof fixture>>()
    load.mockImplementation((url: string) => {
      const search = new URL(url, "https://example.test").searchParams
      if (search.has("entry")) return response.promise
      if (search.has("since")) return Promise.resolve({ ...fresh.page, messages: fresh.messages.slice(1) })
      if (search.size === 0) return Promise.resolve({ ...fresh.page, messages: fresh.messages })
      throw new Error(`Unexpected message window ${url}`)
    })
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000)
    const returned = renderHook(useSurface, { wrapper })
    try {
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
      const oldParam = kind === "different-key newest" ? { mode: "newest" } : { mode: "anchor", anchor: "m1" }
      expect(returned.result.current.data?.pageParams[0]).toEqual(oldParam)
      expect(returned.result.current.messages.map(message => message.id)).toEqual(["m1"])
      expect(returned.result.current.readSnapshot?.lastReadSeq).toBe(1)
      await act(async () => response.resolve(fresh))
      await waitFor(() => expect(returned.result.current.isFetching).toBe(false))
      const expectedIds = fresh.messages.map(message => message.id)
      const anchorKey = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m1" })
      expect(client.getQueryData<MessageWindowData>(anchorKey)?.pages.flatMap(page => page.messages.map(message => message.id))).toEqual(expectedIds)
      expect(expectedIds.every(id => registry.collections.messages.get(id)?.resourceComplete === true)).toBe(true)
      expect(returned.result.current.readSnapshot?.lastReadMessageId).toBe("m1")
      expect(returned.result.current.readSnapshot?.lastReadSeq).toBe(1)
      expect(returned.result.current.initialPositionKnown).toBe(true)
      await waitFor(() => expect(returned.result.current.messages.map(message => message.id)).toEqual(expectedIds))
      expect(returned.result.current.latestSeq).toBe(13)
      expect(returned.result.current.data?.pageParams[0]).toEqual(oldParam)
      expect(load.mock.calls.filter(([url]) => url === "/api/community/channels/c1/messages")).toHaveLength(kind === "different-key newest" ? 1 : 0)
      const capturedSnapshot = returned.result.current.readSnapshot
      await act(async () => ingestReadStateSnapshot(registry, { revision: 2, readStates: [{
        channelId: "c1", lastReadMessageId: "m13", lastReadAt: fresh.messages.at(-1)!.createdAt, lastReadSeq: 13,
      }] }))
      expect(returned.result.current.readSnapshot).toBe(capturedSnapshot)
      expect(returned.result.current.readSnapshot?.lastReadSeq).toBe(1)
    } finally {
      returned.unmount()
    }
  })

  it("keeps the new landing tail when an older selected-window reconcile completes last", async () => {
    const { wrapper, client, registry } = await setup()
    const old = fixture()
    old.selection = { reason: "tail", anchorMessageId: null }
    old.readState = { channelId: "c1", lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 }
    old.readStateRevision = 0
    load.mockResolvedValueOnce(old)
    const useSurface = () => useMessages("c1", { serverId: "s1", viewerUserId: "viewer" })
    const first = renderHook(useSurface, { wrapper })
    await waitFor(() => expect(first.result.current.initialPositionKnown).toBe(true))
    first.unmount()
    await act(async () => ingestReadStateSnapshot(registry, { revision: 1, readStates: [{
      channelId: "c1", lastReadMessageId: "m1", lastReadAt: old.messages[0].createdAt, lastReadSeq: 1,
    }] }))
    const fresh = fixture()
    fresh.readStateRevision = 1
    fresh.messages = Array.from({ length: 13 }, (_, index) => ({
      ...fresh.messages[0], id: `m${index + 1}`, seq: index + 1,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString(),
    }))
    fresh.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 13 }
    const entry = deferred<ReturnType<typeof fixture>>()
    const oldWindow = deferred<{ messages: typeof old.messages; latestSeq: number; hasMoreNewer: boolean }>()
    load.mockImplementation((url: string) => {
      const search = new URL(url, "https://example.test").searchParams
      if (search.has("entry")) return entry.promise
      if (search.has("since")) return Promise.resolve({ ...fresh.page, messages: fresh.messages.slice(1) })
      if (search.size === 0) return oldWindow.promise
      throw new Error(`Unexpected message window ${url}`)
    })
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000)
    const returned = renderHook(useSurface, { wrapper })
    try {
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
      const key = communityKeys.channelMessagesWindow("c1", { mode: "newest" })
      const owner = client.getQueryCache().find({ queryKey: key, exact: true })
      const snapshot = returned.result.current.readSnapshot
      let olderRepair!: Promise<void>
      await act(async () => {
        olderRepair = reconcileFocusedMessageQueries(client, "channel", "c1", "s1")
        await Promise.resolve()
      })
      await waitFor(() => expect(load.mock.calls.filter(([url]) => url === "/api/community/channels/c1/messages")).toHaveLength(1))
      await act(async () => entry.resolve(fresh))
      await waitFor(() => expect(returned.result.current.isFetching).toBe(false))
      const anchorKey = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m1" })
      expect(client.getQueryData<MessageWindowData>(anchorKey)?.pages[0].messages).toHaveLength(13)
      await act(async () => {
        oldWindow.resolve({ messages: old.messages, latestSeq: 1, hasMoreNewer: false })
        await olderRepair
      })
      expect(client.getQueryCache().find({ queryKey: key, exact: true })).toBe(owner)
      expect(returned.result.current.readSnapshot).toBe(snapshot)
      expect(returned.result.current.readSnapshot?.lastReadSeq).toBe(1)
      expect(returned.result.current.data?.pageParams[0]).toEqual({ mode: "newest" })
      await waitFor(() => expect(returned.result.current.messages.map(message => message.id)).toEqual(fresh.messages.map(message => message.id)))
      expect(returned.result.current.latestSeq).toBe(13)
    } finally {
      returned.unmount()
    }
  })

  it.each(["account", "access", "unmount"] as const)("drops a held selected-window repair after %s retirement", async kind => {
    const { hook, runtime, client, registry, late, signal, key, fresh } = await holdSelectedWindowRepair()
    await act(async () => {
      if (kind === "account") runtime.ws.actions.activateProfileAccount("other-viewer")
      else if (kind === "access") runtime.ws.actions.revokeChannelAccess("s1", "c1")
      else hook.unmount()
    })
    expect(signal.aborted).toBe(true)
    const lateMessage = { ...fresh.messages[0], id: "late_m3", seq: 3 }
    await act(async () => late.resolve({ messages: [...fresh.messages, lateMessage], latestSeq: 3, hasMoreNewer: false }))
    expect(registry.collections.messages.get("late_m3")).toBeUndefined()
    expect(client.getQueryData<MessageWindowData>(key)?.pages.flatMap(page => page.messages.map(message => message.id)) ?? []).not.toContain("late_m3")
    if (kind !== "unmount") hook.unmount()
  })

  it("retains its readable selected window and snapshot after a repair timeout", async () => {
    const { hook, client, late, key } = await holdSelectedWindowRepair()
    await act(async () => late.reject(new ConversationReadTimeoutError()))
    await waitFor(() => expect(client.getQueryState([...key, "reconcile"])?.status).toBe("error"))
    expect(hook.result.current.messages.map(message => message.id)).toEqual(["m1"])
    expect(hook.result.current.readSnapshot?.lastReadSeq).toBe(1)
    expect(hook.result.current.initialPositionKnown).toBe(true)
    expect(hook.result.current.initialLoadError).toBeNull()
    expect(load.mock.calls.filter(([url]) => url === "/api/community/channels/c1/messages")).toHaveLength(1)
    hook.unmount()
  })
})
