import { useContext } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { CommunityModuleRouteContext, useCommunityModuleLocation } from "@/contexts/community/module-route"
import { CommunityServerRouteContext } from "@/contexts/community/route-frame"
import { CommunityModuleRoute } from "./community-module-route"

const mocks = vi.hoisted(() => ({
  rememberMe: vi.fn(),
  rememberCommunity: vi.fn(),
  capturedModContexts: [] as unknown[],
  capturedServerContexts: [] as unknown[],
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({push: vi.fn(), replace: vi.fn()}), useSearchParams: () => new URLSearchParams("old=1") }))
vi.mock("@/contexts/community/current-user", () => ({ useCurrentUser: () => ({id: "viewer"}) }))
vi.mock("@/lib/community/last-me-location", () => ({isRememberableMeLocation: () => true, setLastMeLocation: (...args: unknown[]) => mocks.rememberMe(...args)}))
vi.mock("@/lib/community/last-community-route", () => ({commitLastCommunityRoute: (...args: unknown[]) => mocks.rememberCommunity(...args)}))
vi.mock("./community-pending-frame", () => ({CommunityPendingFrame: () => <div>Loading module</div>}))
function Module() {
  const {searchParams, routeCommitted} = useCommunityModuleLocation()
  mocks.capturedModContexts.push(useContext(CommunityModuleRouteContext))
  mocks.capturedServerContexts.push(useContext(CommunityServerRouteContext))
  return <main data-search={searchParams.toString()} data-committed={String(routeCommitted)}><input aria-label="Module state" /></main>
}
vi.mock("../social/friends-route", () => ({default: Module}))
vi.mock("../bots/me-bots-route", () => ({default: Module}))
vi.mock("../machines/me-machines-route", () => ({default: Module}))
vi.mock("./server-landing-route", () => ({default: Module}))
vi.mock("../channels/server-conversation-route", () => ({
  ServerConversationRoute: ({ children }: { children?: React.ReactNode }) => children ?? null,
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.capturedModContexts.length = 0
  mocks.capturedServerContexts.length = 0
})

describe("shared module delivery and committed route memory", () => {
  it.each(["friends", "bots", "machines"] as const)("keeps %s target parameters and body through commit without early route memory", async module => {
    const href = `/c/me/${module}?target=one`
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(<CommunityModuleRoute href={href} routeCommitted={false} />)
      await Promise.all([import("../social/friends-route"), import("../bots/me-bots-route"), import("../machines/me-machines-route")])
    })
    const body = view.getByRole("main")
    const input = view.getByLabelText("Module state") as HTMLInputElement
    input.value = "Retained"
    expect(body).toHaveAttribute("data-search", "target=one")
    expect(body).toHaveAttribute("data-committed", "false")
    expect(mocks.rememberMe).not.toHaveBeenCalled()
    expect(mocks.rememberCommunity).not.toHaveBeenCalled()
    view.rerender(<CommunityModuleRoute href={href} routeCommitted />)
    expect(view.getByRole("main")).toBe(body)
    expect(view.getByLabelText("Module state")).toBe(input)
    expect(input).toHaveValue("Retained")
    expect(body).toHaveAttribute("data-search", "target=one")
    expect(body).toHaveAttribute("data-committed", "true")
    expect(mocks.rememberMe).toHaveBeenCalledExactlyOnceWith(`/c/me/${module}`)
    expect(mocks.rememberCommunity).toHaveBeenCalledExactlyOnceWith("viewer", `/c/me/${module}`)
  })

  it("preserves module and server route context identity across identical rerenders", async () => {
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(<CommunityModuleRoute href="/c/channels/s1" routeCommitted />)
      await import("./server-landing-route")
    })
    await act(async () => {
      view.rerender(<CommunityModuleRoute href="/c/channels/s1" routeCommitted />)
    })
    view.unmount()
    expect(mocks.capturedModContexts.length).toBeGreaterThanOrEqual(2)
    expect(new Set(mocks.capturedModContexts).size).toBe(1)
    expect(new Set(mocks.capturedServerContexts).size).toBe(1)
  })
})
