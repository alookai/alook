import { render } from "@/test/react-dom-harness"
import { afterEach, describe, expect, it, vi } from "vitest"
const state = vi.hoisted(() => ({ session: { data: null as { user: { id: string } } | null } }))
vi.mock("@/lib/auth-client", () => ({ useSession: () => state.session }))
vi.mock("./landing-page", () => ({ LandingPage: ({ isLoggedIn }: { isLoggedIn: boolean }) => <a href={isLoggedIn ? "/c/me" : "/sign-in"}>{isLoggedIn ? "Open App" : "Get Started"}</a> }))
import { SessionLandingPage } from "./session-landing-page"
afterEach(() => { state.session.data = null })
describe("homepage session personalization", () => {
  it("switches the public CTA after session resolution and after logout", () => {
    const view = render(<SessionLandingPage />)
    expect(view.getByRole("link").getAttribute("href")).toBe("/sign-in")
    state.session.data = { user: { id: "viewer" } }
    view.rerender(<SessionLandingPage />)
    expect(view.getByRole("link").getAttribute("href")).toBe("/c/me")
    state.session.data = null
    view.rerender(<SessionLandingPage />)
    expect(view.getByRole("link").getAttribute("href")).toBe("/sign-in")
  })
})
