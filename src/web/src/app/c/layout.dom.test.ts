import { createElement, useEffect, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  pathname: "/c/me/machines", search: "", router: { replace: vi.fn() },
  session: { data: null as null | { user: { id: string; email: string; name: string; image: string | null; isBot?: boolean; deletedAt?: string | null } },
    isPending: true, error: null as null | Error, refetch: vi.fn(async () => {}) },
  signOut: vi.fn(async () => ({ error: null })), mounted: vi.fn(), unmounted: vi.fn(),
  retireAttempt: vi.fn(), clearAttempts: vi.fn(),
}))
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname, useSearchParams: () => new URLSearchParams(mocks.search), useRouter: () => mocks.router, notFound: () => { throw new Error("not-found") } }))
vi.mock("@/lib/auth-client", () => ({ useSession: () => mocks.session, authClient: { signOut: mocks.signOut } }))
vi.mock("@/lib/community/last-community-route", () => ({ retireCommunityColdEntryAttempt: mocks.retireAttempt, clearCommunityColdEntryAttempts: mocks.clearAttempts }))
vi.mock("./community-shell", () => ({ CommunityShell: ({ currentUser, children }: { currentUser: { id: string }; children: ReactNode }) => {
  useEffect(() => { mocks.mounted(currentUser.id); return () => mocks.unmounted(currentUser.id) }, [currentUser.id])
  return createElement("main", { "data-testid": "private-shell", "data-account": currentUser.id }, children)
} }))
vi.mock("@/components/community/shell/community-session-pending-frame", () => ({ CommunitySessionPendingFrame: ({ pathname, children }: { pathname: string; children: ReactNode }) => createElement("main", { "data-testid": "pending", "data-pathname": pathname }, children) }))
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
  mocks.signOut.mockResolvedValue({ error: null })
  window.history.replaceState(null, "", "/")
})
const tree = () => createElement(CommunityLayoutClient)

describe("client account startup", () => {
  it("renders a neutral frame before authentication and mounts an account without a profile prerequisite", () => {
    const view = render(tree())
    expect(screen.getByTestId("pending")).toHaveAttribute("data-pathname", "/c/me/machines")
    expect(mocks.router.replace).not.toHaveBeenCalled()
    expect(mocks.mounted).not.toHaveBeenCalled()
    mocks.session.data = { user: user("a") }; mocks.session.isPending = false
    view.rerender(tree())
    expect(screen.getByTestId("private-shell")).toHaveAttribute("data-account", "a")
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
  it("keeps lookup errors retryable without treating them as logout", () => {
    mocks.session.isPending = false; mocks.session.error = new Error("Unavailable")
    render(tree())
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't check your account")
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
  it("replaces the account owner on A to B and removes it before signed-out redirect", () => {
    mocks.session.isPending = false; mocks.session.data = { user: user("a") }
    const view = render(tree())
    mocks.session.data = { user: user("b") }; view.rerender(tree())
    expect(mocks.unmounted).toHaveBeenCalledWith("a")
    expect(screen.getByTestId("private-shell")).toHaveAttribute("data-account", "b")
    mocks.session.data = null; view.rerender(tree())
    expect(mocks.unmounted).toHaveBeenCalledWith("b")
    expect(screen.queryByTestId("private-shell")).not.toBeInTheDocument()
  })
})
