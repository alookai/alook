import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, setupUser } from "@/test/react-dom-harness"
import { DmRoute } from "./dm-route"

const mocks = vi.hoisted(() => ({
  verification: { status: "pending", retrying: false, retry: vi.fn() },
  breakpoint: "desktop",
  last: "dm-a",
  cold: false,
  replace: vi.fn(), clear: vi.fn(), purge: vi.fn(), cancel: vi.fn(), consume: vi.fn(),
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }))
vi.mock("@/contexts/community/current-user", () => ({ useCurrentUser: () => ({ id: "viewer" }) }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint }))
vi.mock("@/hooks/community/use-dm-route-verification", () => ({ useDmRouteVerification: () => mocks.verification }))
vi.mock("@/stores/community", () => ({ useCommunityStore: { getState: () => ({ uiHandlers: { cancelPendingNavigation: mocks.cancel } }) } }))
vi.mock("@/lib/community-db/projections", () => ({ useOptionalCommunityDbRegistry: () => ({}) }))
vi.mock("@/lib/community-db/sync", () => ({ purgeCommunityChannel: mocks.purge }))
vi.mock("@/lib/community/last-me-location", () => ({ ME_ROOT: "/c/me", getLastMeLeaf: () => mocks.last, clearLastMeLocation: mocks.clear }))
vi.mock("@/lib/community/last-community-route", () => ({
  COMMUNITY_COLD_ENTRY_FALLBACK: "/c/me/machines",
  consumeCommunityColdEntryFailure: (...args: unknown[]) => { mocks.consume(...args); return mocks.cold },
}))
vi.mock("./dm-view", () => ({ DmView: ({ dmId }: { dmId: string }) => React.createElement("main", { "data-channel-id": dmId }, dmId) }))
vi.mock("./dm-loading-frame", () => ({ DmLoadingFrame: ({ reserveBackSlot }: { reserveBackSlot: boolean }) => React.createElement("div", { "data-testid": "dm-pending", "data-back": String(reserveBackSlot) }) }))
vi.mock("./dm-route-error-frame", () => ({ DmRouteErrorFrame: ({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) => React.createElement("button", { onClick: onRetry, disabled: retrying }, "Retry") }))

beforeEach(() => {
  mocks.verification.status = "pending"
  mocks.verification.retrying = false
  mocks.breakpoint = "desktop"
  mocks.last = "dm-a"
  mocks.cold = false
  for (const callback of [mocks.replace, mocks.clear, mocks.purge, mocks.cancel, mocks.consume, mocks.verification.retry]) callback.mockClear()
})

describe("DM target main owns identity, retry and fallback", () => {
  it("reserves the target frame on mobile and mounts only the qualified explicit ID", () => {
    mocks.breakpoint = "mobile"
    const route = render(React.createElement(DmRoute, { dmId: "dm-a" }))
    expect(screen.getByTestId("dm-pending")).toHaveAttribute("data-back", "true")
    expect(route.container.querySelector("main")).toBeNull()
    expect(mocks.replace).not.toHaveBeenCalled()
    mocks.verification.status = "present"
    route.rerender(React.createElement(DmRoute, { dmId: "dm-b" }))
    expect(route.container.querySelector("main")).toHaveAttribute("data-channel-id", "dm-b")
    expect(route.container.textContent).not.toContain("dm-a")
  })

  it("keeps a transient error at the target and retries its resource without changing memory", async () => {
    mocks.verification.status = "error"
    render(React.createElement(DmRoute, { dmId: "dm-a" }))
    await setupUser().click(screen.getByRole("button", { name: "Retry" }))
    expect(mocks.verification.retry).toHaveBeenCalledOnce()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it.each([false, true])("purges explicit denial and retires only matching last memory, cold=%s", (cold) => {
    mocks.verification.status = "missing"
    mocks.cold = cold
    render(React.createElement(DmRoute, { dmId: "dm-a" }))
    expect(mocks.purge).toHaveBeenCalledExactlyOnceWith({}, "dm-a")
    expect(mocks.clear).toHaveBeenCalledOnce()
    expect(mocks.cancel).toHaveBeenCalledOnce()
    expect(mocks.consume).toHaveBeenCalledExactlyOnceWith("viewer", "/c/me/dm-a")
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(cold ? "/c/me/machines" : "/c/me")
  })

  it("does not erase another remembered DM when this target is denied", () => {
    mocks.verification.status = "missing"
    mocks.last = "dm-b"
    render(React.createElement(DmRoute, { dmId: "dm-a" }))
    expect(mocks.clear).not.toHaveBeenCalled()
  })
})
