import React, { useLayoutEffect, type PropsWithChildren } from "react"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { screen, setupUser } from "@/test/react-dom-harness"
import { renderCommunity } from "@/test/community-owner-harness"
import { DmRoute } from "./dm-route"

function RouteUi({ children }: PropsWithChildren) {
  const runtime = useCommunityRuntime()
  useLayoutEffect(() => {
    runtime.ui.actions.registerUiHandlers({ cancelPendingNavigation: mocks.cancel })
  }, [runtime])
  return children
}
function render(node: React.ReactNode) {
  return renderCommunity(node, { wrapper: RouteUi })
}

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
vi.mock("@/stores/community", async (importOriginal) => ({ ...await importOriginal<typeof import("@/stores/community")>(), useCommunityStore: { getState: () => ({ uiHandlers: { cancelPendingNavigation: mocks.cancel } }) } }))
vi.mock("@/lib/community-db/sync", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/community-db/sync")>(), purgeCommunityChannel: mocks.purge }))
vi.mock("@/lib/community/last-me-location", () => ({ ME_ROOT: "/c/me", getLastMeLeaf: () => mocks.last, clearLastMeLocation: mocks.clear }))
vi.mock("@/lib/community/last-community-route", () => ({
  COMMUNITY_COLD_ENTRY_FALLBACK: "/c/me/machines",
  consumeCommunityColdEntryFailure: (...args: unknown[]) => {
    mocks.consume(...args)
    const cold = mocks.cold
    mocks.cold = false
    return cold
  },
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
    expect(mocks.purge).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ accountId: "viewer" }), "dm-a")
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

  it("keeps a consumed cold fallback through Strict Mode effect replay", () => {
    mocks.verification.status = "missing"
    mocks.cold = true
    render(React.createElement(React.StrictMode, null, React.createElement(DmRoute, { dmId: "dm-a" })))
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/c/me/machines")
    expect(mocks.consume).toHaveBeenCalledOnce()
    expect(mocks.purge).toHaveBeenCalledOnce()
  })
})
