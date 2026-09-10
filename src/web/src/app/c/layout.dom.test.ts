import { createElement } from "react"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/test/react-dom-harness"

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
  CommunityShell: (props: Record<string, unknown>) => createElement("div", {
    "data-testid": "community-shell",
    "data-current-user": JSON.stringify(props.currentUser),
  }),
}))
vi.mock("@/components/community/shell/community-session-pending-frame", () => ({
  CommunitySessionPendingFrame: ({ pathname }: { pathname: string }) => createElement("div", {
    "data-testid": "session-pending",
    "data-pathname": pathname,
  }),
}))
vi.mock("@/components/signup-tracker", () => ({
  SignupTracker: () => createElement("div", { "data-testid": "signup-tracker" }),
}))
vi.mock("@/components/authenticated-native-oauth-cleanup", () => ({
  AuthenticatedNativeOauthCleanup: () => createElement("div", { "data-testid": "native-oauth-cleanup" }),
}))
import CommunityLayout from "./layout"

function renderLayout() {
  return render(createElement(
    CommunityLayout,
    null,
    createElement("div", { "data-testid": "child" }),
  ))
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
    renderLayout()
    expect(screen.getByTestId("session-pending")).toHaveAttribute("data-pathname", "/c/me")
    expect(screen.queryByTestId("community-shell")).not.toBeInTheDocument()
    expect(screen.queryByTestId("native-oauth-cleanup")).not.toBeInTheDocument()
    expect(mocks.retireAttempt).not.toHaveBeenCalled()
    expect(mocks.clearAttempts).not.toHaveBeenCalled()
  })

  it("keeps the frame mounted while a signed-out redirect commits", () => {
    mocks.session = { data: null, isPending: false }
    renderLayout()
    expect(mocks.replace).toHaveBeenCalledWith("/sign-in")
    expect(mocks.clearAttempts).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("session-pending")).toHaveAttribute("data-pathname", "/c/me")
    expect(screen.queryByTestId("native-oauth-cleanup")).not.toBeInTheDocument()
  })

  it("constructs the shell only after identity is available", () => {
    mocks.session = {
      data: { user: { id: "u1", name: "Ada", email: "ada@example.com", image: null } },
      isPending: false,
    }
    renderLayout()
    expect(JSON.parse(screen.getByTestId("community-shell").dataset.currentUser!)).toMatchObject({
      id: "u1",
      name: "Ada",
      email: "ada@example.com",
    })
    expect(screen.queryByTestId("session-pending")).not.toBeInTheDocument()
    expect(mocks.retireAttempt).toHaveBeenCalledWith("u1", "/c/me")
    expect(mocks.clearAttempts).not.toHaveBeenCalled()
    expect(screen.getByTestId("native-oauth-cleanup")).toBeInTheDocument()
  })

  it("preserves the public invite bypass", () => {
    mocks.pathname = "/c/invite/token"
    renderLayout()
    expect(screen.getByTestId("child")).toBeInTheDocument()
    expect(screen.queryByTestId("session-pending")).not.toBeInTheDocument()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(screen.queryByTestId("native-oauth-cleanup")).not.toBeInTheDocument()
  })

  it("does not broaden the public bypass to malformed invite descendants", () => {
    mocks.pathname = "/c/invite/token/extra"
    renderLayout()
    expect(screen.getByTestId("session-pending")).toHaveAttribute(
      "data-pathname",
      "/c/invite/token/extra",
    )
    expect(screen.queryByTestId("child")).not.toBeInTheDocument()
  })

  it("wires the Me verifier to canonical fetch-in-flight state", () => {
    const source = readFileSync(resolve(
      process.cwd(),
      process.cwd().endsWith("/src/web") ? "" : "src/web",
      "src/app/c/me/layout.tsx",
    ), "utf8")
    expect(source).toMatch(/isPending:\s*dmsPending/)
    expect(source).toMatch(/isFetching:\s*dmsFetching/)
    expect(source).toContain("const canonicalDmsUnsettled = dmsPending || dmsFetching")
    expect(source).toContain("useDmRouteVerification(params.dmId, rawDms, canonicalDmsUnsettled)")
  })

  it("keeps the daemon update controller inside the authenticated Community query cache", () => {
    const shell = readFileSync(resolve(
      process.cwd(),
      process.cwd().endsWith("/src/web") ? "" : "src/web",
      "src/app/c/community-shell.tsx",
    ), "utf8")
    const frame = readFileSync(resolve(
      process.cwd(),
      process.cwd().endsWith("/src/web") ? "" : "src/web",
      "src/components/community/shell/shell-frame.tsx",
    ), "utf8")
    expect(shell).toMatch(/<QueryProvider[\s\S]*<CurrentUserProvider[\s\S]*<CommunityBootstrap>/)
    expect(shell).not.toContain("CommunityDaemonUpdateNotice")
    expect(frame).toContain("useShellDaemonUpdateController")
  })
})
