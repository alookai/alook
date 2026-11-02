import { createElement, type PropsWithChildren } from "react"
import { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CommunityMachineSummary, MachineRefreshResult } from "@alook/shared"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { communityKeys } from "@/lib/query-keys"
import type { MachineRefreshState } from "@/lib/community/machine-refresh"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { handleMachineUpdated } from "./community-ws/presence-machine-events"
import { useMachineRefresh } from "./use-machine-refresh"

const apiFetch = vi.fn()
const pending: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = []
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))
beforeEach(() => {
  pending.length = 0
  apiFetch.mockReset().mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })))
})
afterEach(() => vi.useRealTimers())

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: queryClient, retainOwner: true }, children)
  const hook = renderHook(({ machineId }) => useMachineRefresh(machineId), { wrapper, initialProps: { machineId: "m1" } })
  const state = (id = "m1") => queryClient.getQueryData<MachineRefreshState>(communityKeys.machineRefresh(id))!
  const start = async () => {
    const count = apiFetch.mock.calls.length
    act(() => { void hook.result.current.refresh() })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(count + 1))
  }
  const receipt = async (index = 0, overrides = {}) => act(async () => pending[index].resolve({ dispatched: true, ...JSON.parse(apiFetch.mock.calls[index][1].body), ...overrides }))
  const event = async (refreshResult?: MachineRefreshResult, machineId = "m1") => act(async () => {
    await handleMachineUpdated({ type: "community:machine.updated", machine: { id: machineId, status: "online", lastSeenAt: new Date().toISOString() } as CommunityMachineSummary, ...(refreshResult ? { refreshResult } : {}) }, { queryClient })
  })
  queryClient.setQueryData(communityKeys.machines(), { machines: [{ id: "m1", status: "online" }], complete: true, observed: true })
  return { ...hook, queryClient, state, start, receipt, event }
}

describe("correlated machine refresh", () => {
  it("registers a UUID before POST, sends no environment values and ignores rapid repeat clicks", async () => {
    const h = mount()
    await h.start()
    const requestId = h.state().requestId
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/)
    expect(apiFetch.mock.calls[0][0]).toBe("/api/community/machines/m1/refresh")
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ requestId })
    act(() => { void h.result.current.refresh(); void h.result.current.refresh() })
    expect(apiFetch).toHaveBeenCalledTimes(1)
    await h.receipt()
    await waitFor(() => expect(h.result.current.feedback?.message).toContain("Refresh requested"))
    await h.event()
    expect(h.state().status).toBe("pending")
    expect(h.result.current.feedback?.message).not.toContain("complete")
  })

  it.each(["receipt", "failure"])("keeps an early matching WS completion when a late HTTP %s arrives", async late => {
    const h = mount()
    await h.start()
    await h.event({ requestId: h.state().requestId, status: "complete" })
    if (late === "receipt") await h.receipt()
    else await act(async () => pending[0].reject(new Error("network failure")))
    await waitFor(() => expect(h.result.current.feedback?.status).toBe("success"))
    expect(h.state().status).toBe("complete")
  })

  it("ignores mismatched request IDs and other machines", async () => {
    const h = mount()
    await h.start()
    await h.receipt()
    await h.event({ requestId: crypto.randomUUID(), status: "complete" })
    await h.event({ requestId: h.state().requestId, status: "complete" }, "m2")
    expect(h.state().status).toBe("pending")
    await h.event({ requestId: h.state().requestId, status: "complete" })
    expect(h.state().status).toBe("complete")
  })

  it.each([
    ["environment_unavailable", "was not restarted"],
    ["refresh_in_progress", "already running"],
    ["restart_failed", "could not restart"],
    ["ownership_changed", "connection changed"],
  ] as const)("shows actionable %s feedback even before the HTTP receipt", async (code, message) => {
    const h = mount()
    await h.start()
    await h.event({ requestId: h.state().requestId, status: "error", code })
    await h.receipt()
    await waitFor(() => expect(h.result.current.feedback?.message).toContain(message))
    expect(h.result.current.isPending).toBe(false)
  })

  it.each([
    ["machine is offline", "Reconnect it"],
    ["update this daemon before remote Refresh is available", "Update this daemon"],
    ["could not deliver the daemon refresh command", "Could not send"],
    ["private shell output: secret-value", "could not be confirmed"],
  ])("handles a rejected dispatch: %s", async (error, message) => {
    const h = mount()
    await h.start()
    await act(async () => pending[0].reject(new Error(error)))
    await waitFor(() => expect(h.result.current.feedback?.message).toContain(message))
    expect(h.result.current.feedback?.message).not.toContain("secret-value")
  })

  it("times out as unconfirmed, accepts a later matched result, and ignores old results after retry", async () => {
    vi.useFakeTimers()
    const h = mount()
    act(() => { void h.result.current.refresh() })
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
    await h.receipt()
    const firstId = h.state().requestId
    await act(async () => { vi.advanceTimersByTime(90_001) })
    expect(h.state().status).toBe("unconfirmed")
    vi.useRealTimers()
    await h.event({ requestId: firstId, status: "complete" })
    expect(h.state().status).toBe("complete")
    await h.start()
    await h.event({ requestId: firstId, status: "error", code: "restart_failed" })
    expect(h.state().status).toBe("pending")
    expect(h.state().requestId).not.toBe(firstId)
  })

  it("does not apply a late HTTP response after the originating view unmounts", async () => {
    const h = mount()
    await h.start()
    h.unmount()
    await h.receipt()
    expect(h.state()).toMatchObject({ status: "pending", phase: "sending" })
  })

  it("does not publish a late failure into a different machine's view", async () => {
    const h = mount()
    await h.start()
    h.rerender({ machineId: "m2" })
    await act(async () => pending[0].reject(new Error("machine is offline")))
    expect(h.state()).toMatchObject({ status: "pending", phase: "sending" })
    expect(h.state("m2")).toBeUndefined()
    expect(h.result.current.feedback).toBeUndefined()
  })

  it("does not accept a mismatched HTTP request receipt as confirmed dispatch", async () => {
    const h = mount()
    await h.start()
    await h.receipt(0, { requestId: crypto.randomUUID() })
    expect(h.state().status).toBe("unconfirmed")
  })

  it("does not recreate refresh state after its account owner is retired", async () => {
    const h = mount()
    await h.start()
    await act(async () => {
      await getCommunityDbRegistry(h.queryClient)!.cleanup()
      h.queryClient.clear()
    })
    await act(async () => pending[0].reject(new Error("machine is offline")))
    expect(h.state()).toBeUndefined()
  })
})
