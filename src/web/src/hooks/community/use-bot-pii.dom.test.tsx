import { createElement, type PropsWithChildren } from "react"
import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { shouldDehydrateCommunityQuery } from "@/lib/query-persister"
import { handleBotPii } from "./community-ws/pii-events"
import { useBotPii, type BotPiiState } from "./use-bot-pii"

const apiFetch = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))
beforeEach(() => { apiFetch.mockReset(); apiFetch.mockResolvedValue({ dispatched: true }) })
const snapshot = { revision: 3, plugins: [{ id: "email", name: "Email", description: "Masks email addresses", enabled: true }] }
function mount(online = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client }, children)
  const hook = renderHook(({ botId, machineId, online }) => useBotPii(botId, machineId, online), { wrapper, initialProps: { botId: "b1", machineId: "m1", online } })
  const state = (botId = "b1", machineId = "m1") => client.getQueryData<BotPiiState>(communityKeys.botPii(machineId, botId))
  const reply = (requestId: string, botId = "b1", machineId = "m1") => act(() => handleBotPii({ botId, machineId, requestId, result: { status: "complete", snapshot } }, { queryClient: client }))
  return { ...hook, client, state, reply }
}

describe("local bot PII management", () => {
  it("loads only the selected bot and accepts only a matching local result", async () => {
    const h = mount()
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    const requestId = h.state()!.requestId
    expect(apiFetch.mock.calls[0][0]).toBe("/api/community/bots/b1/pii")
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ requestId, operation: { action: "list" } })
    expect(h.result.current.snapshot).toBeUndefined()
    await h.reply("old")
    await h.reply(requestId, "other")
    await h.reply(requestId, "b1", "other")
    expect(h.state()?.status).toBe("pending")
    await h.reply(requestId)
    await waitFor(() => expect(h.result.current.snapshot).toEqual(snapshot))
    expect(shouldDehydrateCommunityQuery({ queryKey: communityKeys.botPii("m1", "b1"), state: { status: "success", data: h.state() } })).toBe(false)
  })

  it("uses the confirmed revision and blocks duplicate mutations until acknowledgement", async () => {
    const h = mount()
    await h.reply(h.state()!.requestId)
    await waitFor(() => expect(h.result.current.snapshot).toEqual(snapshot))
    let pending: Promise<boolean>
    act(() => { pending = h.result.current.setEnabled("email", false) })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))
    expect(JSON.parse(apiFetch.mock.calls[1][1].body).operation).toEqual({ action: "setEnabled", pluginId: "email", enabled: false, expectedRevision: 3 })
    expect(h.result.current.snapshot?.plugins[0].enabled).toBe(true)
    await act(async () => { expect(await h.result.current.remove("email")).toBe(false) })
    expect(apiFetch).toHaveBeenCalledTimes(2)
    await act(async () => {
      handleBotPii({ botId: "b1", machineId: "m1", requestId: h.state()!.requestId, result: { status: "error", code: "PII_CONFLICT", snapshot: { ...snapshot, revision: 4 } } }, { queryClient: h.client })
      expect(await pending!).toBe(false)
    })
    await waitFor(() => expect(h.result.current.snapshot?.revision).toBe(4))
    expect(h.result.current.error).toMatch(/changed elsewhere/)
  })

  it("retires old bot requests and never starts a request while offline", async () => {
    const h = mount(false)
    expect(apiFetch).not.toHaveBeenCalled()
    h.rerender({ botId: "b1", machineId: "m1", online: true })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    const old = h.state()!.requestId
    h.rerender({ botId: "b2", machineId: "m2", online: true })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))
    await h.reply(old)
    expect(h.result.current.snapshot).toBeUndefined()
    expect(h.state()?.status).not.toBe("complete")
    await h.reply(h.state("b2", "m2")!.requestId, "b2", "m2")
    await waitFor(() => expect(h.result.current.snapshot).toEqual(snapshot))
  })


  it("blocks further writes after a lost acknowledgement until a fresh list arrives", async () => {
    const h = mount()
    await h.reply(h.state()!.requestId)
    await waitFor(() => expect(h.result.current.snapshot).toEqual(snapshot))
    apiFetch.mockRejectedValueOnce(new Error("NETWORK_ERROR"))
    await act(async () => { expect(await h.result.current.remove("email")).toBe(false) })
    await waitFor(() => expect(h.result.current.unavailable).toMatch(/Reload filters/))
    expect(h.result.current.snapshot).toEqual(snapshot)
    await act(async () => { expect(await h.result.current.setEnabled("email", false)).toBe(false) })
    expect(apiFetch).toHaveBeenCalledTimes(2)
    act(() => { void h.result.current.reload() })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3))
    await h.reply(h.state()!.requestId)
    await waitFor(() => expect(h.result.current.unavailable).toBeUndefined())
  })

  it("does not turn failed loading into an empty list", async () => {
    apiFetch.mockRejectedValueOnce(new Error("UPGRADE_REQUIRED"))
    const h = mount()
    await waitFor(() => expect(h.result.current.error).toMatch(/Update this machine/))
    expect(h.result.current.snapshot).toBeUndefined()
    expect(h.result.current.pending).toBe(false)
  })
})

describe("PII playground", () => {
  it("correlates preview output, sends the current revision, and never persists test text", async () => {
    const h = mount()
    await h.reply(h.state()!.requestId)
    await waitFor(() => expect(h.result.current.snapshot).toEqual(snapshot))
    let run: Promise<boolean>
    act(() => { run = h.result.current.preview("person@example.com") })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))
    const id = h.state()!.requestId
    expect(JSON.parse(apiFetch.mock.calls[1][1].body).operation).toEqual({ action: "preview", text: "person@example.com", expectedRevision: 3 })
    expect(JSON.stringify(h.state())).not.toContain("person@example.com")
    await act(async () => { expect(await h.result.current.preview("duplicate")).toBe(false) })
    await act(async () => {
      handleBotPii({ botId: "b1", machineId: "m1", requestId: "old", result: { status: "complete", snapshot, output: "stale" } }, { queryClient: h.client })
    })
    expect(h.result.current.output).toBeUndefined()
    await act(async () => {
      handleBotPii({ botId: "b1", machineId: "m1", requestId: id, result: { status: "complete", snapshot, output: "[EMAIL]", triggeredFilters: [{ id: "email", name: "Email" }] } }, { queryClient: h.client })
      expect(await run!).toBe(true)
    })
    await waitFor(() => expect(h.result.current.output).toBe("[EMAIL]"))
    expect(h.result.current.triggeredFilters).toEqual([{ id: "email", name: "Email" }])
    expect(shouldDehydrateCommunityQuery({ queryKey: communityKeys.botPii("m1", "b1"), state: { status: "success", data: h.state() } })).toBe(false)
    act(() => h.result.current.clearPreview())
    expect(h.state()?.output).toBeUndefined()
    expect(h.state()?.triggeredFilters).toBeUndefined()
    await waitFor(() => expect(h.result.current.output).toBeUndefined())
    expect(h.result.current.snapshot).toEqual(snapshot)
  })

  it("clears previous output before a new run and makes failed previews retryable", async () => {
    const h = mount()
    await h.reply(h.state()!.requestId)
    await waitFor(() => expect(h.result.current.snapshot).toEqual(snapshot))
    act(() => { void h.result.current.preview("first") })
    await act(async () => handleBotPii({ botId: "b1", machineId: "m1", requestId: h.state()!.requestId, result: { status: "complete", snapshot, output: "first result" } }, { queryClient: h.client }))
    await waitFor(() => expect(h.result.current.output).toBe("first result"))
    act(() => { void h.result.current.preview("second") })
    expect(h.state()?.output).toBeUndefined()
    expect(h.state()?.triggeredFilters).toBeUndefined()
    await waitFor(() => expect(h.result.current.output).toBeUndefined())
    await act(async () => handleBotPii({ botId: "b1", machineId: "m1", requestId: h.state()!.requestId, result: { status: "error", code: "PII_PLUGIN_FAILED" } }, { queryClient: h.client }))
    await waitFor(() => expect(h.result.current.previewError).toMatch(/could not process/))
    expect(h.result.current.unavailable).toBeUndefined()
    expect(h.result.current.output).toBeUndefined()
    act(() => { void h.result.current.preview("retry") })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(4))
  })

  it("rejects oversize UTF-8 input and discards a cleared pending result", async () => {
    const h = mount()
    await h.reply(h.state()!.requestId)
    await waitFor(() => expect(h.result.current.snapshot).toEqual(snapshot))
    await act(async () => { expect(await h.result.current.preview("汉".repeat(342))).toBe(false) })
    expect(apiFetch).toHaveBeenCalledTimes(1)
    let run: Promise<boolean>
    act(() => { run = h.result.current.preview("sample") })
    const id = h.state()!.requestId
    await act(async () => { h.result.current.clearPreview(); expect(await run!).toBe(false) })
    await act(async () => handleBotPii({ botId: "b1", machineId: "m1", requestId: id, result: { status: "complete", snapshot, output: "discard me" } }, { queryClient: h.client }))
    expect(h.result.current.output).toBeUndefined()
  })

  it("retires previews on disconnect without replaying test text", async () => {
    const h = mount()
    await h.reply(h.state()!.requestId)
    await waitFor(() => expect(h.result.current.snapshot).toEqual(snapshot))
    let run: Promise<boolean>
    act(() => { run = h.result.current.preview("sample") })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))
    const id = h.state()!.requestId
    h.rerender({ botId: "b1", machineId: "m1", online: false })
    await act(async () => { expect(await run!).toBe(false) })
    await act(async () => handleBotPii({ botId: "b1", machineId: "m1", requestId: id, result: { status: "complete", snapshot, output: "late" } }, { queryClient: h.client }))
    expect(h.result.current.output).toBeUndefined()
    h.rerender({ botId: "b1", machineId: "m1", online: true })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3))
    expect(JSON.parse(apiFetch.mock.calls[2][1].body).operation).toEqual({ action: "list" })
  })

  it("times out a preview without locking configuration or exposing an old result", async () => {
    const h = mount()
    await h.reply(h.state()!.requestId)
    await waitFor(() => expect(h.result.current.snapshot).toEqual(snapshot))
    vi.useFakeTimers()
    try {
      let run: Promise<boolean>
      act(() => { run = h.result.current.preview("sample") })
      await act(async () => { await vi.advanceTimersByTimeAsync(45_001); expect(await run!).toBe(false) })
      expect(h.result.current.previewError).toMatch(/timed out/)
      expect(h.result.current.output).toBeUndefined()
      expect(h.result.current.unavailable).toBeUndefined()
    } finally { vi.useRealTimers() }
  })
})


describe("PII failure recovery", () => {
  it("rejects callbacks from a retired bot view and ignores its late request failure", async () => {
    let reject!: (error: Error) => void
    apiFetch.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const h = mount()
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
    const reload = h.result.current.reload
    h.rerender({ botId: "b2", machineId: "m2", online: true })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))
    await act(async () => {
      expect(await reload()).toBe(false)
      reject(new Error("NETWORK_ERROR"))
    })
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(h.state()).toBeUndefined()
    expect(h.state("b2", "m2")?.status).toBe("pending")
    expect(h.result.current.error).toBeUndefined()
  })

  it.each([
    [new Error("MACHINE_OFFLINE"), "This machine is offline. Reconnect and reload filters."],
    ["network rejected", "Could not load filters. Reload to try again."],
  ])("keeps failed loading retryable for %s", async (failure, message) => {
    apiFetch.mockRejectedValueOnce(failure)
    const h = mount()
    await waitFor(() => expect(h.result.current.error).toBe(message))
    expect(h.result.current.snapshot).toBeUndefined()
    await act(async () => { expect(await h.result.current.remove("email")).toBe(false) })
    act(() => { void h.result.current.reload() })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))
    await h.reply(h.state()!.requestId)
    await waitFor(() => expect(h.result.current.snapshot).toEqual(snapshot))
    expect(h.result.current.error).toBeUndefined()
  })

  it.each(["list", "remove"] as const)("requires reload after a %s timeout", async (action) => {
    const h = mount()
    await h.reply(h.state()!.requestId)
    await waitFor(() => expect(h.result.current.snapshot).toEqual(snapshot))
    vi.useFakeTimers()
    try {
      let run!: Promise<boolean>
      act(() => { run = action === "list" ? h.result.current.reload() : h.result.current.remove("email") })
      const id = h.state()!.requestId
      await act(async () => { await vi.advanceTimersByTimeAsync(45_001); expect(await run).toBe(false) })
      expect(h.result.current.error).toBe(action === "list"
        ? "Could not load filters. Reload to try again."
        : "Could not confirm the change. Reload filters before making another change.")
      expect(h.result.current.unavailable).toBe(action === "list" ? undefined : "Reload filters to check the current state.")
      await h.reply(id)
      expect(h.state()?.status).toBe("error")
      expect(h.result.current.snapshot).toEqual(snapshot)
      if (action === "remove") await act(async () => { expect(await h.result.current.remove("email")).toBe(false) })
    } finally { vi.useRealTimers() }
  })

  it("blocks management while the connection is lost and reloads on reconnect", async () => {
    const h = mount()
    await h.reply(h.state()!.requestId)
    await waitFor(() => expect(h.result.current.snapshot).toEqual(snapshot))
    const ws = getCommunityDbRegistry(h.client)!.runtime.ws
    act(() => ws.setState(state => ({ ...state, connectionStatus: "reconnecting" })))
    await waitFor(() => expect(h.result.current.unavailable).toBe("Connection lost. Reconnect to manage filters."))
    await act(async () => { expect(await h.result.current.reload()).toBe(false) })
    expect(apiFetch).toHaveBeenCalledTimes(1)
    act(() => ws.setState(state => ({ ...state, connectionStatus: "connected" })))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))
    await h.reply(h.state()!.requestId)
    await waitFor(() => expect(h.result.current.unavailable).toBeUndefined())
  })

  it.each(["PII_PLUGIN_NOT_FOUND", "PII_PLUGIN_FAILED"] as const)("reports %s without claiming a mutation succeeded", async (code) => {
    const h = mount()
    await h.reply(h.state()!.requestId)
    await waitFor(() => expect(h.result.current.snapshot).toEqual(snapshot))
    let run!: Promise<boolean>
    act(() => { run = h.result.current.remove("email") })
    await act(async () => {
      handleBotPii({ botId: "b1", machineId: "m1", requestId: h.state()!.requestId, result: { status: "error", code } }, { queryClient: h.client })
      expect(await run).toBe(false)
    })
    await waitFor(() => expect(h.result.current.error).toBe(code === "PII_PLUGIN_NOT_FOUND"
      ? "This plugin was removed. Reload filters."
      : "Filters are unavailable. Reload to try again."))
    expect(h.result.current.snapshot).toEqual(snapshot)
    expect(h.result.current.unavailable).toMatch(/Reload filters/)
  })

  it.each(["request", "missing output"])("allows preview retry after %s failure", async (failure) => {
    const h = mount()
    await h.reply(h.state()!.requestId)
    await waitFor(() => expect(h.result.current.snapshot).toEqual(snapshot))
    if (failure === "request") apiFetch.mockRejectedValueOnce(new Error("NETWORK_ERROR"))
    let run!: Promise<boolean>
    act(() => { run = h.result.current.preview("sample") })
    if (failure === "missing output") await h.reply(h.state()!.requestId)
    await act(async () => { expect(await run).toBe(false) })
    await waitFor(() => expect(h.result.current.previewError).toBe(failure === "request"
      ? "Could not run the test. Try again."
      : "Could not read the test result. Run it again."))
    expect(h.result.current.output).toBeUndefined()
    expect(h.result.current.unavailable).toBeUndefined()
    act(() => { void h.result.current.preview("retry") })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3))
  })
})
