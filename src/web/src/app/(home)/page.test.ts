import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ headers: vi.fn(), getSession: vi.fn() }))
vi.mock("next/headers", () => ({ headers: mocks.headers }))
vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }))
vi.mock("@/components/home/landing-page", () => ({ LandingPage: () => null }))
vi.mock("@/lib/observability/regions", () => ({ ObservedStaticContent: () => null }))
import Page from "./page"
describe("homepage session personalization", () => {
  beforeEach(() => vi.clearAllMocks())
  it("does not initialize authentication for a credential-free visitor", async () => {
    mocks.headers.mockResolvedValue(new Headers())
    const page = await Page()
    expect(page.props.children[1].props.isLoggedIn).toBe(false)
    expect(mocks.getSession).not.toHaveBeenCalled()
  })
  it.each<HeadersInit>([{ cookie: "session=viewer" }, { authorization: "Bearer viewer" }])("validates credentials %j", async headers => {
    mocks.headers.mockResolvedValue(new Headers(headers))
    mocks.getSession.mockResolvedValue({ user: { id: "viewer" } })
    const page = await Page()
    expect(page.props.children[1].props.isLoggedIn).toBe(true)
    expect(mocks.getSession).toHaveBeenCalledOnce()
  })
  it("keeps unrelated or invalid cookies anonymous", async () => {
    mocks.headers.mockResolvedValue(new Headers({ cookie: "consent=yes" }))
    mocks.getSession.mockResolvedValue(null)
    const page = await Page()
    expect(page.props.children[1].props.isLoggedIn).toBe(false)
  })
})
