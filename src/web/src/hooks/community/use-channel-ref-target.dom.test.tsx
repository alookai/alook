import { createElement, type PropsWithChildren } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { afterEach, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { useChannelRefTarget } from "./use-channel-ref-target"
import { runCommunityWsProjectionTransaction } from "./community-ws/projection-transaction"
import { invalidateChannelRefTargets } from "./community-ws/invalidation-projections"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => load(...args) }))
afterEach(() => load.mockReset())
const target = { server: { id: "server", name: "Studio" }, channel: { id: "child", name: "Thread", parentChannelId: "parent" } }
async function setup() {
  const owner = await createCommunityQueryOwner()
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client }, createElement(CommunityDbProvider, { registry: owner.registry }, children))
  return { ...owner, wrapper }
}

it("shares a canonical target across message seqs without another request when it becomes known", async () => {
  const owner = await setup()
  load.mockResolvedValue({ target })
  const view = renderHook(() => [useChannelRefTarget("/studio#0042/general#1"), useChannelRefTarget("/studio#0042/general#2")], { wrapper: owner.wrapper })
  await waitFor(() => expect(view.result.current.map(row => row.state)).toEqual(["ready", "ready"]))
  expect(view.result.current.map(row => row.messageSeq)).toEqual([1, 2])
  expect(load).toHaveBeenCalledTimes(1)
})

it("keeps known targets qualified through unrelated channel and server changes", async () => {
  const owner = await setup()
  load.mockResolvedValue({ target })
  const view = renderHook(() => useChannelRefTarget("/studio#0042/general#1"), { wrapper: owner.wrapper })
  await waitFor(() => expect(view.result.current.state).toBe("ready"))
  await act(async () => {
    for (let i = 0; i < 200; i++) owner.runtime.ws.actions.beginChannelMembershipChange("other", `unrelated-${i}`)
    owner.runtime.ws.actions.revokeServerAccess("other")
    runCommunityWsProjectionTransaction(owner.client, projection => invalidateChannelRefTargets(projection, { serverId: "other", channelId: "unrelated-0" }))
  })
  await waitFor(() => expect(view.result.current.state).toBe("ready"))
  expect(view.result.current.currentTarget()).toEqual(target)
  expect(load).toHaveBeenCalledTimes(1)
})

it("blocks parent revocation immediately and requalifies after the existing owner restores access", async () => {
  const owner = await setup()
  load.mockResolvedValue({ target })
  const view = renderHook(() => useChannelRefTarget("/studio#0042/general#1"), { wrapper: owner.wrapper })
  await waitFor(() => expect(view.result.current.state).toBe("ready"))
  const previousClick = view.result.current.currentTarget
  await act(async () => {
    owner.runtime.ws.actions.revokeChannelAccess("server", "parent")
    expect(previousClick()).toBeNull()
  })
  await waitFor(() => expect(view.result.current.state).toBe("forbidden"))
  await act(async () => { owner.runtime.ws.actions.rememberChannelAccess("server", "child", "parent") })
  await waitFor(() => expect(view.result.current.state).toBe("ready"))
  expect(load.mock.calls.length).toBeGreaterThan(1)
})

it("restarts an unknown target conservatively and rejects the older response", async () => {
  const owner = await setup()
  let release!: (data: { target: typeof target }) => void
  const held = new Promise<{ target: typeof target }>(resolve => { release = resolve })
  load.mockReturnValueOnce(held).mockResolvedValue({ target })
  const view = renderHook(() => useChannelRefTarget("/studio#0042/general#1"), { wrapper: owner.wrapper })
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
  await act(async () => { owner.runtime.ws.actions.beginChannelMembershipChange("other", "unknown-dependency") })
  await waitFor(() => expect(view.result.current.state).toBe("ready"))
  expect(load).toHaveBeenCalledTimes(2)
  await act(async () => { release({ target: { ...target, channel: { ...target.channel, id: "late" } } }); await Promise.resolve() })
  expect(view.result.current.target).toEqual(target)
  expect(view.result.current.currentTarget()).toEqual(target)
})


it("contains cancellation failure, rejects the old target click and recovers through the original Query retry", async () => {
  const owner = await setup()
  load.mockResolvedValue({ target })
  const view = renderHook(() => useChannelRefTarget("/studio#0042/general#1"), { wrapper: owner.wrapper })
  await waitFor(() => expect(view.result.current.state).toBe("ready"))
  const previousClick = view.result.current.currentTarget
  const failure = new Error("native reference cancellation failed")
  const cancel = vi.spyOn(owner.client, "cancelQueries").mockRejectedValueOnce(failure)
  const invalidate = vi.spyOn(owner.client, "invalidateQueries")
  try {
    await act(async () => { owner.runtime.ws.actions.beginChannelMembershipChange("server", "child") })
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    await expect(cancel.mock.results[0]!.value).rejects.toBe(failure)
    expect(invalidate).not.toHaveBeenCalled()
    expect(previousClick()).toBeNull()
    expect(view.result.current.target).toBeNull()
    expect(view.result.current.state).toBe("loading")
    expect(load).toHaveBeenCalledOnce()
    const queryKey = cancel.mock.calls[0]![0]!.queryKey!
    expect(queryKey).toBeDefined()
    const original = owner.client.getQueryCache().find({ queryKey, exact: true })
    expect(original).toBeDefined()
    await act(async () => { await view.result.current.retry() })
    await waitFor(() => expect(view.result.current.state).toBe("ready"))
    expect(view.result.current.currentTarget()).toEqual(target)
    expect(owner.client.getQueryCache().find({ queryKey, exact: true })).toBe(original)
    expect(load).toHaveBeenCalledTimes(2)
  } finally { cancel.mockRestore(); invalidate.mockRestore() }
})
