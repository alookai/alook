import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ pathname: "/c", session: vi.fn() }))
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }))
vi.mock("@/lib/auth-client", () => ({ useSession: mocks.session, authClient: {} }))
vi.mock("@/components/community/shell/community-session-pending-frame", () => ({
  CommunitySessionPendingFrame: ({ pathname }: { pathname: string }) => createElement("main", { "data-pathname": pathname }, "Public frame"),
}))
vi.mock("./community-shell", () => ({ CommunityShell: () => { throw new Error("Private shell rendered on server") } }))
import CommunityLayout from "./layout"

describe("public community document", () => {
  it("emits identical neutral HTML independent of route and authentication", () => {
    const home = renderToString(createElement(CommunityLayout))
    mocks.pathname = "/c/channels/private-server/private-channel"
    const deep = renderToString(createElement(CommunityLayout))
    expect(deep).toBe(home)
    expect(home).toContain('data-community-shell="public"')
    expect(home).toContain('data-pathname="/c"')
    expect(home).not.toContain("private-server")
    expect(home).not.toContain("initialSeed")
    expect(mocks.session).not.toHaveBeenCalled()
  })
})
