import { createElement, type PropsWithChildren } from "react"
import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { getCommunityRuntime } from "@/stores/community/runtime"
import { handleRuntimeModels } from "./community-ws/presence-machine-events"
import { useRuntimeModels, type RuntimeModelsState } from "./use-runtime-models"
import type { MachinesResponse } from "./use-machines"

const apiFetch = vi.fn()
const pending: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = []
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))
beforeEach(() => {
  pending.length = 0
  apiFetch.mockReset().mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })))
})
const catalog = { updateMode: "live_next_turn", defaultModelId: "native-model", models: [{ id: "native-model", supportedReasoningEfforts: [{ value: "high" }], defaultReasoningEffort: "high" }] }
function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: queryClient }, children)
  const hook = renderHook(({ machine, runtime }) => useRuntimeModels(machine, runtime), { wrapper, initialProps: { machine: "m1", runtime: "codex" } })
  const request = (machine = "m1", runtime = "codex") => queryClient.getQueryData<RuntimeModelsState>(communityKeys.runtimeModels(machine, runtime))!
  const open = async () => { const count = apiFetch.mock.calls.length; act(() => hook.result.current.onOpenChange(true)); await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(count + 1)) }
  const reply = (index = 0, overrides: Record<string, unknown> = {}) => {
    const body = JSON.parse(apiFetch.mock.calls[index][1].body)
    return { machineId: "m1", backendId: body.runtimeId, requestId: body.requestId, source: "fresh_discovery", observedAt: "2026-10-29T00:00:00Z", result: { status: "complete", catalog }, ...overrides }
  }
  const complete = async (index = 0, overrides: Record<string, unknown> = {}) => act(async () => pending[index].resolve(reply(index, overrides)))
  queryClient.setQueryData(communityKeys.machines(), { machines: [{ id: "m1", availableRuntimes: [{ id: "codex", status: "healthy" }], quota: [{ keep: true }] }], extra: "keep" })
  return { ...hook, queryClient, request, open, reply, complete }
}

describe("server-cached UI runtime models", () => {
  it("does not prefetch and opens the selected machine/backend through the waiting cache path", async () => {
    const h = mount()
    h.rerender({ machine: "m2", runtime: "agy" })
    expect(apiFetch).not.toHaveBeenCalled()
    await h.open()
    expect(apiFetch.mock.calls[0][0]).toBe("/api/community/machines/m2/discover-models?wait=1")
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ requestId: h.request("m2", "agy").requestId, runtimeId: "agy" })
    expect(h.result.current.isPending).toBe(true)
    act(() => h.result.current.onOpenChange(true))
    expect(apiFetch).toHaveBeenCalledTimes(1)
    await h.complete(0, { machineId: "m2" })
    await waitFor(() => expect(h.result.current.isPending).toBe(false))
  })

  it.each(["fresh_discovery", "cached_report"])("publishes the %s native catalog without losing machine metadata", async (source) => {
    const h = mount()
    await h.open()
    await h.complete(0, { source })
    expect(h.result.current.error).toBeNull()
    expect(h.request()).toMatchObject({ status: "complete", catalog })
    const cached = h.queryClient.getQueryData<MachinesResponse>(communityKeys.machines())!
    expect(cached.machines[0].availableRuntimes).toEqual([{ id: "codex", status: "healthy", reasoning: catalog }])
    expect(cached.machines[0].quota).toEqual([{ keep: true }])
    expect(cached).toHaveProperty("extra", "keep")
    await h.open()
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).not.toHaveProperty("refresh")
  })

  it("uses HTTP completion while ignoring earlier matching or unrelated WS notifications", async () => {
    const h = mount()
    await h.open()
    for (const requestId of ["other", h.request().requestId]) await act(async () => handleRuntimeModels({ type: "community:runtime.models", requestId, machineId: "m1", runtimeId: "codex", result: { status: "complete", catalog: null } }, { queryClient: h.queryClient }))
    expect(h.request().status).toBe("pending")
    await h.complete()
    expect(h.request()).toMatchObject({ status: "complete", catalog })
  })

  it("keeps legacy WS pending handling and applies a missing catalog without destroying metadata", async () => {
    const h = mount()
    act(() => h.queryClient.setQueryData(communityKeys.runtimeModels("m1", "codex"), { requestId: "legacy", status: "pending" }))
    await act(async () => handleRuntimeModels({ type: "community:runtime.models", requestId: "legacy", machineId: "m1", runtimeId: "codex", result: { status: "complete", catalog: null } }, { queryClient: h.queryClient }))
    expect(h.request()).toEqual({ requestId: "legacy", status: "complete", catalog: null })
    expect(h.queryClient.getQueryData<MachinesResponse>(communityKeys.machines())!.machines[0].availableRuntimes).toEqual([{ id: "codex", status: "healthy" }])
  })

  it.each(["close", "scope", "unmount"])("ignores a late HTTP result after %s", async (action) => {
    const h = mount()
    await h.open()
    if (action === "close") act(() => h.result.current.onOpenChange(false))
    if (action === "scope") h.rerender({ machine: "m2", runtime: "agy" })
    if (action === "unmount") h.unmount()
    await h.complete()
    expect(h.request().status).toBe("cancelled")
    expect(h.queryClient.getQueryData<MachinesResponse>(communityKeys.machines())!.machines[0].availableRuntimes?.[0]).not.toHaveProperty("reasoning")
  })

  it("a late failure does not recreate removed state or affect a new machine", async () => {
    const h = mount()
    await h.open()
    h.rerender({ machine: "m2", runtime: "agy" })
    act(() => h.queryClient.removeQueries({ queryKey: communityKeys.runtimeModels("m1", "codex"), exact: true }))
    await act(async () => pending[0].reject(new Error("Late failure")))
    expect(h.queryClient.getQueryData(communityKeys.runtimeModels("m1", "codex"))).toBeUndefined()
    expect(h.queryClient.getQueryData(communityKeys.runtimeModels("m2", "agy"))).toBeUndefined()
  })

  it.each([
    { error: new Error("MACHINE_OFFLINE"), expected: "This machine is offline." },
    { error: new Error("UPGRADE_REQUIRED"), expected: "Update this machine’s daemon to load models." },
    { error: "invalid error response", expected: "Could not load models." },
    { error: new DOMException("timeout", "TimeoutError"), expected: "Model discovery timed out. Retry to load models." },
  ])("reports $expected and Retry forces a new discovery", async ({ error, expected }) => {
    const h = mount()
    await h.open()
    const first = h.request().requestId
    await act(async () => pending[0].reject(error))
    await waitFor(() => expect(h.result.current.error).toBe(expected))
    act(() => h.result.current.retry())
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))
    expect(h.request().requestId).not.toBe(first)
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toMatchObject({ refresh: true })
  })

  it("can load the server cache without the browser WS connection", async () => {
    const h = mount()
    act(() => getCommunityRuntime(h.queryClient).ws.actions.setConnectionStatus("failed"))
    await h.open()
    await h.complete(0, { source: "cached_report" })
    expect(h.result.current.error).toBeNull()
    expect(h.request().status).toBe("complete")
  })

  it.each([{ requestId: "other" }, { machineId: "other" }, { backendId: "other" }, { result: {} }, { source: "stored_report" }, { observedAt: "invalid" }])("refuses a mismatched or invalid HTTP receipt %j", async (overrides) => {
    const h = mount()
    await h.open()
    await h.complete(0, overrides)
    await waitFor(() => expect(h.result.current.error).toBe("Could not load models."))
  })

  it("an aborted late request leaves cancellation intact", async () => {
    const h = mount()
    await h.open()
    act(() => h.result.current.onOpenChange(false))
    await act(async () => pending[0].reject(new DOMException("cancelled", "AbortError")))
    expect(h.request().status).toBe("cancelled")
    expect(h.result.current.error).toBeNull()
  })
})
