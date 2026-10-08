import { useLayoutEffect, useMemo } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, waitFor, within } from "@/test/react-dom-harness"
import { QueryProvider } from "@/app/c/QueryProvider"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useShellRailController } from "./use-shell-rail-controller"
import { useCommunityNavigationController, type CommunityNavigationController } from "./use-community-navigation-controller"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { createOwnerServerDeleteRouteToken } from "@/lib/community/eject-server"
import { getCommunityRuntime } from "@/stores/community/runtime"
import { CommunityRouteContext } from "./community-route-context"
import { ServerSidebarSlot } from "./server-sidebar-slot"
import { ServerRail } from "./server-rail"
import { tid } from "@/lib/community/testids"
import { evictServerChannelScopes } from "@/hooks/community/community-ws/scope-eviction"
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
vi.mock("@/contexts/community/current-user", () => ({ useCurrentUser: () => ({ id: "A" }) }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("@/hooks/community/use-servers", async (original) => ({
  ...await original<typeof import("@/hooks/community/use-servers")>(),
  useServer: (id: string | null) => ({ server: id ? { id, name: id, categories: [] } : null, data: undefined }),
}))
vi.mock("@/hooks/community/use-server-members", () => ({ useServerMembers: () => ({ members: [] }) }))
vi.mock("@/hooks/community/use-server-panels", async (original) => ({ ...await original<typeof import("@/hooks/community/use-server-panels")>(), usePresence: () => undefined }))
vi.mock("@/hooks/community/use-forum-sidebar-threads", async (original) => ({
  ...await original<typeof import("@/hooks/community/use-forum-sidebar-threads")>(),
  useForumSidebarThreads: () => ({ threads: [], parentUnread: {}, projectionReady: true }),
}))
vi.mock("@/hooks/community/use-notification-settings", async (original) => ({
  ...await original<typeof import("@/hooks/community/use-notification-settings")>(),
  useNotificationSettings: () => ({ server: {}, channel: {} }),
}))
vi.mock("@/components/community/channels/channel-sidebar-tree-owner", () => ({ ChannelSidebarRevealBoundary: () => <aside /> }))
vi.mock("@/components/community/settings/server-settings", () => ({ ServerSettings: () => null }))
let controller: ReturnType<typeof useShellRailController>, client: QueryClient
let navigation: CommunityNavigationController
let railStyles: HTMLStyleElement
function Probe({ sidebar = false }: { sidebar?: boolean }) {
  const currentClient = useQueryClient()
  const frame = { ...normalizeCommunityHref(route.pathname), revision: route.revision }
  const serverId = frame.scope.kind === "server" ? frame.scope.serverId : "s1"
  const currentNavigation = useCommunityNavigationController(frame)
  const ownerDeleteRouteScope = useMemo(() => ({ serverId, token: createOwnerServerDeleteRouteToken(currentClient) }), [currentClient, serverId])
  const current = useShellRailController({ navigation: currentNavigation, queryClient: currentClient, breakpoint: "desktop", view: "server", activeServerId: "s1", projectedActiveServerId: "s1", accountId: "A" })
  useLayoutEffect(() => {
    client = currentClient; controller = current; navigation = currentNavigation
    if (sidebar) getCommunityRuntime(currentClient).ui.actions.registerUiHandlers({ cancelPendingNavigation: currentNavigation.cancelPendingNavigation })
  })
  return sidebar ? <CommunityRouteContext value={{ frame, navigation: currentNavigation, ownerDeleteRouteScope }}><ServerRail {...current.railProps} bottomInset={60} /><ServerSidebarSlot serverId={serverId} /></CommunityRouteContext> : null
}
function Root({ visible = true, sidebar = false }: { visible?: boolean; sidebar?: boolean }) { return <QueryProvider userId="A">{visible && <Probe sidebar={sidebar} />}</QueryProvider> }
async function mount(sidebar = false) {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void
  const held = new Promise<unknown>((done, fail) => { resolve = done; reject = fail })
  const seen = new Set<string>()
  api.mockImplementation((path: string, options: { method?: string; signal?: AbortSignal }) => {
    if (options.method === "POST" && path.endsWith("/icon")) return Promise.resolve({ url: "/icons/new.png" })
    if (options.method === "POST") return held
    if (seen.has(path)) return new Promise((_, fail) => options.signal?.addEventListener("abort", () => fail(new DOMException("cancelled", "AbortError")), { once: true }))
    seen.add(path)
    return Promise.resolve(path.endsWith("server-folders") ? { folders: [] } : { servers: [{ id: "s1", name: "One", discriminator: "0001", icon: null, ownerId: sidebar ? "other-owner" : "A", role: sidebar ? "member" : "owner" }, ...(sidebar ? [{ id: "s2", name: "Two", discriminator: "0002", icon: null, ownerId: "other-owner", role: "member" }] : [])] })
  })
  const view = render(<Root sidebar={sidebar} />)
  await waitFor(() => expect(controller.railProps.servers).toHaveLength(sidebar ? 2 : 1))
  return { view, resolve, reject, original: client }
}
beforeEach(async () => {
  await clearAllPersistedCaches(); api.mockReset(); Object.values(ui).forEach((fn) => fn.mockReset())
  route.pathname = "/c/channels/s1"; route.revision = 0; window.history.replaceState(null, "", route.pathname)
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("prefers-reduced-motion"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  railStyles = document.createElement("style")
  railStyles.textContent = `[data-testid="${tid.serverRailScroll}"].overflow-y-auto { overflow-y: auto; }`
  document.head.appendChild(railStyles)
})
afterEach(() => { railStyles.remove(); api.mockReset(); vi.unstubAllGlobals() })
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

  it.each(["/c/channels/s2", "/c/me/friends"])("mounted old sidebar preserves newer %s while the real leave retires its account scope", async (target) => {
    const { resolve, original } = await mount(true)
    act(() => controller.railProps.onLeaveServer!("s1"))
    await waitFor(() => expect(api.mock.calls.some(([path]) => path.endsWith("/leave"))).toBe(true))
    act(() => navigation.push(target))
    await act(async () => resolve(undefined))
    const registry = getCommunityDbRegistry(original)!
    await waitFor(() => expect(registry.runtime.ws.get().revokedServerIds.has("s1")).toBe(true))
    expect([...registry.collections.serverMemberships.values()].some((row) => row.serverId === "s1" && row.viewer)).toBe(false)
    expect([...registry.collections.serverMemberships.values()].some((row) => row.serverId === "s2" && row.viewer)).toBe(true)
    expect(navigation.pendingHref).toBe(target)
    expect(navigation.navigationPending).toBe(true)
    expect(ui.replace).not.toHaveBeenCalled()
    expect(ui.toast).not.toHaveBeenCalled()
  })

  it("real rail Leave dialog and destination click keep B pending after the old member leave succeeds", async () => {
    const { view, resolve } = await mount(true)
    fireEvent.contextMenu(view.getByTestId(tid.serverIcon("s1")))
    fireEvent.click(await view.findByRole("menuitem", { name: /^Leave server$/ }))
    const dialog = await view.findByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: /^Leave server$/ }))
    await waitFor(() => expect(api.mock.calls.some(([path]) => path.endsWith("/leave"))).toBe(true))
    fireEvent.click(view.getByTestId(tid.serverIcon("s2")))
    expect(navigation.pendingHref).toBe("/c/channels/s2")
    await act(async () => resolve(undefined))
    await waitFor(() => expect(getCommunityRuntime(client).ws.get().revokedServerIds.has("s1")).toBe(true))
    expect(view.queryByTestId(tid.serverIcon("s1"))).toBeNull()
    expect(view.getByTestId(tid.serverIcon("s2"))).toBeTruthy()
    expect(navigation.pendingHref).toBe("/c/channels/s2")
    expect(navigation.navigationPending).toBe(true)
    expect(ui.replace).not.toHaveBeenCalled()
  })

  it("mounted old sidebar preserves an unresolved newer intent and ejects if it is canceled", async () => {
    const { resolve } = await mount(true)
    act(() => controller.railProps.onLeaveServer!("s1"))
    await waitFor(() => expect(api.mock.calls.some(([path]) => path.endsWith("/leave"))).toBe(true))
    let finish!: (href: string) => void, operation!: Promise<boolean>
    act(() => { operation = navigation.resolveAndPush(() => new Promise<string>((done) => { finish = done })) })
    await act(async () => resolve(undefined))
    await waitFor(() => expect(getCommunityRuntime(client).ws.get().revokedServerIds.has("s1")).toBe(true))
    expect(navigation.navigationPending).toBe(true)
    expect(navigation.pendingHref).toBeNull()
    expect(ui.replace).not.toHaveBeenCalled()
    act(() => navigation.cancelPendingNavigation())
    await waitFor(() => expect(ui.replace).toHaveBeenCalledWith("/c/channels/s2"))
    await act(async () => { finish("/c/me/friends"); await operation })
    expect(ui.push).not.toHaveBeenCalledWith("/c/me/friends")
  })

  it.each([false, true])("mounted sidebar still ejects the revoked current scope with same-server pending=%s", async (sameServerPending) => {
    const { resolve } = await mount(true)
    act(() => controller.railProps.onLeaveServer!("s1"))
    await waitFor(() => expect(api.mock.calls.some(([path]) => path.endsWith("/leave"))).toBe(true))
    if (sameServerPending) act(() => navigation.push("/c/channels/s1/channel-2"))
    await act(async () => resolve(undefined))
    await waitFor(() => expect(ui.replace).toHaveBeenCalledWith("/c/channels/s2"))
    expect(navigation.pendingHref).not.toBe("/c/channels/s1/channel-2")
  })

  it("new destination sidebar ejects when its own server access is revoked", async () => {
    const { view, resolve } = await mount(true)
    act(() => controller.railProps.onLeaveServer!("s1"))
    await waitFor(() => expect(api.mock.calls.some(([path]) => path.endsWith("/leave"))).toBe(true))
    act(() => navigation.push("/c/channels/s2"))
    await act(async () => resolve(undefined))
    await waitFor(() => expect(getCommunityRuntime(client).ws.get().revokedServerIds.has("s1")).toBe(true))
    expect(ui.replace).not.toHaveBeenCalled()
    act(() => {
      route.pathname = "/c/channels/s2"; route.revision = 1
      window.history.replaceState(null, "", route.pathname)
      view.rerender(<Root sidebar />)
    })
    await waitFor(() => expect(navigation.navigationPending).toBe(false))
    act(() => { evictServerChannelScopes(client, "s2") })
    await waitFor(() => expect(ui.replace).toHaveBeenCalledWith("/c/me"))
    expect(getCommunityRuntime(client).ws.get().revokedServerIds.has("s2")).toBe(true)
  })
})

vi.mock("next/link", async () => ({ default: (await import("@/test/community-link-mock")).CommunityLinkMock }))
