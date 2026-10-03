import { useLayoutEffect } from "react"
import { createElement, type PropsWithChildren } from "react"
import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { communityKeys } from "@/lib/query-keys"
import { serverSchema, channelSchema } from "@/lib/community-db/schema"
import { channelRefDirectoryQueryFn, useChannelRefDirectory } from "./use-channel-ref-directory"

const api = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: api }))
const directory = [{ id: "srv", name: "Studio", discriminator: "0001", channels: [{ id: "ch", name: "general", type: "text" as const }] }]
const clients: QueryClient[] = []
function client() { const qc = new QueryClient({ defaultOptions: { queries: { retry: 2 } } }); clients.push(qc); return qc }
function wrapper(qc: QueryClient) { return function Owner({ children }: PropsWithChildren) { return createElement(CommunityTestProvider, { client: qc }, children) } }
function mount(qc = client(), enabled = true) { return renderHook(({ active }: { active: boolean }) => useChannelRefDirectory(active), { initialProps: { active: enabled }, wrapper: wrapper(qc) }) }
function deferred() { let resolve!: (value: { directory: typeof directory }) => void; const promise = new Promise<{ directory: typeof directory }>((done) => { resolve = done }); return { promise, resolve } }
function seed(qc: QueryClient, channels = true) {
  qc.setQueryData(communityKeys.communityDbCollection("viewer", "servers"), [serverSchema.parse({ id: "srv", name: "Studio", discriminator: "0001", description: "", ownerId: "viewer", icon: null, official: false, isOwner: true, unread: false, mentions: 0 })])
  qc.setQueryData(communityKeys.communityDbCollection("viewer", "channels"), channels ? [channelSchema.parse({ id: "ch", serverId: "srv", name: "general", type: "text", position: 0, archived: false, muted: false, unread: false, tags: [], pending: false })] : [])
}
beforeEach(() => { api.mockReset() })
beforeEach(() => () => { act(() => { clients.splice(0).forEach((qc) => qc.clear()) }) })
describe("native canonical channel directory", () => {
  it("uses the qualified lightweight API helper", async () => {
    api.mockResolvedValue({ directory }); const options = { authenticationAccount: "viewer" }
    await expect(channelRefDirectoryQueryFn(options)).resolves.toEqual(directory)
    expect(api).toHaveBeenCalledWith("/api/community/users/me/channel-directory", options)
  })
  it("stays dormant until enabled then publishes DB rows and transport IDs", async () => {
    const held = deferred(); api.mockReturnValue(held.promise); const qc = client(), view = mount(qc, false)
    expect(api).not.toHaveBeenCalled(); expect(view.result.current).toMatchObject({ directory: [], isResolved: false, isLoading: false })
    view.rerender({ active: true }); await waitFor(() => expect(api).toHaveBeenCalledOnce())
    expect(view.result.current.isLoading).toBe(true)
    await act(async () => held.resolve({ directory })); await waitFor(() => expect(view.result.current.directory).toEqual(directory))
    expect(qc.getQueryData(communityKeys.channelRefDirectory())).toEqual(["srv"])
  })
  it("treats a successful empty response as resolved", async () => {
    api.mockResolvedValue({ directory: [] }); const view = mount()
    await waitFor(() => expect(view.result.current).toMatchObject({ directory: [], isResolved: true, isLoading: false, isError: false }))
  })
  it("does not retry ordinary failure and refetches once on demand", async () => {
    api.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce({ directory }); const view = mount()
    await waitFor(() => expect(view.result.current.isError).toBe(true)); expect(api).toHaveBeenCalledOnce()
    await act(async () => { await view.result.current.refetch() }); await waitFor(() => expect(view.result.current.directory).toEqual(directory)); expect(api).toHaveBeenCalledTimes(2)
  })
  it("reads warm canonical facts and native transport IDs without another fetch", async () => {
    const qc = client(); seed(qc); qc.setQueryData(communityKeys.channelRefDirectory(), ["srv"]); const view = mount(qc, false)
    await waitFor(() => expect(view.result.current.directory).toEqual(directory)); view.rerender({ active: true }); expect(api).not.toHaveBeenCalled()
  })
  it("keeps the native account read alive after popup unmount and releases its observer after settlement", async () => {
    const held = deferred(); api.mockReturnValue(held.promise); const qc = client()
    let result!: ReturnType<typeof useChannelRefDirectory>
    function Popup() { const value = useChannelRefDirectory(); useLayoutEffect(() => { result = value }); return null }
    const tree = (show: boolean) => createElement(CommunityTestProvider, { client: qc }, show ? createElement(Popup) : null)
    const view = render(tree(true)); await waitFor(() => expect(api).toHaveBeenCalledOnce())
    const signal = api.mock.calls[0][1].signal as AbortSignal
    view.rerender(tree(false)); expect(signal.aborted).toBe(false)
    expect(qc.getQueryCache().find({ queryKey: communityKeys.channelRefDirectory() })!.getObserversCount()).toBe(1)
    await act(async () => held.resolve({ directory })); await waitFor(() => expect(qc.getQueryData(communityKeys.channelRefDirectory())).toEqual(["srv"]))
    expect(qc.getQueryCache().find({ queryKey: communityKeys.channelRefDirectory() })!.getObserversCount()).toBe(0)
    view.rerender(tree(true)); await waitFor(() => expect(result.directory).toEqual(directory)); expect(api).toHaveBeenCalledOnce()
  })
  it("resolves from canonical channels while the transport is dormant", async () => {
    const qc = client(); seed(qc); const view = mount(qc, false)
    await waitFor(() => expect(view.result.current).toMatchObject({ directory, isResolved: true, isLoading: false })); expect(api).not.toHaveBeenCalled()
  })
  it("keeps a server without channels unresolved while HTTP is held", async () => {
    api.mockReturnValue(new Promise(() => {})); const qc = client(); seed(qc, false); const view = mount(qc)
    await waitFor(() => expect(api).toHaveBeenCalledOnce()); expect(view.result.current).toMatchObject({ directory: [], isResolved: false, isLoading: true })
  })
  it("keeps an invalidated empty success pending during its native refresh", async () => {
    api.mockReturnValue(new Promise(() => {})); const qc = client(); qc.setQueryData(communityKeys.channelRefDirectory(), [])
    await qc.invalidateQueries({ queryKey: communityKeys.channelRefDirectory(), refetchType: "none" }); const view = mount(qc)
    await waitFor(() => expect(api).toHaveBeenCalledOnce()); expect(view.result.current).toMatchObject({ directory: [], isResolved: false, isLoading: true })
  })
  it("preserves canonical rows through ordinary background failure", async () => {
    const qc = client(); seed(qc); qc.setQueryData(communityKeys.channelRefDirectory(), ["srv"]); api.mockRejectedValue(new Error("background failed")); const view = mount(qc)
    await waitFor(() => expect(view.result.current.directory).toEqual(directory)); await act(async () => { await view.result.current.refetch() })
    expect(view.result.current).toMatchObject({ directory, isResolved: true, isError: false }); expect(api).toHaveBeenCalledOnce()
  })
  it("does not import a manually written old transport DTO into canonical facts", async () => {
    const qc = client(); qc.setQueryData(communityKeys.channelRefDirectory(), directory); const view = mount(qc, false)
    await act(async () => { await Promise.resolve() }); expect(view.result.current.directory).toEqual([]); expect(api).not.toHaveBeenCalled()
  })
  it("cancels the native warm request when the actual original owner leaves", async () => {
    const held = deferred(); api.mockReturnValue(held.promise); const qc = client(), view = mount(qc)
    await waitFor(() => expect(api).toHaveBeenCalledOnce()); const signal = api.mock.calls[0][1].signal as AbortSignal
    view.unmount(); qc.clear(); expect(signal.aborted).toBe(true)
    await act(async () => held.resolve({ directory })); expect(qc.getQueryData(communityKeys.channelRefDirectory())).toBeUndefined()
  })
})
