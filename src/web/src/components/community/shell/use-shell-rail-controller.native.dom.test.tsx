import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { QueryProvider } from "@/app/c/QueryProvider"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useShellRailController } from "./use-shell-rail-controller"
import type { CommunityNavigationController } from "./use-community-navigation-controller"
const api = vi.hoisted(() => vi.fn())
const ui = vi.hoisted(() => ({ toast: vi.fn(), error: vi.fn(), push: vi.fn(), replace: vi.fn() }))
vi.mock("sonner", () => ({ toast: ui.toast }))
vi.mock("@/lib/api/client", () => ({ apiFetch: api, toastApiError: ui.error }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: "A" } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/hooks/community/mutations", async () => await import("@/hooks/community/mutations/servers"))
let controller: ReturnType<typeof useShellRailController>, client: QueryClient
const navigation: CommunityNavigationController = { publishedHref: "/c/channels/s1", navigationPending: false, pendingHref: null, push: ui.push, pushImmediate: ui.push, replace: ui.replace, resolveAndPush: vi.fn(), cancelPendingNavigation: vi.fn() }
function Probe() {
  const currentClient = useQueryClient()
  const current = useShellRailController({ navigation, queryClient: currentClient, breakpoint: "desktop", view: "server", activeServerId: "s1", projectedActiveServerId: "s1", accountId: "A" })
  useLayoutEffect(() => { client = currentClient; controller = current })
  return null
}
function Root({ visible = true }: { visible?: boolean }) { return <QueryProvider userId="A">{visible && <Probe />}</QueryProvider> }
async function mount() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void
  const held = new Promise<unknown>((done, fail) => { resolve = done; reject = fail })
  const seen = new Set<string>()
  api.mockImplementation((path: string, options: { method?: string; signal?: AbortSignal }) => {
    if (options.method === "POST" && path.endsWith("/icon")) return Promise.resolve({ url: "/icons/new.png" })
    if (options.method === "POST") return held
    if (seen.has(path)) return new Promise((_, fail) => options.signal?.addEventListener("abort", () => fail(new DOMException("cancelled", "AbortError")), { once: true }))
    seen.add(path)
    return Promise.resolve(path.endsWith("server-folders") ? { folders: [] } : { servers: [{ id: "s1", name: "One", discriminator: "0001", icon: null, ownerId: "A", role: "owner" }] })
  })
  const view = render(<Root />)
  await waitFor(() => expect(controller.railProps.servers).toHaveLength(1))
  return { view, resolve, reject, original: client }
}
beforeEach(async () => { await clearAllPersistedCaches(); api.mockReset(); Object.values(ui).forEach((fn) => fn.mockReset()); navigation.publishedHref = "/c/channels/s1"; navigation.pendingHref = null })
afterEach(() => api.mockReset())
describe("actual native Rail controller continuation", () => {
  it("current create continues icon upload and navigation through the original account", async () => {
    const { resolve } = await mount()
    let result!: Promise<unknown>; act(() => { result = controller.railProps.onCreateServer("New", new File(["x"], "icon.png")) })
    await waitFor(() => expect(api.mock.calls.some(([, options]) => options.method === "POST")).toBe(true))
    await act(async () => { resolve({ server: { id: "created" } }); await result })
    await waitFor(() => expect(api.mock.calls.some(([path]) => path === "/api/community/servers/created/icon")).toBe(true))
    expect(ui.push).toHaveBeenCalledWith("/c/channels/created")
    expect(ui.toast).toHaveBeenCalledWith('Server "New" created')
  })
  it.each(["success", "failure"] as const)("old UI create %s settles only its account operation without upload, toast or navigation", async (outcome) => {
    const { view, resolve, reject, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = controller.railProps.onCreateServer("New", new File(["x"], "icon.png")) })
    await waitFor(() => expect(api.mock.calls.some(([, options]) => options.method === "POST")).toBe(true))
    act(() => view.rerender(<Root visible={false} />))
    expect(getCommunityDbRegistry(original)!.runtime.lifecycle.get().active).toBe(true)
    await act(async () => { if (outcome === "success") resolve({ server: { id: "created" } }); else reject(new Error("denied")); await result })
    expect(api.mock.calls.some(([path]) => path.endsWith("/icon"))).toBe(false)
    expect(ui.push).not.toHaveBeenCalled(); expect(ui.toast).not.toHaveBeenCalled(); expect(ui.error).not.toHaveBeenCalled()
  })
  it("confirmed leave still navigates the original published route after native scope eviction clears its UI pointer", async () => {
    const { resolve } = await mount()
    act(() => controller.railProps.onLeaveServer!("s1"))
    await waitFor(() => expect(api.mock.calls.some(([path]) => path.endsWith("/leave"))).toBe(true))
    await act(async () => resolve(undefined))
    await waitFor(() => expect(ui.replace).toHaveBeenCalledWith("/c/me"))
  })
  it("confirmed leave does not redirect a newer navigation intent", async () => {
    const { view, resolve } = await mount()
    act(() => controller.railProps.onLeaveServer!("s1"))
    await waitFor(() => expect(api.mock.calls.some(([path]) => path.endsWith("/leave"))).toBe(true))
    act(() => { navigation.pendingHref = "/c/channels/s2"; view.rerender(<Root />) })
    await act(async () => resolve(undefined))
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Left server"))
    expect(ui.replace).not.toHaveBeenCalled()
  })
})
