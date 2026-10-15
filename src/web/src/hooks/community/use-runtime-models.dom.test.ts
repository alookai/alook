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
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))
beforeEach(() => { apiFetch.mockReset(); apiFetch.mockResolvedValue({ dispatched: true }) })

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: queryClient }, children)
  const hook = renderHook(({ machine, runtime }) => useRuntimeModels(machine, runtime), {
    wrapper, initialProps: { machine: "m1", runtime: "codex" },
  })
  const request = (machine = "m1", runtime = "codex") => queryClient.getQueryData<RuntimeModelsState>(communityKeys.runtimeModels(machine, runtime))!
  const complete = (requestId: string, machineId = "m1", runtimeId = "codex") => act(() => handleRuntimeModels({
    type: "community:runtime.models", requestId, machineId, runtimeId, result: { status: "complete", catalog: null },
  }, { queryClient }))
  return { ...hook, queryClient, request, complete }
}

describe("on-demand runtime models", () => {
  it("does not prefetch on mount or runtime change, and sends the selected scope only on open", async () => {
    const h = mount()
    h.rerender({ machine: "m2", runtime: "agy" })
    expect(apiFetch).not.toHaveBeenCalled()
    act(() => h.result.current.onOpenChange(true))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    expect(apiFetch.mock.calls[0][0]).toBe("/api/community/machines/m2/discover-models")
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ requestId: h.request("m2", "agy").requestId, runtimeId: "agy" })
    expect(h.result.current.isPending).toBe(true)
    act(() => h.result.current.onOpenChange(true))
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it("accepts only the matching pending WS result and preserves machine metadata", async () => {
    const h = mount()
    const machine = { id: "m1", availableRuntimes: [{ id: "codex", status: "healthy", reasoning: { updateMode: "unsupported", models: [] } }], quota: [{ keep: true }] }
    h.queryClient.setQueryData(communityKeys.machines(), { machines: [machine], extra: "keep" })
    act(() => h.result.current.onOpenChange(true))
    await h.complete("older")
    await h.complete(h.request().requestId, "other")
    expect(h.request().status).toBe("pending")
    await h.complete(h.request().requestId)
    await waitFor(() => expect(h.result.current.isPending).toBe(false))
    const cached = h.queryClient.getQueryData<MachinesResponse>(communityKeys.machines())!
    expect(cached.machines[0].availableRuntimes).toEqual([{ id: "codex", status: "healthy" }])
    expect(cached.machines[0].quota).toEqual([{ keep: true }])
    expect(cached).toHaveProperty("extra", "keep")
  })

  it("retires pending requests on close and machine/runtime change", async () => {
    const h = mount()
    act(() => h.result.current.onOpenChange(true))
    const first = h.request().requestId
    act(() => h.result.current.onOpenChange(false))
    await h.complete(first)
    expect(h.request().status).toBe("cancelled")
    act(() => h.result.current.onOpenChange(true))
    const second = h.request().requestId
    expect(second).not.toBe(first)
    h.rerender({ machine: "m2", runtime: "agy" })
    await h.complete(second)
    expect(h.request().status).toBe("cancelled")
    expect(h.queryClient.getQueryData(communityKeys.runtimeModels("m2", "agy"))).toBeUndefined()
  })

  it("shows a readable offline failure and Retry starts a fresh request", async () => {
    apiFetch.mockRejectedValueOnce(new Error("MACHINE_OFFLINE"))
    const h = mount()
    act(() => h.result.current.onOpenChange(true))
    const first = h.request().requestId
    await waitFor(() => expect(h.result.current.error).toBe("This machine is offline."))
    act(() => h.result.current.retry())
    expect(h.request().requestId).not.toBe(first)
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))
    expect(h.result.current.isPending).toBe(true)
  })

  it.each([
    { scenario: "generic fallback", error: "invalid error response", expected: "Could not load models." },
    { scenario: "daemon upgrade instruction", error: new Error("UPGRADE_REQUIRED"), expected: "Update this machine’s daemon to load models." },
    { scenario: "native error message", error: new Error("Native model query failed."), expected: "Native model query failed." },
  ])("shows the $scenario after request failure", async ({ error, expected }) => {
    apiFetch.mockRejectedValueOnce(error)
    const h = mount()
    act(() => h.result.current.onOpenChange(true))
    await waitFor(() => expect(h.result.current.error).toBe(expected))
    expect(h.result.current.isPending).toBe(false)
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it("a late failed request does not recreate a removed cache or affect the new machine", async () => {
    let rejectRequest!: (error: unknown) => void
    apiFetch.mockImplementationOnce(() => new Promise((_, reject) => { rejectRequest = reject }))
    const h = mount()
    act(() => h.result.current.onOpenChange(true))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    h.rerender({ machine: "m2", runtime: "agy" })
    act(() => h.queryClient.removeQueries({ queryKey: communityKeys.runtimeModels("m1", "codex"), exact: true }))
    await act(async () => { rejectRequest(new Error("Late native failure.")) })
    expect(h.queryClient.getQueryData(communityKeys.runtimeModels("m1", "codex"))).toBeUndefined()
    expect(h.queryClient.getQueryData(communityKeys.runtimeModels("m2", "agy"))).toBeUndefined()
    expect(h.result.current.error).toBeNull()
    expect(h.result.current.isPending).toBe(false)
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it("opening while disconnected ends loading without dispatching a request", async () => {
    const h = mount()
    act(() => getCommunityRuntime(h.queryClient).ws.actions.setConnectionStatus("failed"))
    act(() => h.result.current.onOpenChange(true))
    await waitFor(() => expect(h.result.current.error).toBe("Reconnect to load models."))
    expect(h.result.current.isPending).toBe(false)
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it("a late aborted request does not replace the cancelled state with an error", async () => {
    let rejectRequest!: (error: unknown) => void
    apiFetch.mockImplementationOnce(() => new Promise((_, reject) => { rejectRequest = reject }))
    const h = mount()
    act(() => h.result.current.onOpenChange(true))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    const id = h.request().requestId
    act(() => h.result.current.onOpenChange(false))
    await act(async () => { rejectRequest(new DOMException("Request cancelled", "AbortError")) })
    await waitFor(() => expect(h.result.current.isPending).toBe(false))
    expect(h.request()).toEqual({ requestId: id, status: "cancelled" })
    expect(h.result.current.error).toBeNull()
  })

  it("ends loading on disconnect and ignores the late native result", async () => {
    const h = mount()
    act(() => h.result.current.onOpenChange(true))
    const id = h.request().requestId
    act(() => getCommunityRuntime(h.queryClient).ws.actions.setConnectionStatus("reconnecting"))
    await waitFor(() => expect(h.result.current.error).toBe("Connection lost. Retry to load models."))
    await h.complete(id)
    expect(h.request().status).toBe("error")
  })

  it("ends loading at 45 seconds and ignores a result after timeout", async () => {
    const h = mount()
    const timeout = vi.spyOn(globalThis, "setTimeout")
    act(() => h.result.current.onOpenChange(true))
    await waitFor(() => expect(h.result.current.isPending).toBe(true))
    const id = h.request().requestId
    const callback = timeout.mock.calls.find((call) => call[1] === 45_000)?.[0]
    expect(callback).toBeTypeOf("function")
    act(() => { if (typeof callback === "function") callback() })
    await waitFor(() => expect(h.result.current.error).toBe("Model discovery timed out. Retry to load models."))
    await h.complete(id)
    expect(h.request().status).toBe("error")
    timeout.mockRestore()
  })

  it("applies the native catalog and preserves it when a later discovery fails", async () => {
    const h = mount()
    h.queryClient.setQueryData(communityKeys.machines(), { machines: [{ id: "m1", availableRuntimes: [{ id: "codex" }] }] })
    act(() => h.result.current.onOpenChange(true))
    const catalog = { updateMode: "live_next_turn" as const, models: [{ id: "native-model", supportedReasoningEfforts: [] }] }
    await act(async () => handleRuntimeModels({ type: "community:runtime.models", machineId: "m1", runtimeId: "codex", requestId: h.request().requestId, result: { status: "complete", catalog } }, { queryClient: h.queryClient }))
    expect(h.queryClient.getQueryData<MachinesResponse>(communityKeys.machines())!.machines[0].availableRuntimes?.[0].reasoning).toEqual(catalog)
    act(() => h.result.current.retry())
    await act(async () => handleRuntimeModels({ type: "community:runtime.models", machineId: "m1", runtimeId: "codex", requestId: h.request().requestId, result: { status: "error", code: "model_discovery_timeout", message: "Model query timed out." } }, { queryClient: h.queryClient }))
    await waitFor(() => expect(h.result.current.error).toBe("Model query timed out."))
    expect(h.queryClient.getQueryData<MachinesResponse>(communityKeys.machines())!.machines[0].availableRuntimes?.[0].reasoning).toEqual(catalog)
  })

})
