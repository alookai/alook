import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { CONVERSATION_READ_TIMEOUT_MS, ConversationReadTimeoutError } from "@/lib/community/conversation-read"
import { communityKeys } from "@/lib/query-keys"
import { useChannelReadStateSnapshot, type ChannelReadStateSnapshot } from "./use-channel-read-state"

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
    vi.useRealTimers(); onlineManager.setOnline(true)
  })
})
function Owner({ children }: PropsWithChildren) { return createElement(QueryClientProvider, { client }, createElement(CommunityDbProvider, { registry }, children)) }
function mount(id = "ch_1", canonical?: ChannelReadStateSnapshot) {
  return renderHook(({ id, canonical }) => useChannelReadStateSnapshot(id, canonical), { wrapper: Owner, initialProps: { id, canonical } })
}
function held() {
  let resolve!: (value: ChannelReadStateSnapshot) => void
  api.mockReturnValueOnce(new Promise<ChannelReadStateSnapshot>((done) => { resolve = done }))
  return { resolve }
}

describe("native channel read-state snapshot", () => {
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
    client.setQueryData(communityKeys.channelReadStateSnapshot("ch_1"), original)
    const pending = held(), rendered = mount()
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    expect(rendered.result.current.snapshot).toBeNull()
    await act(async () => { pending.resolve(fresh) })
    await waitFor(() => expect(rendered.result.current.snapshot).toEqual(fresh))
  })
  it("freezes canonical data immediately while the mount request revalidates", async () => {
    const pending = held(), rendered = mount("ch_1", original)
    expect(rendered.result.current).toMatchObject({ snapshot: original, isFetching: false })
    await act(async () => { pending.resolve(fresh) })
    rendered.rerender({ id: "ch_1", canonical: undefined })
    expect(rendered.result.current.snapshot).toEqual(original)
  })
  it("keeps the first settled snapshot through a later refetch", async () => {
    api.mockResolvedValueOnce(original)
    const rendered = mount()
    await waitFor(() => expect(rendered.result.current.snapshot).toEqual(original))
    api.mockResolvedValueOnce(fresh)
    await act(async () => { await client.refetchQueries({ queryKey: communityKeys.channelReadStateSnapshot("ch_1"), exact: true }) })
    expect(client.getQueryData(communityKeys.channelReadStateSnapshot("ch_1"))).toEqual(fresh)
    expect(rendered.result.current.snapshot).toEqual(original)
  })
  it("rebuilds the latch on a same-mount channel switch", async () => {
    api.mockResolvedValueOnce(original)
    const rendered = mount()
    await waitFor(() => expect(rendered.result.current.snapshot).toEqual(original))
    const pending = held()
    rendered.rerender({ id: "ch_2", canonical: undefined })
    expect(rendered.result.current.snapshot).toBeNull()
    await act(async () => { pending.resolve(fresh) })
    await waitFor(() => expect(rendered.result.current.snapshot).toEqual(fresh))
  })
  it("runs exactly one client retry and leaves exhausted reads unlatchable", async () => {
    api.mockRejectedValue(new Error("offline"))
    const rendered = mount()
    await waitFor(() => expect(client.getQueryState(communityKeys.channelReadStateSnapshot("ch_1"))?.fetchStatus).toBe("idle"))
    expect(api).toHaveBeenCalledTimes(2)
    expect(rendered.result.current).toMatchObject({ snapshot: null, isFetching: false })
  })
  it("forwards native cancellation when its last observer unmounts", async () => {
    held()
    const rendered = mount("ch_abort")
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    const options = api.mock.calls[0]![1] as { signal: AbortSignal; assertActive: () => void }
    expect(api.mock.calls[0]![0]).toBe("/api/community/channels/ch_abort/read-state")
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
    act(() => client.setQueryData(communityKeys.channelReadStateSnapshot("ch_1"), fresh))
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
  it("turns a held cold read into a manual retryable timeout and fences its late result", async () => {
    vi.useFakeTimers()
    const pending = held(), rendered = mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api).toHaveBeenCalledOnce()
    const signal = api.mock.calls[0][1].signal as AbortSignal
    await act(async () => { await vi.advanceTimersByTimeAsync(CONVERSATION_READ_TIMEOUT_MS + 1) })
    expect(rendered.result.current.error).toBeInstanceOf(ConversationReadTimeoutError)
    expect(rendered.result.current.snapshot).toBeNull()
    expect(rendered.result.current.isFetching).toBe(false)
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve(original); await vi.advanceTimersByTimeAsync(0) })
    expect(rendered.result.current.snapshot).toBeNull()
    api.mockResolvedValueOnce(fresh)
    await act(async () => { rendered.result.current.retry(); await vi.advanceTimersByTimeAsync(1) })
    expect(rendered.result.current.snapshot).toEqual(fresh)
    expect(api).toHaveBeenCalledTimes(2)
  })

  it("runs the bounded first read even when Query's online manager is offline", async () => {
    vi.useFakeTimers()
    onlineManager.setOnline(false)
    held()
    const rendered = mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(CONVERSATION_READ_TIMEOUT_MS + 1) })
    expect(api).toHaveBeenCalledOnce()
    expect(rendered.result.current.error).toBeInstanceOf(ConversationReadTimeoutError)
    expect(rendered.result.current.isFetching).toBe(false)
  })

})
