import React, { useState } from "react"
import { beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { createQueryClient } from "@/lib/query-client"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityTestProvider } from "@/test/community-owner-fixture"

const state = vi.hoisted(() => ({
  session: { data: null as { user: { id: string; email: string } } | null, isPending: true, error: null as Error | null, refetch: vi.fn() },
  invoke: vi.fn(), analytics: vi.fn(), replace: vi.fn(),
}))
vi.mock("@/lib/auth-session", () => ({ useSession: () => state.session, authClient: { signOut: vi.fn() } }))
vi.mock("next/navigation", () => ({ usePathname: () => "/c/me/machines", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: state.replace }), notFound: vi.fn() }))
vi.mock("@/components/community/shell/use-hydrated-client", () => ({ useHydratedClient: () => true }))
vi.mock("@/lib/persisted-account-identity", async original => ({ ...await original<typeof import("@/lib/persisted-account-identity")>(), capturePersistedAccountIdentity: async () => ({ id: "cached-a" }) }))
vi.mock("@/lib/query-persister", async original => ({ ...await original<typeof import("@/lib/query-persister")>(), readPersistedAccountIdentity: async () => ({ id: "cached-a", email: "a@example.test" }) }))
vi.mock("@/components/community/shell/community-account-pending-frame", () => ({ CommunityAccountPendingFrame: () => <div>Loading</div> }))
vi.mock("@/components/authenticated-context-menu-boundary", () => ({ AuthenticatedContextMenuBoundary: ({ children }: React.PropsWithChildren) => children }))
vi.mock("@/app/c/community-shell", () => ({ CommunityShell: CachedShell }))
vi.mock("@/components/community/shell/community-route-frame", () => ({ CommunityRouteFrame: () => null }))
vi.mock("@/lib/product-analytics", () => ({ captureProductAnalytics: (...args: unknown[]) => state.analytics(...args) }))
vi.mock("@/lib/analytics", () => ({ trackCommunityOnboardingStarted: vi.fn() }))
vi.mock("@alook/shared", async original => ({ ...await original<typeof import("@alook/shared")>(), isTauri: () => true, isDesktop: () => true, tauriInvoke: (...args: unknown[]) => state.invoke(...args) }))

import { CommunityLayoutClient } from "./community-layout-client"
import { CommunityAuthenticatedEntry } from "./community-authenticated-entry"
const registries = new Map<string, CommunityDbRegistry>()
function CachedShell({ children, currentUser }: React.PropsWithChildren<{ currentUser: { id: string } }>) {
  const [client] = useState(createQueryClient)
  const [registry] = useState(() => createCommunityDbRegistry(client, currentUser.id))
  registries.set(currentUser.id, registry)
  return <CommunityTestProvider client={client} registry={registry}><output>{currentUser.id}</output><input aria-label="Draft" />{children}</CommunityTestProvider>
}
const nativeCancels = () => state.invoke.mock.calls.filter(([command]) => command === "native_oauth_cancel")
function cookies() { document.cookie = "is_sign_in=google; path=/"; document.cookie = "is_new_signup=google; path=/" }
function confirm(id: string) { state.session = { ...state.session, data: { user: { id, email: `${id}@example.test` } }, isPending: false, error: null } }
beforeEach(() => {
  vi.clearAllMocks(); registries.clear()
  state.session = { data: null, isPending: true, error: null, refetch: vi.fn() }
  document.cookie = "is_sign_in=; max-age=0; path=/"; document.cookie = "is_new_signup=; max-age=0; path=/"
  state.invoke.mockImplementation(async (command: string) => {
    if (command === "native_oauth_snapshot") return { attemptId: "a".repeat(43), provider: "google", redirectPath: "/c/me/machines", expiresAt: Date.now() + 60000, waiting: true }
    if (command === "native_oauth_cancel") return { attemptId: "a".repeat(43), state: "s".repeat(43), verifier: "v".repeat(43) }
    throw new Error(`unexpected native command: ${command}`)
  })
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }))
})

it.each(["pending", "network-error"])("keeps the cached view and native attempt intact during %s", async mode => {
  if (mode === "network-error") state.session = { ...state.session, isPending: false, error: new TypeError("Offline") }
  render(<CommunityLayoutClient />)
  await screen.findByText("cached-a")
  await act(async () => { await Promise.resolve() })
  expect(nativeCancels()).toEqual([])
  expect(state.invoke).not.toHaveBeenCalled()
})

it.each(["pending", "network-error"])("preserves cookies, analytics, onboarding and navigation during %s", async mode => {
  if (mode === "network-error") state.session = { ...state.session, isPending: false, error: new TypeError("Offline") }
  cookies(); render(<CommunityLayoutClient />)
  await screen.findByText("cached-a")
  expect(document.cookie).toContain("is_sign_in=google"); expect(document.cookie).toContain("is_new_signup=google")
  expect(state.analytics).not.toHaveBeenCalled(); expect(state.replace).not.toHaveBeenCalled()
  expect(registries.get("cached-a")!.runtime.ui.get().onboardingState).toBeNull()
})

it("enables the original effects on matching confirmation without replacing the shell or draft", async () => {
  cookies(); const view = render(<CommunityLayoutClient />)
  await screen.findByText("cached-a")
  const original = registries.get("cached-a")!
  const draft = screen.getByRole("textbox", { name: "Draft" })
  fireEvent.change(draft, { target: { value: "unsent local text" } })
  confirm("cached-a"); view.rerender(<CommunityLayoutClient />)
  await waitFor(() => expect(nativeCancels()).toHaveLength(1))
  expect(registries.get("cached-a")).toBe(original)
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft)
  expect(draft).toHaveValue("unsent local text")
  expect(document.cookie).not.toMatch(/is_(sign_in|new_signup)=/)
  expect(state.analytics).toHaveBeenCalledWith({ event: "sign_in_success", method: "google" })
  expect(state.analytics).toHaveBeenCalledWith({ event: "sign_up", method: "google" })
  expect(original.runtime.ui.get().onboardingState).toMatchObject({ stage: "harness" })
  expect(state.replace).toHaveBeenCalledExactlyOnceWith("/c/me/machines")
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/auth/native/cancel", expect.objectContaining({ method: "POST", body: JSON.stringify({ attemptId: "a".repeat(43), state: "s".repeat(43), verifier: "v".repeat(43) }) })))
})

it("runs confirmed B's effects only after withdrawing cached A", async () => {
  cookies(); const view = render(<CommunityLayoutClient />)
  await screen.findByText("cached-a")
  const original = registries.get("cached-a")!
  state.analytics.mockImplementation(() => expect(screen.getByText("online-b")).toBeInTheDocument())
  confirm("online-b"); view.rerender(<CommunityLayoutClient />)
  await screen.findByText("online-b")
  await waitFor(() => expect(nativeCancels()).toHaveLength(1))
  expect(original.runtime.ui.get().onboardingState).toBeNull()
  expect(registries.get("online-b")!.runtime.ui.get().onboardingState).toMatchObject({ stage: "harness" })
  expect(screen.queryByText("cached-a")).toBeNull()
})

it("does not enable effects for displayed A when only B is confirmed", async () => {
  cookies(); render(<CommunityAuthenticatedEntry currentUser={{ id: "cached-a", email: "a@example.test" }} confirmedAccountId="online-b" />)
  expect(screen.getByText("cached-a")).toBeInTheDocument()
  expect(state.invoke).not.toHaveBeenCalled(); expect(state.analytics).not.toHaveBeenCalled()
  expect(document.cookie).toContain("is_new_signup=google")
  expect(registries.get("cached-a")!.runtime.ui.get().onboardingState).toBeNull()
})
