import React from "react"
import { QueryClient } from "@tanstack/react-query"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useAutomation } from "./use-automation"

const mocks = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.api }))
const create = { kind: "create" as const, data: { name: "Script", expiresIn: "24h" as const, permissions: [{ permission: "bot.create" as const, limit: 64, period: "hour" as const }] } }
const response = { accessCode: { id: "code", name: "Script", prefix: "prefix", permissions: create.data.permissions, expiresAt: null, createdAt: "2026-01-01T00:00:00Z" }, secret: "synthetic-only-secret" }
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: React.ReactNode }) => <CommunityTestProvider client={client}>{children}</CommunityTestProvider>
  return { ...renderHook(() => useAutomation("owner"), { wrapper }), client }
}
beforeEach(() => { mocks.api.mockReset(); mocks.api.mockResolvedValue({ accessCodes: [] }) })
describe("Automation request ownership", () => {
  it("refreshes metadata after create without putting the secret in a query or mutation result", async () => {
    const view = setup()
    await waitFor(() => expect(view.result.current.list.isSuccess).toBe(true))
    const created = vi.fn()
    mocks.api.mockResolvedValueOnce(response).mockResolvedValue({ accessCodes: [response.accessCode] })
    await act(async () => { await view.result.current.execute(create, created) })
    expect(created).toHaveBeenCalledWith(response)
    await waitFor(() => expect(view.result.current.list.data?.accessCodes).toHaveLength(1))
    expect(JSON.stringify(view.client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(response.secret)
    expect(view.client.getMutationCache().getAll().every((mutation) => mutation.state.data === undefined)).toBe(true)
    view.unmount()
  })
  it("rejects a delayed creation response after leaving the panel", async () => {
    const view = setup()
    await waitFor(() => expect(view.result.current.list.isSuccess).toBe(true))
    let resolve!: (value: typeof response) => void
    mocks.api.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const created = vi.fn()
    let work!: Promise<unknown>
    await act(async () => { work = view.result.current.execute(create, created).catch((error: unknown) => error) })
    view.unmount()
    resolve(response)
    const error = await work
    expect(error).toMatchObject({ name: "AbortError" })
    expect(created).not.toHaveBeenCalled()
  })
  it("does not replay a failed POST or allow duplicate in-flight submissions", async () => {
    const view = setup()
    await waitFor(() => expect(view.result.current.list.isSuccess).toBe(true))
    let reject!: (reason: Error) => void
    mocks.api.mockReturnValueOnce(new Promise((_done, fail) => { reject = fail }))
    let first!: Promise<unknown>
    await act(async () => { first = view.result.current.execute(create).catch((error: unknown) => error) })
    await expect(view.result.current.execute(create)).rejects.toMatchObject({ name: "AbortError" })
    await act(async () => { reject(new Error("Network failed")); await first })
    expect(mocks.api.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1)
    view.unmount()
  })
  it("does not continue a callback saved from an unmounted account view", async () => {
    const view = setup()
    await waitFor(() => expect(view.result.current.list.isSuccess).toBe(true))
    const execute = view.result.current.execute
    const calls = mocks.api.mock.calls.length
    view.unmount()
    await expect(execute(create)).rejects.toMatchObject({ name: "AbortError" })
    expect(mocks.api).toHaveBeenCalledTimes(calls)
  })
})
