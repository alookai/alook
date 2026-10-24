import { describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ headers: vi.fn(), getSession: vi.fn() }))
vi.mock("next/headers", () => ({ headers: mocks.headers }))
vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }))
vi.mock("@/components/home/session-landing-page", () => ({ SessionLandingPage: () => null }))
vi.mock("@/lib/observability/regions", () => ({ ObservedStaticContent: () => null }))
import Page from "./page"
import { SessionLandingPage } from "@/components/home/session-landing-page"
describe("public homepage prerender", () => {
  it("renders the client session boundary without reading request credentials", () => {
    const page = Page()
    expect(page.props.children[1].type).toBe(SessionLandingPage)
    expect(mocks.headers).not.toHaveBeenCalled()
    expect(mocks.getSession).not.toHaveBeenCalled()
  })
})
