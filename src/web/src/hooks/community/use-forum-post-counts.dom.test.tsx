import "fake-indexeddb/auto"
import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityDbRegistry, registerCommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { communityKeys } from "@/lib/query-keys"
import { refreshForumPostCounts, useForumPostCounts } from "./use-forum-post-counts"
import { ForumPostCount, ForumPostCountsProvider } from "@/components/community/channels/forum-post-count"

const fetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: fetch }))
const cleanups: Array<() => void | Promise<void>> = []
beforeEach(() => { fetch.mockReset() })
afterEach(async () => { await act(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() }) })

async function setup(account = "viewer") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const registry = createCommunityDbRegistry(client, account)
  await registry.preload()
  const unregister = registerCommunityDbRegistry(registry)
  cleanups.push(unregister, registry.cleanup.bind(registry))
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, createElement(CommunityDbProvider, { registry }, children))
  return { client, registry, wrapper }
}

describe("independent forum count query", () => {
  it("does not fetch before primary readiness; pending counts leave navigation mounted and caches intact", async () => {
    const { client, wrapper } = await setup()
    const directory = { cached: "directory" }, messages = { cached: "messages" }
    client.setQueryData(communityKeys.server("s1"), directory)
    client.setQueryData(communityKeys.channelMessages("c1"), messages)
    let release!: (value: unknown) => void
    fetch.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const clicked = vi.fn()
    const view = (enabled: boolean) => <ForumPostCountsProvider serverId="s1" enabled={enabled}><button onClick={clicked}>Channel<ForumPostCount channelId="f1" /></button></ForumPostCountsProvider>
    const rendered = render(view(false), { wrapper })
    expect(fetch).not.toHaveBeenCalled()
    rendered.rerender(view(true))
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(rendered.container.querySelector('[aria-label="Loading unarchived post count"]')).not.toBeNull()
    act(() => rendered.container.querySelector("button")!.click())
    expect(clicked).toHaveBeenCalledOnce()
    await act(async () => { await client.invalidateQueries({ queryKey: communityKeys.server("s1") }) })
    expect(fetch).toHaveBeenCalledOnce()
    expect(client.getQueryData(communityKeys.server("s1"))).toBe(directory)
    expect(client.getQueryData(communityKeys.channelMessages("c1"))).toBe(messages)
    await act(async () => release({ serverId: "s1", counts: { f1: 0 } }))
    await waitFor(() => expect(rendered.container.querySelector('[aria-label="Loading unarchived post count"]')).toBeNull())
    expect(rendered.container.textContent).toBe("Channel")
    rendered.unmount()
  })
  it("retains an available count through refresh failure and recovers without touching directory cache", async () => {
    const { client, wrapper } = await setup()
    fetch.mockResolvedValue({ serverId: "s1", counts: { f1: 12 } })
    const hook = renderHook(() => useForumPostCounts("s1", true), { wrapper })
    await waitFor(() => expect(hook.result.current.data).toEqual({ f1: 12 }))
    fetch.mockRejectedValue(new Error("offline"))
    await act(async () => { expect((await hook.result.current.refetch()).isError).toBe(true) })
    expect(hook.result.current.data).toEqual({ f1: 12 })
    fetch.mockResolvedValue({ serverId: "s1", counts: { f1: 11 } })
    act(() => refreshForumPostCounts(client, "s1"))
    await waitFor(() => expect(hook.result.current.data).toEqual({ f1: 11 }))
    hook.unmount()
  })
  it("does not display one server's counts while another server request is pending", async () => {
    const { wrapper } = await setup()
    fetch.mockResolvedValueOnce({ serverId: "s1", counts: { f1: 12 } }).mockImplementation(() => new Promise(() => {}))
    const hook = renderHook(({ serverId }) => useForumPostCounts(serverId, true), { wrapper, initialProps: { serverId: "s1" } })
    await waitFor(() => expect(hook.result.current.data).toEqual({ f1: 12 }))
    hook.rerender({ serverId: "s2" })
    expect(hook.result.current.data).toBeUndefined()
    hook.unmount()
  })
  it("rejects a response for another server and recovers from a cold failure", async () => {
    const { wrapper } = await setup()
    fetch.mockResolvedValue({ serverId: "other", counts: { secret: 99 } })
    const hook = renderHook(() => ({ ...useForumPostCounts("s1", true) }), { wrapper })
    await waitFor(() => expect(hook.result.current.isError).toBe(true), { timeout: 3000 })
    expect(hook.result.current.data).toBeUndefined()
    fetch.mockResolvedValue({ serverId: "s1", counts: { f1: 1 } })
    await act(async () => { await hook.result.current.refetch() })
    await waitFor(() => expect(hook.result.current.data).toEqual({ f1: 1 }))
    hook.unmount()
  })
  it("rejects late data after the originating account retires", async () => {
    const { registry, wrapper } = await setup()
    let release!: (value: unknown) => void
    fetch.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const hook = renderHook(() => ({ ...useForumPostCounts("s1", true) }), { wrapper })
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    act(() => registry.runtime.lifecycle.setState(state => ({ ...state, active: false, generation: state.generation + 1 })))
    await act(async () => release({ serverId: "s1", counts: { f1: 99 } }))
    await waitFor(() => expect(hook.result.current.isError).toBe(true), { timeout: 3000 })
    expect(hook.result.current.data).toBeUndefined()
    hook.unmount()
  })

})
