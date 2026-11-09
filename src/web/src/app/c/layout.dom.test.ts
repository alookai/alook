import { createElement, useEffect, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  pathname: "/c/me/machines", search: "", router: { replace: vi.fn() },
  session: { data: null as null | { user: { id: string; email: string; name: string; image: string | null; isBot?: boolean; deletedAt?: string | null } },
    isPending: true, error: null as null | Error, refetch: vi.fn(async () => {}) },
  signOut: vi.fn(async () => ({ error: null })), mounted: vi.fn(), unmounted: vi.fn(),
  retireAttempt: vi.fn(), clearAttempts: vi.fn(),
  captureIdentity: vi.fn(async (): Promise<{ id: string } | undefined> => ({ id: "candidate" })),
  readIdentity: vi.fn(async (): Promise<{ id: string; email: string } | undefined> => undefined),
}))
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname, useSearchParams: () => new URLSearchParams(mocks.search), useRouter: () => mocks.router, notFound: () => { throw new Error("not-found") } }))
vi.mock("@/lib/auth-session", () => ({ useSession: () => mocks.session, currentSessionViewer: () => mocks.session.data?.user.id ?? null, authClient: { signOut: mocks.signOut } }))
vi.mock("@/lib/community/last-community-route", () => ({ retireCommunityColdEntryAttempt: mocks.retireAttempt, clearCommunityColdEntryAttempts: mocks.clearAttempts }))
vi.mock("@/lib/persisted-account-identity", () => ({ capturePersistedAccountIdentity: mocks.captureIdentity }))
vi.mock("@/lib/query-persister", () => ({ readPersistedAccountIdentity: mocks.readIdentity }))
vi.mock("./community-shell", () => ({ CommunityShell: ({ currentUser, children }: { currentUser: { id: string }; children: ReactNode }) => {
  useEffect(() => { mocks.mounted(currentUser.id); return () => mocks.unmounted(currentUser.id) }, [currentUser.id])
  return createElement("main", { "data-testid": "private-shell", "data-account": currentUser.id }, children)
} }))
vi.mock("@/components/community/shell/community-account-pending-frame", () => ({ CommunityAccountPendingFrame: ({ pathname, children }: { pathname: string; children: ReactNode }) => createElement("main", { "data-testid": "pending", "data-pathname": pathname }, children) }))
vi.mock("@/components/community/shell/community-route-frame", () => ({ CommunityRouteFrame: () => createElement("div", null, "Route") }))
vi.mock("@/components/authenticated-context-menu-boundary", () => ({ AuthenticatedContextMenuBoundary: ({ children }: { children: ReactNode }) => children }))
vi.mock("@/components/authenticated-native-oauth-cleanup", () => ({ AuthenticatedNativeOauthCleanup: () => null }))
vi.mock("@/components/signup-tracker", () => ({ SignupTracker: () => null }))
vi.mock("@/components/ui/button", () => ({ Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => createElement("button", { onClick }, children) }))
import { CommunityLayoutClient } from "./community-layout-client"
const user = (id: string) => ({ id, email: `${id}@test.local`, name: id, image: null })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.pathname = "/c/me/machines"; mocks.search = ""
  mocks.session.data = null; mocks.session.isPending = true; mocks.session.error = null
  mocks.captureIdentity.mockReset().mockResolvedValue({ id: "candidate" })
  mocks.readIdentity.mockReset().mockResolvedValue(undefined)
  mocks.signOut.mockResolvedValue({ error: null })
  window.history.replaceState(null, "", "/")
})
afterEach(() => vi.dynamicImportSettled())
const tree = () => createElement(CommunityLayoutClient)

describe("client account startup", () => {
  it("starts local recovery without trusting an unconfirmed SDK identity or delaying online confirmation", async () => {
    let prepared!: () => void
    mocks.readIdentity.mockImplementationOnce(() => new Promise<undefined>(resolve => { prepared = () => resolve(undefined) }))
    mocks.session.data = { user: user("unconfirmed") }
    const view = render(tree())
    await waitFor(() => expect(mocks.readIdentity).toHaveBeenCalledOnce())
    expect(mocks.mounted).not.toHaveBeenCalled()
    expect(screen.queryByTestId("private-shell")).not.toBeInTheDocument()
    mocks.session.data = { user: user("confirmed") }; mocks.session.isPending = false
    view.rerender(tree())
    await waitFor(() => expect(screen.getByTestId("private-shell")).toHaveAttribute("data-account", "confirmed"))
    await act(async () => { prepared() })
    expect(mocks.mounted).toHaveBeenCalledExactlyOnceWith("confirmed")
  })
  it("keeps preparation failure separate from the original session and Retry owner", async () => {
    mocks.readIdentity.mockRejectedValueOnce(new Error("IDB open failed"))
    const view = render(tree())
    await act(async () => {})
    expect(screen.queryByTestId("private-shell")).not.toBeInTheDocument()
    expect(mocks.router.replace).not.toHaveBeenCalled()
    expect(mocks.session.refetch).not.toHaveBeenCalled()
    mocks.session.data = { user: user("confirmed") }; mocks.session.isPending = false
    view.rerender(tree())
    await waitFor(() => expect(screen.getByTestId("private-shell")).toHaveAttribute("data-account", "confirmed"))
  })
  it("renders a neutral frame before authentication and mounts an account without a profile prerequisite", async () => {
    const view = render(tree())
    expect(screen.getByTestId("pending")).toHaveAttribute("data-pathname", "/c/me/machines")
    expect(mocks.router.replace).not.toHaveBeenCalled()
    expect(mocks.mounted).not.toHaveBeenCalled()
    mocks.session.data = { user: user("a") }; mocks.session.isPending = false
    view.rerender(tree())
    await waitFor(() => expect(screen.getByTestId("private-shell")).toHaveAttribute("data-account", "a"))
    expect(mocks.retireAttempt).toHaveBeenCalledWith("a", mocks.pathname)
  })
  it("preserves deep route, search and hash when a confirmed unauthenticated session goes to sign-in", () => {
    mocks.pathname = "/c/channels/server/channel"; mocks.search = "seq=42"
    window.history.replaceState(null, "", "/#message-42")
    mocks.session.isPending = false
    render(tree())
    const destination = new URL(mocks.router.replace.mock.calls[0]![0], "http://localhost")
    expect(destination.pathname).toBe("/sign-in")
    expect(destination.searchParams.get("redirect")).toBe("/c/channels/server/channel?seq=42#message-42")
    expect(mocks.mounted).not.toHaveBeenCalled()
  })
  it("keeps lookup errors retryable without treating them as logout", async () => {
    mocks.session.isPending = false; mocks.session.error = new Error("Unavailable")
    render(tree())
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't check your account"))
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(mocks.session.refetch).toHaveBeenCalledOnce()
    expect(mocks.router.replace).not.toHaveBeenCalled()
    expect(mocks.signOut).not.toHaveBeenCalled()
  })
  it.each([{ isBot: true }, { deletedAt: "2026-01-01" }])("rejects an invalid session %j before private cache can mount", async flags => {
    mocks.session.isPending = false; mocks.session.data = { user: { ...user("invalid"), ...flags } }
    render(tree()); await act(async () => {})
    expect(mocks.signOut).toHaveBeenCalledOnce()
    expect(mocks.router.replace).toHaveBeenCalledOnce()
    expect(mocks.mounted).not.toHaveBeenCalled()
  })
  it("replaces the account owner on A to B and removes it before signed-out redirect", async () => {
    mocks.session.isPending = false; mocks.session.data = { user: user("a") }
    const view = render(tree())
    await waitFor(() => expect(mocks.mounted).toHaveBeenCalledWith("a"))
    mocks.session.data = { user: user("b") }; view.rerender(tree())
    expect(mocks.unmounted).toHaveBeenCalledWith("a")
    await waitFor(() => expect(screen.getByTestId("private-shell")).toHaveAttribute("data-account", "b"))
    mocks.session.data = null; view.rerender(tree())
    expect(mocks.unmounted).toHaveBeenCalledWith("b")
    expect(screen.queryByTestId("private-shell")).not.toBeInTheDocument()
  })
})

describe("cached account confirmation", () => {
  it("displays eligible cache while confirmation waits and keeps the same owner through network failure and confirmation", async () => {
    mocks.readIdentity.mockResolvedValue({ id: "cached", email: "cached@test.local" })
    const view = render(tree())
    await waitFor(() => expect(screen.getByTestId("private-shell")).toHaveAttribute("data-account", "cached"))
    mocks.session.isPending = false; mocks.session.error = new TypeError("offline")
    view.rerender(tree())
    expect(screen.getByTestId("private-shell")).toHaveAttribute("data-account", "cached")
    expect(mocks.router.replace).not.toHaveBeenCalled()
    mocks.session.error = null; mocks.session.data = { user: user("cached") }
    view.rerender(tree())
    expect(mocks.mounted).toHaveBeenCalledExactlyOnceWith("cached")
    expect(mocks.unmounted).not.toHaveBeenCalled()
  })

  it.each([401, 403])("removes cached content immediately on explicit session rejection %i", async status => {
    mocks.readIdentity.mockResolvedValue({ id: "cached", email: "cached@test.local" })
    const view = render(tree())
    await waitFor(() => expect(screen.getByTestId("private-shell")).toBeInTheDocument())
    mocks.session.isPending = false; mocks.session.error = Object.assign(new Error("rejected"), { status })
    view.rerender(tree())
    expect(screen.queryByTestId("private-shell")).not.toBeInTheDocument()
    expect(mocks.router.replace).toHaveBeenCalled()
  })

  it("ignores a cached A read that finishes after online B and after logout", async () => {
    let release!: (identity: { id: string; email: string }) => void
    mocks.readIdentity.mockReturnValue(new Promise(resolve => { release = resolve }))
    const view = render(tree())
    await waitFor(() => expect(mocks.readIdentity).toHaveBeenCalledOnce())
    mocks.session.isPending = false; mocks.session.data = { user: user("b") }
    view.rerender(tree())
    await waitFor(() => expect(screen.getByTestId("private-shell")).toHaveAttribute("data-account", "b"))
    mocks.session.data = null; view.rerender(tree())
    await act(async () => release({ id: "a", email: "a@test.local" }))
    expect(screen.queryByTestId("private-shell")).not.toBeInTheDocument()
    expect(mocks.mounted).not.toHaveBeenCalledWith("a")
  })

  it("retains a confirmed online owner when a later check has a network error", async () => {
    mocks.session.isPending = false; mocks.session.data = { user: user("online") }
    const view = render(tree())
    await waitFor(() => expect(screen.getByTestId("private-shell")).toHaveAttribute("data-account", "online"))
    mocks.session.error = new TypeError("network failed"); view.rerender(tree())
    expect(screen.getByTestId("private-shell")).toHaveAttribute("data-account", "online")
    expect(mocks.unmounted).not.toHaveBeenCalled()
  })
})


it("skips private payload recovery when no established local identity exists", async () => {
  mocks.captureIdentity.mockResolvedValue(undefined)
  render(tree())
  await act(async () => { await vi.dynamicImportSettled() })
  expect(mocks.captureIdentity).toHaveBeenCalledOnce()
  expect(mocks.readIdentity).not.toHaveBeenCalled()
  expect(mocks.mounted).not.toHaveBeenCalled()
})
