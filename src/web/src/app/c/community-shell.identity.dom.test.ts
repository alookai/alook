import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { useQueryClient } from "@tanstack/react-query"
import { getCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { useCommunityWsStore } from "@/stores/community/ws"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { communityKeys } from "@/lib/query-keys"

const fixtures = vi.hoisted(() => ({
  user: { id: "user-a", name: "A", email: "a@example.test", avatar: "A" },
  fetch: vi.fn(), notifications: vi.fn(),
}))
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: fixtures.user }, isPending: false }),
  currentSessionViewer: () => fixtures.user.id,
}))
vi.mock("next/navigation", () => ({ usePathname: () => "/c/me", useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/hooks/community/use-community-ws", () => ({ useCommunityWs: vi.fn() }))
vi.mock("@/hooks/community/use-notification-settings", () => ({ useNotificationSettings: fixtures.notifications }))
vi.mock("@/hooks/community/use-account-attention", () => ({ useAccountAttention: vi.fn() }))
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
const self = (id: string) => ({ id, name: "Jane Roe", discriminator: "4242", aboutMe: "hello", avatar: "new-avatar", avatarVersion: 3, statusEmoji: null, statusText: "" })
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
  await clearAllPersistedCaches()
  fixtures.user = { id: "user-a", name: "A", email: "a@example.test", avatar: "A" }
  fixtures.fetch.mockReset().mockImplementation(() => Promise.resolve(self(fixtures.user.id)))
  fixtures.notifications.mockClear()
  registries.clear(); seen.length = 0
})

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
      await waitFor(() => expect(fixtures.fetch).toHaveBeenCalledOnce())
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
    fixtures.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const view = render(tree())
    await waitFor(() => expect(fixtures.fetch).toHaveBeenCalledOnce())
    const original = registries.get("user-a")!
    const signal = fixtures.fetch.mock.calls[0][1].signal as AbortSignal
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
