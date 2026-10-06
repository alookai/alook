import { beforeEach, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import AppLayout, { metadata } from "./layout"
import WorkspacePage from "./w/[[...path]]/page"
import StudioPage from "./studio/new/page"
import InvitePage from "./invite/[token]/page"
import { tid } from "@/lib/community/testids"

const input = vi.hoisted(() => ({ authenticated: true, redirect: vi.fn() }))
vi.mock("@/lib/session", () => ({ getSession: async () => input.authenticated ? { user: { id: "viewer" } } : null }))
vi.mock("next/navigation", () => ({ usePathname: () => "/invite/retired", redirect: (url: string) => { input.redirect(url); throw new Error("NEXT_REDIRECT") } }))
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }))
vi.mock("@/components/authenticated-native-oauth-cleanup", () => ({ AuthenticatedNativeOauthCleanup: () => null }))
vi.mock("@/components/signup-tracker", () => ({ SignupTracker: () => null }))
vi.mock("@/components/signin-tracker", () => ({ SigninTracker: () => null }))
beforeEach(() => { input.authenticated = true; input.redirect.mockReset() })

it.each([WorkspacePage, StudioPage])("retires its legacy route directly to community", Page => {
  expect(() => Page()).toThrow("NEXT_REDIRECT")
  expect(input.redirect).toHaveBeenCalledWith("/c/me")
})
it("keeps authentication and no-index metadata on the compatibility pages", async () => {
  input.authenticated = false
  await expect(AppLayout({ children: <p>Private</p> })).rejects.toThrow("NEXT_REDIRECT")
  expect(input.redirect).toHaveBeenCalledWith("/sign-in")
  expect(metadata.robots).toEqual({ index: false, follow: false })
})
it("explains the retired workspace invite without loading or accepting any token", async () => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  try {
    const view = render(await AppLayout({ children: <InvitePage /> }))
    expect(view.getByTestId(tid.retiredWorkspaceInviteTitle)).toHaveTextContent("Workspace invitations have been retired")
    expect(view.getByTestId(tid.retiredWorkspaceInviteCommunityLink)).toHaveAttribute("href", "/c/me")
    expect(view.getByTestId(tid.retiredWorkspaceInviteCommunityLink)).toHaveTextContent("Open Community")
    expect(view.queryByRole("button", { name: /join|accept/i })).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})
