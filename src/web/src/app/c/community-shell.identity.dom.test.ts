import "fake-indexeddb/auto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import { act, fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { dehydrate, QueryClient, useQueryClient } from "@tanstack/react-query"
import { getCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { useCommunityWsStore } from "@/stores/community/ws"
import { clearAllPersistedCaches, createIdbPersister, PERSIST_BUSTER } from "@/lib/query-persister"
import { communityKeys } from "@/lib/query-keys"

const fixtures = vi.hoisted(() => ({
  user: { id: "user-a", name: "A", email: "a@example.test", avatar: "A" },
  fetch: vi.fn(), notifications: vi.fn(), ws: vi.fn(), attention: vi.fn(), projectionError: false,
}))
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: fixtures.user }, isPending: false }),
  currentSessionViewer: () => fixtures.user.id,
}))
vi.mock("next/navigation", () => ({ usePathname: () => "/c/me", useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/hooks/community/use-community-ws", () => ({ useCommunityWs: fixtures.ws }))
vi.mock("@/hooks/community/use-notification-settings", () => ({ useNotificationSettings: () => {
  fixtures.notifications()
  const registry = getCommunityDbRegistry(useQueryClient())!
  registries.set(registry.accountId!, registry)
} }))
vi.mock("@/lib/community-db/projections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/community-db/projections")>()
  return { ...actual, useCanonicalProfilesProjection: (...args: Parameters<typeof actual.useCanonicalProfilesProjection>) => {
    const result = actual.useCanonicalProfilesProjection(...args)
    return fixtures.projectionError ? { ...result, isReady: false, isError: true } : result
  } }
})
vi.mock("@/hooks/community/use-account-attention", () => ({ useAccountAttention: fixtures.attention }))
vi.mock("@/hooks/community/use-native-system-notifications", () => ({ useNativeSystemNotifications: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => fixtures.fetch(...args) }))
vi.mock("@/components/perf/perf-trace-bootstrap", () => ({ PerfTraceBootstrap: () => null }))
vi.mock("@/components/community/onboarding/community-onboarding-form", () => ({ CommunityOnboardingForm: () => null }))
vi.mock("@/components/community/shell/community-ws-reconnect-overlay", () => ({ CommunityWsReconnectBoundary: ({ children }: { children: React.ReactNode }) => children }))
vi.mock("@/components/community/shell/community-restore-bootstrap", () => ({ CommunityRestoreBoundary: ({ children }: { children: React.ReactNode }) => children }))
vi.mock("@/components/community/shell/owner-server-delete-route-guard", () => ({ OwnerServerDeleteRouteGuard: () => null }))
import { CommunityShell } from "./community-shell"

const registries = new Map<string, CommunityDbRegistry>()
const seen: Array<{ viewer: string | null; presence: string[] }> = []
const selfProfileCalls = () => fixtures.fetch.mock.calls.filter(([path]) => path === "/api/community/users/me/profile")
const self = (id: string) => ({ id, name: "Jane Roe", discriminator: "4242", aboutMe: "hello", bannerColor: null, avatar: "new-avatar", avatarVersion: 3, statusEmoji: null, statusText: "" })
function Probe() {
  const client = useQueryClient()
  const registry = getCommunityDbRegistry(client)!
  registries.set(registry.accountId!, registry)
  const viewer = useCommunityWsStore((state) => state.profileViewerId)
  const presence = useCommunityWsStore((state) => state.presenceByUserId)
  seen.push({ viewer, presence: [...presence.keys()] })
  return React.createElement("span", null, "content")
}
const tree = () => React.createElement(CommunityShell, { currentUser: fixtures.user }, React.createElement(Probe))
beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => true,
  }))
  await clearAllPersistedCaches()
  fixtures.user = { id: "user-a", name: "A", email: "a@example.test", avatar: "A" }
  fixtures.fetch.mockReset().mockImplementation((path: string) => {
    if (path === "/api/community/users/me/profile") return Promise.resolve(self(fixtures.user.id))
    if (path === "/api/community/users/me/read-state") return Promise.resolve({ revision: 0, readStates: [] })
    throw new Error(`Unexpected bootstrap endpoint: ${path}`)
  })
  fixtures.notifications.mockClear()
  fixtures.projectionError = false
  fixtures.ws.mockClear()
  fixtures.attention.mockClear()
  registries.clear(); seen.length = 0
})
afterEach(() => { vi.unstubAllGlobals() })

describe("CommunityShell actual identity and bootstrap boundary", () => {
  it("remounts the native query boundary when the signed-in user changes", async () => {
    const view = render(tree())
    await waitFor(() => expect(registries.has("user-a")).toBe(true))
    const original = registries.get("user-a")!
    fixtures.user = { id: "user-b", name: "B", email: "b@example.test", avatar: "B" }
    view.rerender(tree())
    await waitFor(() => expect(registries.has("user-b")).toBe(true))
    expect(registries.get("user-b")!.queryClient).not.toBe(original.queryClient)
    await waitFor(() => expect(original.runtime.lifecycle.get().active).toBe(false))
  })

  it("never mounts B against A's profile presence", async () => {
    const view = render(tree())
    await waitFor(() => expect(registries.has("user-a")).toBe(true))
    act(() => registries.get("user-a")!.runtime.ws.actions.setPresence("user-a", "online"))
    seen.length = 0
    fixtures.user = { id: "user-b", name: "B", email: "b@example.test", avatar: "B" }
    view.rerender(tree())
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen.every((row) => row.viewer === "user-b" && row.presence.length === 0)).toBe(true)
  })

  it("deduplicates self-profile bootstrap under StrictMode without a render-phase update", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      render(React.createElement(React.StrictMode, null, tree()))
      await waitFor(() => expect(selfProfileCalls()).toHaveLength(1))
      await waitFor(() => expect(registries.get("user-a")!.collections.profiles.get("user-a")?.aboutMe).toBe("hello"))
      expect(report.mock.calls.flat().join("\n")).not.toMatch(/Cannot update a component|while rendering a different component/)
    } finally { report.mockRestore() }
  })

  it("loads self-profile fields into canonical DB while Query retains only the ID", async () => {
    render(tree())
    await waitFor(() => expect(registries.get("user-a")?.collections.profiles.get("user-a")?.avatarVersion).toBe(3))
    const registry = registries.get("user-a")!
    expect(registry.collections.profiles.get("user-a")).toMatchObject({ name: "Jane Roe", discriminator: "4242", aboutMe: "hello", avatar: "new-avatar", avatarVersion: 3, statusEmoji: null, statusText: "" })
    expect(registry.queryClient.getQueryData(communityKeys.selfProfile())).toEqual({ id: "user-a" })
    expect(fixtures.fetch).toHaveBeenCalledWith("/api/community/users/me/profile", expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "user-a" }))
  })

  it("hydrates notification policy at the community root", async () => {
    render(tree())
    await waitFor(() => expect(fixtures.notifications).toHaveBeenCalled())
    expect(registries.get("user-a")).toBeDefined()
  })

  it("physically cancels A's held self-profile and rejects its late payload after B mounts", async () => {
    let finish!: (data: ReturnType<typeof self>) => void
    const normal = fixtures.fetch.getMockImplementation()!
    fixtures.fetch.mockImplementation((path: string, options: { authenticationAccount?: string }) => path === "/api/community/users/me/profile" && options.authenticationAccount === "user-a"
      ? new Promise((resolve) => { finish = resolve }) : normal(path, options))
    const view = render(tree())
    await waitFor(() => expect(selfProfileCalls()).toHaveLength(1))
    const original = registries.get("user-a")!
    const signal = selfProfileCalls()[0][1].signal as AbortSignal
    fixtures.user = { id: "user-b", name: "B", email: "b@example.test", avatar: "B" }
    view.rerender(tree())
    await waitFor(() => expect(signal.aborted).toBe(true))
    await waitFor(() => expect(registries.get("user-b")?.collections.profiles.get("user-b")?.aboutMe).toBe("hello"))
    await act(async () => { finish({ ...self("user-a"), aboutMe: "stale A" }); await Promise.resolve() })
    const current = registries.get("user-b")!
    expect(current.collections.profiles.get("user-b")?.aboutMe).toBe("hello")
    expect(current.collections.profiles.get("user-a")).toBeUndefined()
    await waitFor(() => expect(original.queryClient.getQueryCache().getAll()).toHaveLength(0))
  })
})

it.each(["missing-core", "wrong-self"])("refuses a warm complete self %s before any canonical write", async defect => {
  const { communityRegistrySnapshot } = await import("@/test/community-registry-snapshot")
  render(tree())
  await waitFor(() => expect(registries.get("user-a")?.collections.profiles.get("user-a")?.avatarVersion).toBe(3))
  const registry = registries.get("user-a")!
  const before = communityRegistrySnapshot(registry)
  const malformed: Record<string, unknown> = { ...self("user-a"), name: "Must not publish" }
  if (defect === "missing-core") delete malformed.avatarVersion
  if (defect === "wrong-self") malformed.id = "foreign-self"
  const original = fixtures.fetch.getMockImplementation()!
  fixtures.fetch.mockImplementation((path: string, options: unknown) => path === "/api/community/users/me/profile" ? Promise.resolve(malformed) : original(path, options))
  const query = registry.queryClient.getQueryCache().find({ queryKey: communityKeys.selfProfile(), exact: true })!
  await expect(registry.queryClient.query({ ...query.options, queryKey: communityKeys.selfProfile(), staleTime: 0 })).rejects.toThrow()
  expect(communityRegistrySnapshot(registry)).toEqual(before)
})


it("mounts the first full-user consumer only after native full self publication", async () => {
  const { useCurrentUser } = await import("@/contexts/community/current-user")
  let release!: (value: ReturnType<typeof self>) => void
  const held = new Promise<ReturnType<typeof self>>(resolve => { release = resolve })
  const normal = fixtures.fetch.getMockImplementation()!
  fixtures.fetch.mockImplementation((path: string, options: unknown) => path === "/api/community/users/me/profile" ? held : normal(path, options))
  const names: string[] = []
  function FullUserChild() {
    const user = useCurrentUser()
    names.push(user.name)
    return React.createElement("span", { "data-testid": "full-user-child" }, user.name)
  }
  const view = render(React.createElement(CommunityShell, { currentUser: fixtures.user }, React.createElement(FullUserChild)))
  await waitFor(() => expect(selfProfileCalls()).toHaveLength(1))
  expect(fixtures.notifications).toHaveBeenCalled()
  expect(fixtures.attention).toHaveBeenCalled()
  expect(fixtures.ws).toHaveBeenCalledWith({ viewerUserId: "user-a" })
  await waitFor(() => expect(fixtures.fetch.mock.calls.some(([path]) => path === "/api/community/users/me/read-state")).toBe(true))
  expect(view.queryByTestId("full-user-child")).toBeNull()
  act(() => registries.get("user-a")!.runtime.ws.actions.setPresence("user-a", "online"))
  expect(view.queryByTestId("full-user-child")).toBeNull()
  await act(async () => { release(self(fixtures.user.id)) })
  await waitFor(() => expect(view.getByTestId("full-user-child").textContent).toBe("Jane Roe"))
  expect(names.length).toBeGreaterThan(0)
  expect(names.every(name => name === "Jane Roe")).toBe(true)
})

it("admits required legitimate null self fields without inventing identity values", async () => {
  const { useCurrentUser } = await import("@/contexts/community/current-user")
  const profile = { ...self("user-a"), avatar: null, bannerColor: null, statusEmoji: null, statusText: null }
  const normal = fixtures.fetch.getMockImplementation()!
  fixtures.fetch.mockImplementation((path: string, options: unknown) => path === "/api/community/users/me/profile" ? Promise.resolve(profile) : normal(path, options))
  function Name() { return React.createElement("span", null, useCurrentUser().name) }
  const view = render(React.createElement(CommunityShell, { currentUser: fixtures.user }, React.createElement(Name)))
  await waitFor(() => expect(view.getByText("Jane Roe")).toBeDefined())
  expect(registries.get("user-a")!.collections.profiles.get("user-a")).toMatchObject(profile)
})

it("keeps the full warm UI during held and failed background refresh", async () => {
  const view = render(tree())
  await waitFor(() => expect(view.getByText("content")).toBeDefined())
  const registry = registries.get("user-a")!
  await waitFor(() => expect(registry.queryClient.getQueryState(communityKeys.selfProfile())?.status).toBe("success"))
  let reject!: (error: Error) => void
  const held = new Promise((_, fail) => { reject = fail })
  const normal = fixtures.fetch.getMockImplementation()!
  fixtures.fetch.mockImplementation((path: string, options: unknown) => path === "/api/community/users/me/profile" ? held : normal(path, options))
  act(() => { void registry.queryClient.invalidateQueries({ queryKey: communityKeys.selfProfile() }) })
  await waitFor(() => expect(selfProfileCalls()).toHaveLength(2))
  expect(view.getByText("content")).toBeDefined()
  await act(async () => { reject(new Error("background unavailable")) })
  await waitFor(() => expect(registry.queryClient.getQueryState(communityKeys.selfProfile())?.status).toBe("error"), { timeout: 5_000 })
  expect(view.getByText("content")).toBeDefined()
  expect(view.queryByRole("alert")).toBeNull()
})

it("rereads a fresh cached ID if its full canonical self resource is absent", async () => {
  const { writeCommunityCollectionRows } = await import("@/lib/community-db/write")
  const view = render(tree())
  await waitFor(() => expect(view.getByText("content")).toBeDefined())
  const registry = registries.get("user-a")!
  let release!: (value: ReturnType<typeof self>) => void
  const held = new Promise<ReturnType<typeof self>>(resolve => { release = resolve })
  const normal = fixtures.fetch.getMockImplementation()!
  fixtures.fetch.mockImplementation((path: string, options: unknown) => path === "/api/community/users/me/profile" ? held : normal(path, options))
  await act(async () => { await writeCommunityCollectionRows(registry, "profiles", [], row => row.id) })
  expect(registry.queryClient.getQueryData(communityKeys.selfProfile())).toEqual({ id: "user-a" })
  await waitFor(() => expect(selfProfileCalls()).toHaveLength(2))
  expect(view.queryByText("content")).toBeNull()
  await act(async () => { release(self("user-a")) })
  await waitFor(() => expect(view.getByText("content")).toBeDefined())
  expect(selfProfileCalls()).toHaveLength(2)
})

it.each(["read-error", "malformed"])("offers retry without mounting missing-self UI on %s", async defect => {
  const normal = fixtures.fetch.getMockImplementation()!
  fixtures.fetch.mockImplementation((path: string, options: unknown) => path === "/api/community/users/me/profile"
    ? defect === "read-error" ? Promise.reject(new Error("self unavailable")) : Promise.resolve({ ...self("user-a"), avatarVersion: undefined })
    : normal(path, options))
  const view = render(tree())
  await waitFor(() => expect(selfProfileCalls()).toHaveLength(2), { timeout: 5_000 })
  const retry = await waitFor(() => view.getByRole("button", { name: "Try again" }), { timeout: 5_000 })
  expect(view.queryByText("content")).toBeNull()
  expect(view.getByRole("alert").textContent).toContain("Could not load your profile")
  expect(registries.get("user-a")!.collections.profiles.get("user-a")).toBeUndefined()
  fixtures.fetch.mockImplementation(normal)
  fireEvent.click(retry)
  await waitFor(() => expect(view.getByText("content")).toBeDefined())
  expect(selfProfileCalls()).toHaveLength(3)
})

it("offers a reload exit for a reported native self projection failure", async () => {
  fixtures.projectionError = true
  const view = render(tree())
  await waitFor(() => expect(registries.get("user-a")?.collections.profiles.get("user-a")?.avatarVersion).toBe(3))
  expect(view.queryByText("content")).toBeNull()
  const reload = vi.fn()
  const browserWindow = window
  vi.stubGlobal("window", new Proxy(browserWindow, { get: (target, key) => key === "location" ? { reload } : Reflect.get(target, key) }))
  fireEvent.click(view.getByRole("button", { name: "Reload" }))
  expect(reload).toHaveBeenCalledOnce()
  vi.stubGlobal("window", browserWindow)
  expect(view.getByRole("alert").textContent).toContain("Could not load your profile")
})


it.each([true, false])("uses restored full self immediately but waits for absent self fields (%s)", async complete => {
  const { useCurrentUser } = await import("@/contexts/community/current-user")
  const client = new QueryClient()
  const profile = self("user-a")
  client.setQueryData(communityKeys.communityDbCollection("user-a", "profiles"), complete ? [profile] : [{ id: profile.id, name: profile.name, discriminator: profile.discriminator, avatar: profile.avatar, avatarVersion: profile.avatarVersion }])
  const persister = createIdbPersister("user-a")
  await persister.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(client) })
  await waitFor(async () => expect((await persister.restoreClient())?.clientState.queries).toHaveLength(1))
  let release!: (value: ReturnType<typeof self>) => void
  const held = new Promise<ReturnType<typeof self>>(resolve => { release = resolve })
  const normal = fixtures.fetch.getMockImplementation()!
  fixtures.fetch.mockImplementation((path: string, options: unknown) => path === "/api/community/users/me/profile" ? held : normal(path, options))
  const names: string[] = []
  function Name() {
    const user = useCurrentUser()
    names.push(user.name)
    return React.createElement("span", { "data-testid": "restored-user" }, user.name)
  }
  const view = render(React.createElement(CommunityShell, { currentUser: fixtures.user }, React.createElement(Name)))
  await waitFor(() => expect(selfProfileCalls()).toHaveLength(1))
  if (complete) await waitFor(() => expect(view.getByTestId("restored-user").textContent).toBe("Jane Roe"))
  else expect(view.queryByTestId("restored-user")).toBeNull()
  await act(async () => { release(profile) })
  await waitFor(() => expect(view.getByTestId("restored-user").textContent).toBe("Jane Roe"))
  expect(names.every(name => name === "Jane Roe")).toBe(true)
  expect(selfProfileCalls()).toHaveLength(1)
  client.clear()
})
