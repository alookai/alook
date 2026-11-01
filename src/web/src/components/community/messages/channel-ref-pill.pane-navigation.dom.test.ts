import React from "react"
import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, setupUser, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { getCommunityRuntime } from "@/stores/community/runtime"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { retireCommunityAccount } from "@/lib/community/account-cache-lifecycle"
import { reconcileCommunityServerRail } from "@/hooks/community/community-ws/server-rail-reconciliation"
import { runCommunityWsProjectionTransaction } from "@/hooks/community/community-ws/projection-transaction"
import { invalidateChannelRefDirectory } from "@/hooks/community/community-ws/invalidation-projections"
import { shouldPersistQueryKey } from "@/lib/query-persister"
import { communityKeys } from "@/lib/query-keys"
import { ApiError } from "@/lib/errors"
import { ChannelRefPill } from "./channel-ref-pill"

const m = vi.hoisted(() => ({ navigate: vi.fn(), jump: vi.fn(), context: vi.fn(), api: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: m.api }))
vi.mock("@/stores/community", () => ({
  useCommunityStore: (select: (state: { currentServerId: string | null }) => unknown) => select({ currentServerId: null }),
  useUiHandlers: () => ({ navigate: m.navigate, jumpToSeq: m.jump, openMessageContext: m.context }),
}))
const target = { server: { id: "s", name: "Alook" }, channel: { id: "post", name: "Archived post", parentChannelId: "forum" } }
const ref = "/Alook#5620/fix/#259#18"
function deferred() {
  let resolve!: (value: { target: typeof target }) => void
  const promise = new Promise<{ target: typeof target }>(done => { resolve = done })
  return { promise, resolve }
}
function mount(children: React.ReactNode = React.createElement(ChannelRefPill, null, ref), client = new QueryClient()) {
  const view = render(React.createElement(CommunityTestProvider, { client }, children))
  return { ...view, client }
}
beforeEach(() => { vi.resetAllMocks(); m.api.mockResolvedValue({ target }) })
describe("channel ref rendered navigation and query ownership", () => {
  it("opens a numbered archived post from DM through page navigation", async () => {
    mount()
    const button = await screen.findByRole("button", { name: /Archived post.*#18/ })
    fireEvent.click(button)
    expect(m.navigate).toHaveBeenCalledExactlyOnceWith("s", "post")
    expect(m.jump).not.toHaveBeenCalled(); expect(m.context).not.toHaveBeenCalled()
    expect(m.api).toHaveBeenCalledOnce()
    const [path, options] = m.api.mock.calls[0]
    expect(new URL(path, "https://test.local").searchParams.get("ref")).toBe("/alook#5620/fix/#259")
    expect(options).toMatchObject({ authenticationAccount: "viewer", signal: expect.any(AbortSignal), assertActive: expect.any(Function) })
  })
  it("Enter and Space navigate without message jump/context handlers", async () => {
    mount()
    const button = await screen.findByRole("button", { name: /Archived post/ })
    const user = setupUser(); button.focus(); await user.keyboard("{Enter}"); await user.keyboard(" ")
    expect(m.navigate).toHaveBeenCalledTimes(2)
    expect(m.navigate).toHaveBeenLastCalledWith("s", "post")
    expect(m.jump).not.toHaveBeenCalled(); expect(m.context).not.toHaveBeenCalled()
  })
  it("shares one exact request for distinct message suffixes with an empty directory and no thread list", async () => {
    const held = deferred(); m.api.mockReturnValue(held.promise)
    mount(React.createElement(React.Fragment, null,
      React.createElement(ChannelRefPill, null, ref), React.createElement(ChannelRefPill, null, "/ALOOK#5620/fix/#259#27")))
    await waitFor(() => expect(m.api).toHaveBeenCalledOnce())
    expect(screen.getByText(ref).closest("[data-ref-state]")?.getAttribute("data-ref-state")).toBe("loading")
    expect(screen.queryByRole("button")).toBeNull()
    await act(async () => held.resolve({ target }))
    expect(await screen.findByRole("button", { name: /Archived post.*#18/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /Archived post.*#27/ })).toBeTruthy()
    expect(m.api).toHaveBeenCalledOnce()
  })
  it.each([[403, "forbidden"], [404, "missing"]] as const)("keeps raw syntax and has no parent fallback on %s", async (status, state) => {
    m.api.mockRejectedValue(new ApiError("unavailable", status)); mount()
    await waitFor(() => expect(screen.getByText(ref).closest("[data-ref-state]")?.getAttribute("data-ref-state")).toBe(state))
    expect(screen.queryByRole("button")).toBeNull(); expect(m.navigate).not.toHaveBeenCalled(); expect(m.api).toHaveBeenCalledOnce()
  })
  it("shows an ordinary failure separately and retries only on explicit activation", async () => {
    m.api.mockRejectedValueOnce(new ApiError("unavailable", 500)).mockResolvedValueOnce({ target }); mount()
    const retry = await screen.findByRole("button", { name: /Couldn’t load link/ })
    expect(retry.textContent).toBe(ref); expect(m.api).toHaveBeenCalledOnce()
    fireEvent.click(retry)
    expect(await screen.findByRole("button", { name: /Archived post/ })).toBeTruthy()
    expect(m.api).toHaveBeenCalledTimes(2); expect(m.navigate).not.toHaveBeenCalled()
  })
  it("rejects a stale click and late completion after a real parent access change", async () => {
    const { client } = mount()
    const button = await screen.findByRole("button", { name: /Archived post/ })
    const held = deferred(); m.api.mockReturnValue(held.promise)
    await act(async () => { getCommunityRuntime(client).ws.actions.revokeChannelAccess("s", "forum"); fireEvent.click(button) })
    expect(m.navigate).not.toHaveBeenCalled()
    await waitFor(() => expect(m.api).toHaveBeenCalledTimes(2))
    await act(async () => held.resolve({ target }))
    await waitFor(() => expect(screen.getByText(ref).closest("[data-ref-state]")?.getAttribute("data-ref-state")).toBe("forbidden"))
    expect(screen.queryByRole("button")).toBeNull()
  })
  it("does not show the old account result after owner retirement", async () => {
    const held = deferred(); m.api.mockReturnValue(held.promise); const { client } = mount()
    await waitFor(() => expect(m.api).toHaveBeenCalledOnce())
    const options = m.api.mock.calls[0][1]
    await act(async () => { retireCommunityAccount(getCommunityDbRegistry(client)!) })
    expect(options.signal.aborted).toBe(true)
    await act(async () => held.resolve({ target }))
    expect(screen.queryByRole("button")).toBeNull(); expect(m.navigate).not.toHaveBeenCalled()
    expect(() => options.assertActive()).toThrow(/Stale/)
  })
  it("cancels an abandoned target and ignores its late completion after the ref changes", async () => {
    const old = deferred(); m.api.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ target: { ...target, channel: { ...target.channel, id: "new", name: "New post" } } })
    const client = new QueryClient()
    const tree = (value: string) => React.createElement(CommunityTestProvider, { client }, React.createElement(ChannelRefPill, null, value))
    const view = render(tree(ref)); await waitFor(() => expect(m.api).toHaveBeenCalledOnce())
    const signal = m.api.mock.calls[0][1].signal as AbortSignal
    view.rerender(tree("/Alook#5620/fix/#260#11"))
    const button = await screen.findByRole("button", { name: /New post.*#11/ })
    expect(signal.aborted).toBe(true)
    await act(async () => old.resolve({ target })); fireEvent.click(button)
    expect(m.navigate).toHaveBeenCalledExactlyOnceWith("s", "new")
    expect(screen.queryByRole("button", { name: /Archived post/ })).toBeNull()
  })
  it("fences an in-flight result on existing directory invalidation and keeps navigation proofs off disk", async () => {
    const old = deferred(); m.api.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ target: { ...target, channel: { ...target.channel, name: "Renamed post" } } })
    const { client } = mount(); await waitFor(() => expect(m.api).toHaveBeenCalledOnce())
    const signal = m.api.mock.calls[0][1].signal as AbortSignal
    await act(async () => { runCommunityWsProjectionTransaction(client, projection => invalidateChannelRefDirectory(projection)) })
    const button = await screen.findByRole("button", { name: /Renamed post/ })
    expect(signal.aborted).toBe(true)
    await act(async () => old.resolve({ target })); fireEvent.click(button)
    expect(m.navigate).toHaveBeenCalledExactlyOnceWith("s", "post")
    expect(screen.queryByRole("button", { name: /Archived post/ })).toBeNull()
    for (const query of client.getQueryCache().findAll({ queryKey: communityKeys.channelRefTargets() })) expect(shouldPersistQueryKey(query.queryKey)).toBe(false)
  })

  it("drops a warm target after an authoritative denied refresh", async () => {
    const { client } = mount()
    await screen.findByRole("button", { name: /Archived post/ })
    m.api.mockRejectedValue(new ApiError("forbidden", 403))
    await act(async () => { runCommunityWsProjectionTransaction(client, projection => invalidateChannelRefDirectory(projection)) })
    await waitFor(() => expect(screen.getByText(ref).closest("[data-ref-state]")?.getAttribute("data-ref-state")).toBe("forbidden"))
    expect(screen.queryByRole("button")).toBeNull()
  })
  it("resolves the next account independently when the retired account finishes late", async () => {
    const old = deferred(); m.api.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ target: { ...target, channel: { ...target.channel, id: "other-post", name: "Other account post" } } })
    const view = mount(); await waitFor(() => expect(m.api).toHaveBeenCalledOnce())
    await act(async () => { retireCommunityAccount(getCommunityDbRegistry(view.client)!) })
    const next = new QueryClient()
    view.rerender(React.createElement(CommunityTestProvider, { key: "other", client: next, userId: "other" }, React.createElement(ChannelRefPill, null, ref)))
    const button = await screen.findByRole("button", { name: /Other account post/ })
    expect(m.api.mock.calls[1][1].authenticationAccount).toBe("other")
    await act(async () => old.resolve({ target })); fireEvent.click(button)
    expect(m.navigate).toHaveBeenCalledExactlyOnceWith("s", "other-post")
    expect(screen.queryByRole("button", { name: /Archived post/ })).toBeNull()
  })

  it("revalidates a cached ref through the existing reconnect/rail owner after a missed revoke", async () => {
    const { client } = mount(); const staleButton = await screen.findByRole("button", { name: /Archived post/ })
    let deny!: (error: Error) => void
    m.api.mockReturnValue(new Promise((_resolve, reject) => { deny = reject }))
    let refresh!: Promise<void>
    act(() => { refresh = reconcileCommunityServerRail(client) })
    await waitFor(() => expect(m.api).toHaveBeenCalledTimes(2))
    fireEvent.click(staleButton)
    expect(m.navigate).not.toHaveBeenCalled()
    expect(screen.getByText(ref).closest("[data-ref-state]")?.getAttribute("data-ref-state")).toBe("loading")
    await act(async () => { deny(new ApiError("forbidden", 403)); await refresh })
    await waitFor(() => expect(screen.getByText(ref).closest("[data-ref-state]")?.getAttribute("data-ref-state")).toBe("forbidden"))
    expect(screen.queryByRole("button")).toBeNull(); expect(m.api).toHaveBeenCalledTimes(2)
  })

})
