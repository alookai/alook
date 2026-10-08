import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { communityKeys } from "@/lib/query-keys"
import { ingestReadStateSnapshot } from "@/lib/community-db/sync"
import { useDmReadStateSnapshot } from "./use-dm-read-state"
import type { ChannelReadStateSnapshot } from "./use-channel-read-state"

const api = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => api(...args) }))
let client: QueryClient, registry: CommunityDbRegistry
const original = { lastReadMessageId: "m_original", lastReadAt: "2026-07-01T00:00:00.000Z", lastReadSeq: 10 }
const fresh = { lastReadMessageId: "m_fresh", lastReadAt: "2026-07-02T00:00:00.000Z", lastReadSeq: 20 }
const empty = { lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 }
beforeEach(async () => {
  api.mockReset()
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } })
  registry = createCommunityDbRegistry(client, "viewer")
  await registry.preload()
})
afterEach(async () => {
  await act(async () => {
    await client.cancelQueries(); await registry.cleanup(); client.clear()
  })
})
function Owner({ children }: PropsWithChildren) { return createElement(QueryClientProvider, { client }, createElement(CommunityDbProvider, { registry }, children)) }
function mount(id = "dm_1") {
  return renderHook(({ id }) => useDmReadStateSnapshot(id), { wrapper: Owner, initialProps: { id } })
}
function held() {
  let resolve!: (value: ChannelReadStateSnapshot) => void
  api.mockReturnValueOnce(new Promise<ChannelReadStateSnapshot>((done) => { resolve = done }))
  return { resolve }
}

describe("native DM read-state snapshot", () => {
  it("returns null before the query resolves", async () => {
    const pending = held(), rendered = mount()
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    expect(rendered.result.current).toMatchObject({ snapshot: null, isFetching: true })
    await act(async () => { pending.resolve(original) })
  })
  it("returns the resolved value on first success", async () => {
    api.mockResolvedValueOnce(original)
    const rendered = mount()
    await waitFor(() => expect(rendered.result.current).toMatchObject({ snapshot: original, isFetching: false }))
  })
  it("withholds retained cache data until the mount refetch settles", async () => {
    client.setQueryData(communityKeys.dmReadStateSnapshot("dm_1"), original)
    const pending = held(), rendered = mount()
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    expect(rendered.result.current.snapshot).toBeNull()
    await act(async () => { pending.resolve(fresh) })
    await waitFor(() => expect(rendered.result.current.snapshot).toEqual(fresh))
  })
  it("withholds a stale canonical pointer until the current mount read succeeds", async () => {
    ingestReadStateSnapshot(registry, { revision: 1, readStates: [{ channelId: "dm_1", ...empty }] })
    const pending = held(), rendered = mount("dm_1")
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    expect(rendered.result.current).toMatchObject({ snapshot: null, isFetching: true })
    await act(async () => { pending.resolve(fresh) })
    await waitFor(() => expect(rendered.result.current.snapshot).toEqual(fresh))
    await act(async () => { ingestReadStateSnapshot(registry, { revision: 2, readStates: [{ channelId: "dm_1", ...original }] }) })
    rendered.rerender({ id: "dm_1" })
    expect(rendered.result.current.snapshot).toEqual(fresh)
  })
  it("does not latch retained query data when the new mount read fails", async () => {
    client.setQueryData(communityKeys.dmReadStateSnapshot("dm_1"), original)
    api.mockRejectedValue(new Error("fresh mount unavailable"))
    const rendered = mount()
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(rendered.result.current.isFetching).toBe(false))
    expect(rendered.result.current.error).toBeInstanceOf(Error)
    expect(rendered.result.current.snapshot).toBeNull()
    api.mockResolvedValueOnce(fresh)
    act(() => rendered.result.current.retry())
    await waitFor(() => expect(rendered.result.current.snapshot).toEqual(fresh))
  })
  it("keeps the first settled snapshot through a later refetch", async () => {
    api.mockResolvedValueOnce(original)
    const rendered = mount()
    await waitFor(() => expect(rendered.result.current.snapshot).toEqual(original))
    api.mockResolvedValueOnce(fresh)
    await act(async () => { await client.refetchQueries({ queryKey: communityKeys.dmReadStateSnapshot("dm_1"), exact: true }) })
    expect(client.getQueryData(communityKeys.dmReadStateSnapshot("dm_1"))).toEqual(fresh)
    expect(rendered.result.current.snapshot).toEqual(original)
  })
  it("rebuilds the latch on a same-mount DM switch", async () => {
    api.mockResolvedValueOnce(original)
    const rendered = mount()
    await waitFor(() => expect(rendered.result.current.snapshot).toEqual(original))
    const pending = held()
    rendered.rerender({ id: "dm_2" })
    expect(rendered.result.current.snapshot).toBeNull()
    await act(async () => { pending.resolve(fresh) })
    await waitFor(() => expect(rendered.result.current.snapshot).toEqual(fresh))
  })
  it("runs exactly one client retry and leaves exhausted reads unlatchable", async () => {
    api.mockRejectedValue(new Error("offline"))
    const rendered = mount()
    await waitFor(() => expect(client.getQueryState(communityKeys.dmReadStateSnapshot("dm_1"))?.fetchStatus).toBe("idle"))
    expect(api).toHaveBeenCalledTimes(2)
    expect(rendered.result.current).toMatchObject({ snapshot: null, isFetching: false })
  })
  it("forwards native cancellation when its last observer unmounts", async () => {
    held()
    const rendered = mount("dm_abort")
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    const options = api.mock.calls[0]![1] as { signal: AbortSignal; assertActive: () => void }
    expect(api.mock.calls[0]![0]).toBe("/api/community/channels/dm_abort/read-state")
    expect(options.signal.aborted).toBe(false)
    expect(options.assertActive).toBeTypeOf("function")
    rendered.unmount()
    expect(options.signal.aborted).toBe(true)
  })
  it("does not fabricate a never-visited value from a failed read", async () => {
    api.mockRejectedValue(new Error("D1 exhausted"))
    const rendered = mount()
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(rendered.result.current.isFetching).toBe(false))
    expect(rendered.result.current.snapshot).toBeNull()
  })
  it("latches a legitimate never-visited response", async () => {
    api.mockResolvedValueOnce(empty)
    const rendered = mount()
    await waitFor(() => expect(rendered.result.current).toMatchObject({ snapshot: empty, isFetching: false }))
  })
  it("keeps the never-visited latch through a later pointer advance", async () => {
    api.mockResolvedValueOnce(empty)
    const rendered = mount()
    await waitFor(() => expect(rendered.result.current.snapshot).toEqual(empty))
    act(() => client.setQueryData(communityKeys.dmReadStateSnapshot("dm_1"), fresh))
    expect(rendered.result.current.snapshot).toEqual(empty)
  })
  it("withholds a retained rapid-remount value until its new request settles", async () => {
    api.mockResolvedValueOnce(original)
    const first = mount()
    await waitFor(() => expect(first.result.current.snapshot).toEqual(original))
    first.unmount()
    const pending = held(), second = mount()
    expect(second.result.current.snapshot).toBeNull()
    await act(async () => { pending.resolve(fresh) })
    await waitFor(() => expect(second.result.current.snapshot).toEqual(fresh))
    expect(api).toHaveBeenCalledTimes(2)
  })
})
