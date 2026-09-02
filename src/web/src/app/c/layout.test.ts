import { createElement } from "react"
import { readFileSync } from "node:fs"
// @ts-expect-error react-test-renderer intentionally has no local declaration package.
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  pathname: "/c/me",
  replace: vi.fn(),
  retireAttempt: vi.fn(),
  clearAttempts: vi.fn(),
  session: { data: null as null | { user: { id: string; name: string; email: string; image: string | null } }, isPending: true },
}))

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ replace: mocks.replace }),
}))
vi.mock("@/lib/auth-client", () => ({ useSession: () => mocks.session }))
vi.mock("@/lib/community/last-community-route", () => ({
  retireCommunityColdEntryAttempt: mocks.retireAttempt,
  clearCommunityColdEntryAttempts: mocks.clearAttempts,
}))
vi.mock("./community-shell", () => ({
  CommunityShell: (props: Record<string, unknown>) => createElement("community-shell", props),
}))
vi.mock("@/components/community/shell/community-session-pending-frame", () => ({
  CommunitySessionPendingFrame: (props: Record<string, unknown>) => createElement("session-pending", props),
}))
vi.mock("@/components/signup-tracker", () => ({
  SignupTracker: (props: Record<string, unknown>) => createElement("signup-tracker", props),
}))
import CommunityLayout from "./layout"

function render() {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(createElement(CommunityLayout, null, createElement("child")))
  })
  return renderer
}

describe("CommunityLayout session boundary", () => {
  beforeEach(() => {
    mocks.pathname = "/c/me"
    mocks.session = { data: null, isPending: true }
    mocks.replace.mockClear()
    mocks.retireAttempt.mockClear()
    mocks.clearAttempts.mockClear()
  })

  it("keeps a stable frame while identity is pending", () => {
    const renderer = render()
    expect(renderer.root.findByType("session-pending").props.pathname).toBe("/c/me")
    expect(renderer.root.findAllByType("community-shell")).toHaveLength(0)
    expect(mocks.retireAttempt).not.toHaveBeenCalled()
    expect(mocks.clearAttempts).not.toHaveBeenCalled()
  })

  it("keeps the frame mounted while a signed-out redirect commits", () => {
    mocks.session = { data: null, isPending: false }
    const renderer = render()
    expect(mocks.replace).toHaveBeenCalledWith("/sign-in")
    expect(mocks.clearAttempts).toHaveBeenCalledTimes(1)
    expect(renderer.root.findByType("session-pending").props.pathname).toBe("/c/me")
  })

  it("constructs the shell only after identity is available", () => {
    mocks.session = {
      data: { user: { id: "u1", name: "Ada", email: "ada@example.com", image: null } },
      isPending: false,
    }
    const renderer = render()
    const shell = renderer.root.findByType("community-shell")
    expect(shell.props.currentUser).toMatchObject({ id: "u1", name: "Ada", email: "ada@example.com" })
    expect(renderer.root.findAllByType("session-pending")).toHaveLength(0)
    expect(shell.props.currentUser.id).toBe("u1")
    expect(mocks.retireAttempt).toHaveBeenCalledWith("u1", "/c/me")
    expect(mocks.clearAttempts).not.toHaveBeenCalled()
  })

  it("preserves the public invite bypass", () => {
    mocks.pathname = "/c/invite/token"
    const renderer = render()
    expect(renderer.root.findAllByType("child")).toHaveLength(1)
    expect(renderer.root.findAllByType("session-pending")).toHaveLength(0)
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("does not broaden the public bypass to malformed invite descendants", () => {
    mocks.pathname = "/c/invite/token/extra"
    const renderer = render()
    expect(renderer.root.findByType("session-pending").props.pathname).toBe(
      "/c/invite/token/extra",
    )
    expect(renderer.root.findAllByType("child")).toHaveLength(0)
  })

  it("wires the Me verifier to canonical fetch-in-flight state", () => {
    const source = readFileSync(new URL("./me/layout.tsx", import.meta.url), "utf8")
    expect(source).toMatch(/isPending:\s*dmsPending/)
    expect(source).toMatch(/isFetching:\s*dmsFetching/)
    expect(source).toContain("const canonicalDmsUnsettled = dmsPending || dmsFetching")
    expect(source).toContain("useDmRouteVerification(params.dmId, rawDms, canonicalDmsUnsettled)")
  })

  it("mounts the daemon check inside the authenticated Community query cache", () => {
    const shell = readFileSync(new URL("./community-shell.tsx", import.meta.url), "utf8")
    expect(shell.indexOf("<QueryProvider")).toBeLessThan(shell.indexOf("<CommunityDaemonUpdateNotice"))
    expect(shell).toContain("<CommunityDaemonUpdateNotice userId={currentUser.id} />")
  })
})
