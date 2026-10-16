import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import { captureMachinesPublication, publishMachines } from "@/lib/community/machines"
import { handleMachineUpdated } from "./community-ws/presence-machine-events"
import { useMachines, type MachinesResponse } from "./use-machines"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => load(...args) }))
beforeEach(() => { load.mockReset() })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe("machine list primary readiness", () => {
  it("keeps a complete machine update instead of replacing it with an automatic old list read", async () => {
    const { client } = await createCommunityQueryOwner()
    const original = { id: "m1", hostname: "host", displayName: "Host", platform: "darwin", arch: "arm64", osRelease: "24", daemonVersion: "0.1.7", lastSeenAt: null, status: "online" as const, availableRuntimes: [], createdAt: "created", updatedAt: "updated" }
    load.mockImplementation((url: string) => Promise.resolve(url.endsWith("view=list") ? { machines: [original] } : { quotas: [] }))
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client }, children)
    const hook = renderHook(() => useMachines(), { wrapper })
    await waitFor(() => expect(hook.result.current.machines[0]?.daemonVersion).toBe("0.1.7"))
    await act(async () => handleMachineUpdated({ type: "community:machine.updated", machine: { ...original, daemonVersion: "0.1.53" } }, { queryClient: client }))
    await waitFor(() => expect(hook.result.current.isFetching).toBe(false))
    expect(hook.result.current.machines[0].daemonVersion).toBe("0.1.53")
    expect(load.mock.calls.filter(([url]) => url.endsWith("view=list"))).toHaveLength(1)
    hook.unmount()
  })

  it.each([false, true])("keeps restored capacity unknown until the live list arrives (empty=%s)", async (empty) => {
    const { client } = await createCommunityQueryOwner()
    const primary = deferred<MachinesResponse>()
    const machine = { id: "m1", hostname: "host" }
    const machineCapacity = { plan: { id: "free", displayName: "Free" }, isFounder: false, limit: 1, ownedCount: 1, onlineCount: 1 }
    client.setQueryData(communityKeys.machines(), { machines: empty ? [] : [machine], observed: false, source: "restored_idb" })
    load.mockImplementation((url: string) => url.endsWith("view=list") ? primary.promise : Promise.resolve({ quotas: [], machineCapacity }))
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client }, children)
    const hook = renderHook(() => useMachines(), { wrapper })
    await waitFor(() => expect(client.getQueryData([...communityKeys.machines(), "observations"])).toMatchObject({ machineCapacity }))
    expect(hook.result.current.isLoading).toBe(false)
    expect(hook.result.current.data?.machineCapacity).toBeUndefined()
    await act(async () => primary.resolve({ machines: [{ ...machine, status: "online" }] } as MachinesResponse))
    await waitFor(() => expect(hook.result.current.data?.machineCapacity).toMatchObject({ onlineCount: 1, ownedCount: 1 }))
    hook.unmount()
  })

  it("renders the actual list while optional observations wait or fail, and never recreates a removed machine", async () => {
    const { client } = await createCommunityQueryOwner()
    const optional = deferred<{ quotas: Array<{ machineId: string; quota: [] }> }>()
    load.mockImplementation((url: string) => url.endsWith("view=list") ? Promise.resolve({ machines: [{ id: "m1", hostname: "host", status: "online" }] }) : optional.promise)
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client }, children)
    const hook = renderHook(() => useMachines(), { wrapper })
    await waitFor(() => expect(hook.result.current.machines.map(row => row.id)).toEqual(["m1"]))
    expect(hook.result.current.isLoading).toBe(false)
    expect(hook.result.current.data?.machineCapacity).toBeUndefined()
    expect(hook.result.current.capacityPending).toBe(true)
    expect(client.getQueryData(communityKeys.machines())).not.toHaveProperty("quotas")
    await act(async () => { await publishMachines(client, captureMachinesPublication(client), current => ({ ...current, machines: [] })) })
    await act(async () => optional.resolve({ quotas: [{ machineId: "m1", quota: [] }] }))
    await waitFor(() => expect(hook.result.current.machines).toEqual([]))
    expect(client.getQueryData(communityKeys.machines())).toMatchObject({ machines: [] })
    hook.unmount()
  })

  it("retains a confirmed empty list when only quota fails", async () => {
    const { client } = await createCommunityQueryOwner()
    load.mockImplementation((url: string) => url.endsWith("view=list") ? Promise.resolve({ machines: [] }) : Promise.reject(new Error("quota unavailable")))
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client }, children)
    const hook = renderHook(() => useMachines(), { wrapper })
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true))
    expect(hook.result.current.isError).toBe(false)
    expect(hook.result.current.machines).toEqual([])
    expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/machines?view=list", "/api/community/machines?view=observations"])
    hook.unmount()
  })
  it("merges observed quota only into its matching live row and preserves unmatched rows", async () => {
    const { client } = await createCommunityQueryOwner()
    const primary = deferred<MachinesResponse>()
    const first = { id: "m1", hostname: "one", displayName: "One", platform: "darwin", arch: "arm64", osRelease: "24", daemonVersion: "0.1.53", status: "online" as const, createdAt: "created", updatedAt: "updated" }
    const second = { ...first, id: "m2", hostname: "two", status: "offline" as const }
    const quota: [] = []
    load.mockImplementation((url: string) => url.endsWith("view=list") ? primary.promise
      : Promise.resolve({ quotas: [{ machineId: "m1", quota }, { machineId: "removed", quota: [] }] }))
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client }, children)
    const hook = renderHook(() => useMachines(), { wrapper })
    await waitFor(() => expect(client.getQueryData([...communityKeys.machines(), "observations"])).toMatchObject({ quotas: [{ machineId: "m1", quota }, { machineId: "removed", quota: [] }] }))
    expect(hook.result.current.machines).toEqual([])
    expect(hook.result.current.isPending).toBe(true)
    await act(async () => primary.resolve({ machines: [first, second] }))
    await waitFor(() => expect(hook.result.current.machines[0]).toHaveProperty("quota", quota))
    expect(hook.result.current.machines.map(row => row.id)).toEqual(["m1", "m2"])
    expect(hook.result.current.machines[1]).toEqual(second)
    expect(hook.result.current.machines[1]).not.toHaveProperty("quota")
    expect(client.getQueryData<MachinesResponse>(communityKeys.machines())?.machines[0]).not.toHaveProperty("quota")
    hook.unmount()
  })

})
