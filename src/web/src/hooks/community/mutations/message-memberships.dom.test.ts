import "fake-indexeddb/auto"
import { createElement, type PropsWithChildren } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { dehydrate } from "@tanstack/react-query"
import { persistQueryClientRestore } from "@tanstack/react-query-persist-client"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { channelResourceFixture, fullResourceBundleFixture, messageResourceFixture } from "@/test/community-resource-fixtures"
import { captureCommunityLiveSnapshotToken, publishCommunityResourceBundle } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { clearPersistedCache, createIdbPersister, PERSIST_BUSTER, PERSIST_MAX_AGE_MS, shouldDehydrateCommunityQuery } from "@/lib/query-persister"
import { useInboxMarked } from "../use-inbox"
import { useMarkMessage, useUnmarkMessage } from "./message-memberships"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"

const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args), toastApiError: vi.fn() }))
const accounts = new Set<string>(), persisters = new Set<ReturnType<typeof createIdbPersister>>()
afterEach(async () => {
  for (const persister of persisters) persister.stopPersisting()
  persisters.clear()
  for (const account of accounts) await clearPersistedCache(account)
  accounts.clear()
  apiFetchMock.mockReset()
})

async function setup(count = 1) {
  const account = `unmark-${crypto.randomUUID()}`
  accounts.add(account)
  const owner = await createCommunityQueryOwner(account)
  const messages = Array.from({ length: count }, (_, index) => messageResourceFixture({ id: index ? `message-${index}` : "message", channelId: "dm", seq: index + 1, content: `Marked body ${index}` }))
  const resources = fullResourceBundleFixture(account, [], [channelResourceFixture({ id: "dm", type: "dm", serverId: null })], messages)
  await publishCommunityResourceBundle(owner.client, resources, { token: captureCommunityLiveSnapshotToken(owner.client) })
  const data = { marked: messages.map((message, index) => ({ id: `mark-${index}`, server: "", serverId: null, channel: "DM", channelId: "dm", m: { id: message.id } })) }
  owner.client.setQueryData(communityKeys.inboxMarked(), data)
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
  return { ...owner, account, resources, data, wrapper }
}

describe("confirmed Unmark and persisted list membership", () => {
  it.each([false, true])("withdraws prior GET empty only after a successful Mark, failed=%s", async failed => {
    const owner = await setup()
    owner.client.setQueryData(communityKeys.inboxMarked(), { marked: [] })
    let reads = 0
    apiFetchMock.mockImplementation((_path: string, options?: { method?: string }) => {
      if (options?.method === "PUT") return failed ? Promise.reject(new Error("Mark unavailable")) : Promise.resolve(undefined)
      if (reads++ === 0) return Promise.resolve({ marked: [], resources: owner.resources })
      return Promise.reject(new Error("Refresh unavailable"))
    })
    const view = renderHook(() => ({ query: useInboxMarked(true), command: useMarkMessage() }), { wrapper: owner.wrapper })
    await waitFor(() => expect(view.result.current.query.isFetching).toBe(false))
    expect(view.result.current.query.isDisplayReady).toBe(true)
    await act(async () => { await view.result.current.command.mutateAsync({ messageId: "message", channelId: "dm" }).catch(() => undefined) })
    if (failed) await act(async () => { await view.result.current.query.refetch() })
    await waitFor(() => expect(view.result.current.query.isError).toBe(true))
    expect(view.result.current.query.isDisplayReady).toBe(failed)
    expect(owner.client.getQueryData(communityKeys.inboxMarked())).toEqual(failed ? { marked: [] } : undefined)
  })

  it("cancels a pre-delete list read that starts while DELETE is in flight", async () => {
    const owner = await setup()
    let finishDelete!: () => void, finishRead!: (value: unknown) => void, readSignal: AbortSignal | undefined
    const deletion = new Promise<void>(resolve => { finishDelete = resolve })
    const read = new Promise(resolve => { finishRead = resolve })
    let reads = 0
    apiFetchMock.mockImplementation((_path: string, options?: { method?: string; signal?: AbortSignal }) => {
      if (options?.method === "DELETE") return deletion
      if (reads++ === 0) { readSignal = options?.signal; return read }
      return Promise.reject(new Error("Refresh unavailable"))
    })
    const view = renderHook(({ enabled }) => ({ query: useInboxMarked(enabled), command: useUnmarkMessage() }), { wrapper: owner.wrapper, initialProps: { enabled: false } })
    let command!: Promise<unknown>
    act(() => { command = view.result.current.command.mutateAsync({ messageId: "message" }) })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    view.rerender({ enabled: true })
    await waitFor(() => expect(readSignal).toBeDefined())
    expect(readSignal!.aborted).toBe(false)
    await act(async () => { finishDelete(); await command })
    expect(readSignal!.aborted).toBe(true)
    await act(async () => { finishRead({ ...owner.data, resources: owner.resources }); await read })
    await waitFor(() => expect(view.result.current.query.isError).toBe(true))
    expect(owner.client.getQueryData(communityKeys.inboxMarked())).toBeUndefined()
    expect(view.result.current.query.isInitialError).toBe(true)
  })

  it.each([false, true])("handles failed=%s without reviving membership through an older read", async failed => {
    const owner = await setup()
    let releaseRead!: (value: unknown) => void
    const held = new Promise(resolve => { releaseRead = resolve })
    let oldSignal: AbortSignal | undefined, reads = 0
    apiFetchMock.mockImplementation((path: string, options?: { method?: string; signal?: AbortSignal }) => {
      if (options?.method === "DELETE") return failed ? Promise.reject(new Error("Unmark unavailable")) : Promise.resolve(undefined)
      if (path === "/api/community/users/me/marks" && reads++ === 0) { oldSignal = options?.signal; return held }
      return Promise.reject(new Error("Refresh unavailable"))
    })
    const view = renderHook(() => ({ query: useInboxMarked(true), command: useUnmarkMessage() }), { wrapper: owner.wrapper })
    await waitFor(() => expect(oldSignal).toBeDefined())
    await waitFor(() => expect(view.result.current.query.marked).toHaveLength(1))
    await act(async () => { await view.result.current.command.mutateAsync({ messageId: "message" }).catch(() => undefined) })
    expect(oldSignal!.aborted).toBe(!failed)
    await act(async () => { releaseRead({ ...owner.data, resources: owner.resources }); await held })
    await waitFor(() => expect(view.result.current.query.marked).toHaveLength(failed ? 1 : 0))
    if (failed) {
      expect(owner.client.getQueryData(communityKeys.inboxMarked())).toEqual(owner.data)
      return
    }
    await waitFor(() => expect(view.result.current.query.isError).toBe(true))
    expect(view.result.current.query.isDisplayReady).toBe(false)
    expect(owner.client.getQueryData(communityKeys.inboxMarked())).toBeUndefined()
    const writer = createIdbPersister(owner.account)
    persisters.add(writer)
    await writer.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(owner.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) })
    writer.stopPersisting()
    view.unmount()
    await owner.registry.cleanup()
    owner.client.clear()
    const next = await createCommunityQueryOwner(owner.account), reader = createIdbPersister(owner.account)
    persisters.add(reader)
    await persistQueryClientRestore({ queryClient: next.client, persister: reader, buster: PERSIST_BUSTER, maxAge: PERSIST_MAX_AGE_MS })
    expect(next.client.getQueryData(communityKeys.inboxMarked())).toBeUndefined()
  })

  it("does not invent an empty window when no list has been read", async () => {
    const owner = await setup()
    owner.client.removeQueries({ queryKey: communityKeys.inboxMarked(), exact: true })
    apiFetchMock.mockResolvedValue(undefined)
    const view = renderHook(() => ({ query: useInboxMarked(false), command: useUnmarkMessage() }), { wrapper: owner.wrapper })
    await act(async () => { await view.result.current.command.mutateAsync({ messageId: "message" }) })
    expect(owner.client.getQueryData(communityKeys.inboxMarked())).toBeUndefined()
    expect(view.result.current.query.isDisplayReady).toBe(false)
  })

  it("does not claim successful empty after removing a 100-row window from 101 server marks", async () => {
    const owner = await setup(100)
    const serverMarks = new Set([...owner.data.marked.map(row => row.m.id), "outside-window"])
    apiFetchMock.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === "DELETE") { serverMarks.delete(path.split("/").at(-2)!); return Promise.resolve(undefined) }
      return Promise.reject(new Error("Refresh unavailable"))
    })
    const view = renderHook(() => ({ query: useInboxMarked(false), command: useUnmarkMessage() }), { wrapper: owner.wrapper })
    for (const row of owner.data.marked) await act(async () => { await view.result.current.command.mutateAsync({ messageId: row.m.id }) })
    expect([...serverMarks]).toEqual(["outside-window"])
    expect(owner.client.getQueryData(communityKeys.inboxMarked())).toBeUndefined()
    await act(async () => { await view.result.current.query.refetch() })
    await waitFor(() => expect(view.result.current.query.isInitialError).toBe(true))
    expect(view.result.current.query.isDisplayReady).toBe(false)
  })

  it("leaves a replacement list owner intact when an old command completes", async () => {
    const owner = await setup()
    let finish!: () => void
    apiFetchMock.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    const view = renderHook(() => useUnmarkMessage(), { wrapper: owner.wrapper })
    let pending!: Promise<unknown>
    act(() => { pending = view.result.current.mutateAsync({ messageId: "message" }) })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    owner.client.removeQueries({ queryKey: communityKeys.inboxMarked(), exact: true })
    const replacement = { marked: [{ ...owner.data.marked[0], id: "replacement" }] }
    owner.client.setQueryData(communityKeys.inboxMarked(), replacement)
    await act(async () => { finish(); await pending })
    expect(owner.client.getQueryData(communityKeys.inboxMarked())).toEqual(replacement)
  })

  it("cannot write a replacement account after its original account retires", async () => {
    const owner = await setup()
    let finish!: () => void
    apiFetchMock.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    const view = renderHook(() => useUnmarkMessage(), { wrapper: owner.wrapper })
    let command!: Promise<unknown>
    act(() => { command = view.result.current.mutateAsync({ messageId: "message" }).catch(error => error) })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    view.unmount()
    await owner.registry.cleanup()
    owner.client.clear()
    const replacement = createCommunityDbRegistry(owner.client, "replacement-account")
    await replacement.preload()
    const data = { marked: [{ ...owner.data.marked[0], id: "replacement" }] }
    owner.client.setQueryData(communityKeys.inboxMarked(), data)
    try {
      await act(async () => { finish(); expect(await command).toMatchObject({ name: "AbortError" }) })
      expect(owner.client.getQueryData(communityKeys.inboxMarked())).toEqual(data)
    } finally { await replacement.cleanup() }
  })
})
