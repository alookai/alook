import { useLayoutEffect } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { CommunityApplicationNavigation } from "@/contexts/community/application-navigation"
import { useCommunityHistoryRouter } from "./navigation"
const mocks = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() } }))
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }))
let current: ReturnType<typeof useCommunityHistoryRouter>
function Probe() { const router = useCommunityHistoryRouter(); useLayoutEffect(() => { current = router }, [router]); return null }
beforeEach(() => { vi.clearAllMocks(); window.history.replaceState(null, "", "/c/me/friends") })
describe("documented History router host", () => {
  it("preserves the framework router at providerless and preview boundaries", () => {
    render(<Probe />)
    expect(current).toBe(mocks.router)
    current.push("/c/me/bots")
    expect(mocks.router.push).toHaveBeenCalledExactlyOnceWith("/c/me/bots")
  })
  it("publishes complete app URLs without waiting for or requesting a framework route", () => {
    render(<CommunityApplicationNavigation value={true}><Probe /></CommunityApplicationNavigation>)
    const length = window.history.length
    act(() => current.push("/c/channels/server/forum?seq=42#message-42", { scroll: false }))
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/c/channels/server/forum?seq=42#message-42")
    expect(window.history.length).toBe(length + 1)
    act(() => current.replace("/c/channels/server"))
    expect(window.location.pathname).toBe("/c/channels/server")
    expect(window.history.length).toBe(length + 1)
    expect(mocks.router.push).not.toHaveBeenCalled()
    expect(mocks.router.replace).not.toHaveBeenCalled()
    expect(mocks.router.prefetch).not.toHaveBeenCalled()
  })
  it.each(["/c/invite/token", "/sign-in", "/auth/native/return", "https://other.test/c/me", "/c/invalid/extra"])("leaves %s to normal document routing", href => {
    render(<CommunityApplicationNavigation value={true}><Probe /></CommunityApplicationNavigation>)
    current.replace(href)
    expect(mocks.router.replace).toHaveBeenCalledExactlyOnceWith(href)
    expect(window.location.pathname).toBe("/c/me/friends")
  })
})
