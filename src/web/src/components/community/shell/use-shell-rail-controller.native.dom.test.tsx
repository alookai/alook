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
import { useCommunityNavigationController, type CommunityNavigationController } from "./use-community-navigation-controller"
import { normalizeCommunityHref } from "@/lib/community/community-route"
const api = vi.hoisted(() => vi.fn())
const route = vi.hoisted(() => ({ pathname: "/c/channels/s1", revision: 0 }))
const ui = vi.hoisted(() => ({ toast: vi.fn(), error: vi.fn(), push: vi.fn(), replace: vi.fn(), queuedError: vi.fn() }))
vi.mock("sonner", () => ({ toast: Object.assign(ui.toast, { error: ui.error }) }))
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>()
  return { ...actual, apiFetch: api, toastApiError: (...args: Parameters<typeof actual.toastApiError>) => { actual.toastApiError(...args); ui.queuedError() } }
})
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: "A" } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname, useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn(), push: ui.push, replace: ui.replace }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/hooks/community/mutations", async () => await import("@/hooks/community/mutations/servers"))
let controller: ReturnType<typeof useShellRailController>, client: QueryClient
let navigation: CommunityNavigationController
function Probe() {
  const currentClient = useQueryClient()
  const currentNavigation = useCommunityNavigationController({ ...normalizeCommunityHref(route.pathname), revision: route.revision })
  const current = useShellRailController({ navigation: currentNavigation, queryClient: currentClient, breakpoint: "desktop", view: "server", activeServerId: "s1", projectedActiveServerId: "s1", accountId: "A" })
  useLayoutEffect(() => { client = currentClient; controller = current; navigation = currentNavigation })
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
beforeEach(async () => { await clearAllPersistedCaches(); api.mockReset(); Object.values(ui).forEach((fn) => fn.mockReset()); route.pathname = "/c/channels/s1"; route.revision = 0 })
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
  it.each(["new-pending", "scope-return"] as const)("retires late create UI on %s while keeping its original account operation", async (change) => {
    const { view, resolve, original } = await mount()
    let result!: Promise<unknown>
    act(() => { result = controller.railProps.onCreateServer("New", new File(["x"], "icon.png")) })
    await waitFor(() => expect(api.mock.calls.some(([, options]) => options.method === "POST")).toBe(true))
    if (change === "new-pending") act(() => navigation.push("/c/channels/s2"))
    else {
      route.pathname = "/c/me/friends"; route.revision = 1
      view.rerender(<Root />)
      route.pathname = "/c/channels/s1"; route.revision = 2
      view.rerender(<Root />)
    }
    await act(async () => { resolve({ server: { id: "created" } }); await result })
    expect(getCommunityDbRegistry(original)!.runtime.lifecycle.get().active).toBe(true)
    expect(api.mock.calls.some(([path]) => path.endsWith("/icon"))).toBe(false)
    expect(ui.push).not.toHaveBeenCalledWith("/c/channels/created")
    expect(ui.toast).not.toHaveBeenCalled()
    expect(ui.error).not.toHaveBeenCalled()
    if (change === "new-pending") expect(navigation.pendingHref).toBe("/c/channels/s2")
  })
  it("rechecks the original rail intent after a failure is queued for deferred display", async () => {
    const { reject } = await mount()
    let result!: Promise<unknown>
    act(() => { result = controller.railProps.onCreateServer("New") })
    await waitFor(() => expect(api.mock.calls.some(([, options]) => options.method === "POST")).toBe(true))
    ui.queuedError.mockImplementation(() => navigation.push("/c/channels/s2"))
    await act(async () => { reject(new Error("late failure")); await result })
    expect(ui.queuedError).toHaveBeenCalled()
    expect(navigation.pendingHref).toBe("/c/channels/s2")
    expect(ui.error).not.toHaveBeenCalled()
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
    act(() => { navigation.push("/c/channels/s2"); view.rerender(<Root />) })
    await act(async () => resolve(undefined))
    await waitFor(() => expect(api.mock.calls.some(([path]) => path.endsWith("/leave"))).toBe(true))
    expect(ui.toast).not.toHaveBeenCalled()
    expect(navigation.pendingHref).toBe("/c/channels/s2")
    expect(ui.replace).not.toHaveBeenCalled()
  })
})
