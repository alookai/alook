import { dmListRowFixture } from "@/test/community-resource-fixtures"
import React, { useLayoutEffect, type PropsWithChildren } from "react"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, screen, setupUser, waitFor } from "@/test/react-dom-harness"
import { renderCommunity, renderCommunityHook } from "@/test/community-owner-harness"
import { DmRoute } from "./dm-route"
import { useChannelMetadata } from "@/hooks/community/use-channel-metadata"
import { COMMUNITY_CONTRACT_HEADER, BUSINESS_SCHEMA_VERSION, CommunityReadErrorSchema } from "@alook/shared"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import { ingestDms } from "@/lib/community-db/sync"

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
  realMetadata: false,
  verification: { status: "pending", identityKnown: false, retrying: false, retry: vi.fn(), denialCode: undefined as import("@/lib/errors").CommunityApiError["code"] | undefined },
  breakpoint: "desktop",
  last: "dm-a",
  cold: false,
  replace: vi.fn(), clear: vi.fn(), purge: vi.fn(), cancel: vi.fn(), consume: vi.fn(),
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }))
vi.mock("@/contexts/community/current-user", () => ({ useCurrentUser: () => ({ id: "viewer" }) }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint }))
vi.mock("@/hooks/community/use-channel-metadata", async importOriginal => {
  const actual=await importOriginal<typeof import("@/hooks/community/use-channel-metadata")>()
  return {...actual,useChannelMetadata:(...args:Parameters<typeof actual.useChannelMetadata>)=>mocks.realMetadata ? actual.useChannelMetadata(...args) : mocks.verification}
})
vi.mock("@/stores/community", async (importOriginal) => ({ ...await importOriginal<typeof import("@/stores/community")>(), useCommunityStore: { getState: () => ({ uiHandlers: { cancelPendingNavigation: mocks.cancel } }) } }))
vi.mock("@/lib/community-db/sync", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/community-db/sync")>(), purgeCommunityChannel: mocks.purge }))
vi.mock("@/lib/community/last-me-location", () => ({ ME_ROOT: "/c/me", getLastMeLeaf: () => mocks.last, clearLastMeLocation: () => { mocks.clear(); mocks.last = "" } }))
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
vi.mock("./dm-route-error-frame", () => ({ DmRouteErrorFrame: ({ onRetry, retrying, reserveBackSlot }: { onRetry: () => void; retrying: boolean; reserveBackSlot?: boolean }) => React.createElement("button", { onClick: onRetry, disabled: retrying, "data-back": String(reserveBackSlot) }, "Retry") }))

afterEach(()=>vi.unstubAllGlobals())
beforeEach(() => {
  mocks.realMetadata=false
  mocks.verification.denialCode=undefined
  mocks.verification.status = "pending"
  mocks.verification.identityKnown = false
  mocks.verification.retrying = false
  mocks.breakpoint = "desktop"
  mocks.last = "dm-a"
  mocks.cold = false
  for (const callback of [mocks.replace, mocks.clear, mocks.purge, mocks.cancel, mocks.consume, mocks.verification.retry]) callback.mockClear()
})

describe("DM target main owns identity, retry and fallback", () => {
  it.each(["pending", "retryable-error", "denied"])("keeps canonical DM presentation while entry is %s without granting read permission", async status => {
    const owner = renderCommunityHook(() => useOptionalCommunityDbRegistry()).result.current!
    await act(async () => { ingestDms(owner, { conversations: [dmListRowFixture({ id: "dm-a", userId: "peer", name: "Peer", discriminator: "0042", avatar: "/avatar", avatarVersion: 1, status: "offline", preview: "" })] }) })
    mocks.verification.status = status
    expect(mocks.verification.identityKnown).toBe(false)
    const route = render(React.createElement(DmRoute, { dmId: "dm-a" }))
    await waitFor(() => expect(route.container.querySelector("main")).toHaveAttribute("data-channel-id", "dm-a"))
    expect(screen.queryByTestId("dm-pending")).toBeNull()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(mocks.verification.identityKnown).toBe(false)
  })

  it("reserves the target frame on mobile and mounts only the qualified explicit ID", () => {
    mocks.breakpoint = "mobile"
    const route = render(React.createElement(DmRoute, { dmId: "dm-a" }))
    expect(screen.getByTestId("dm-pending")).toHaveAttribute("data-back", "true")
    expect(route.container.querySelector("main")).toBeNull()
    expect(mocks.replace).not.toHaveBeenCalled()
    mocks.verification.status = "readable"
    route.rerender(React.createElement(DmRoute, { dmId: "dm-b" }))
    expect(route.container.querySelector("main")).toHaveAttribute("data-channel-id", "dm-b")
    expect(route.container.textContent).not.toContain("dm-a")
  })

  it("keeps a known DM mounted during position wait and terminal denial", () => {
    mocks.verification.identityKnown = true
    const route = render(React.createElement(DmRoute, { dmId: "dm-a" }))
    const frame = route.container.querySelector("main")
    expect(frame).toHaveAttribute("data-channel-id", "dm-a")
    mocks.verification.status = "denied"
    route.rerender(React.createElement(DmRoute, { dmId: "dm-a" }))
    expect(route.container.querySelector("main")).toBe(frame)
    expect(screen.queryByTestId("dm-pending")).toBeNull()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it("keeps a transient error at the target and retries its resource without changing memory", async () => {
    mocks.verification.status = "retryable-error"
    render(React.createElement(DmRoute, { dmId: "dm-a" }))
    await setupUser().click(screen.getByRole("button", { name: "Retry" }))
    expect(mocks.verification.retry).toHaveBeenCalledOnce()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it("does not replace or clear memory for a denied pending target before route publication", () => {
    mocks.verification.status = "denied"
    const view = render(React.createElement(DmRoute, { dmId: "dm-a", routeCommitted: false }))
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(mocks.cancel).not.toHaveBeenCalled()
    view.rerender(React.createElement(DmRoute, { dmId: "dm-a", routeCommitted: true }))
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/c/me")
    expect(mocks.clear).toHaveBeenCalledOnce()
  })

  it.each([false, true])("exits an unknown denied target and retires only matching last memory, cold=%s", (cold) => {
    mocks.verification.status = "denied"
    mocks.cold = cold
    render(React.createElement(DmRoute, { dmId: "dm-a" }))
    expect(mocks.purge).not.toHaveBeenCalled()
    expect(mocks.clear).toHaveBeenCalledOnce()
    expect(mocks.cancel).toHaveBeenCalledOnce()
    expect(mocks.consume).toHaveBeenCalledExactlyOnceWith("viewer", "/c/me/dm-a")
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(cold ? "/c/me/machines" : "/c/me")
  })

  it("does not erase another remembered DM when this target is denied", () => {
    mocks.verification.status = "denied"
    mocks.last = "dm-b"
    render(React.createElement(DmRoute, { dmId: "dm-a" }))
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it("keeps a consumed cold fallback through Strict Mode effect replay", () => {
    mocks.verification.status = "denied"
    mocks.cold = true
    render(React.createElement(React.StrictMode, null, React.createElement(DmRoute, { dmId: "dm-a" })))
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/c/me/machines")
    expect(mocks.consume).toHaveBeenCalledOnce()
    expect(mocks.purge).not.toHaveBeenCalled()
  })
})

describe("DM unknown viewport keeps the same responsive leading footprint", () => {
  it.each(["pending", "retryable-error"])("reserves mobile leading space before breakpoint detection in %s", status => {
    mocks.breakpoint = "unknown"
    mocks.verification.status = status
    const view = render(React.createElement(DmRoute, { dmId: "dm-a" }))
    const frame = status === "pending" ? screen.getByTestId("dm-pending") : screen.getByRole("button", { name: "Retry" })
    expect(frame).toHaveAttribute("data-back", "true")
    view.unmount()
  })
})

it.each([["blocked",403],["not_allowed",403],["not_found",404]] as const)("uses real HTTP metadata to distinguish %s with no current native identity",async(code,status)=>{
  mocks.realMetadata=true
  const registry=renderCommunityHook(()=>useOptionalCommunityDbRegistry()).result.current!
  let release!:(response:Response)=>void
  const fetch=vi.fn(()=>new Promise<Response>(resolve=>{release=resolve}))
  vi.stubGlobal("fetch",fetch)
  const metadata=renderCommunityHook(()=>useChannelMetadata(null,"dm-a"))
  const view=render(React.createElement(DmRoute,{dmId:"dm-a"}))
  try {
    await waitFor(()=>expect(fetch).toHaveBeenCalledOnce())
    expect(registry.collections.channels.has("dm-a")).toBe(false)
    expect(metadata.result.current.status).toBe("pending")
    const payload=CommunityReadErrorSchema.parse({contractVersion:BUSINESS_SCHEMA_VERSION,error:{code,message:code,retryable:false}})
    await act(async()=>{release(new Response(JSON.stringify(payload),{status,headers:{"content-type":"application/json",[COMMUNITY_CONTRACT_HEADER]:String(BUSINESS_SCHEMA_VERSION)}}))})
    await waitFor(()=>expect(metadata.result.current.status).toBe("denied"))
    expect(metadata.result.current).toMatchObject({denialCode:code,identityKnown:false,canRead:false,revoked:true})
    expect(metadata.result.current.error).toBeNull()
    expect(registry.collections.messages.size).toBe(0)
    if(code==="blocked") {
      expect(view.container.querySelector("main")).toHaveAttribute("data-channel-id","dm-a")
      expect(mocks.replace).not.toHaveBeenCalled()
      expect(mocks.clear).not.toHaveBeenCalled()
      expect(mocks.cancel).not.toHaveBeenCalled()
    } else {
      expect(view.container.querySelector("main")).toBeNull()
      expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/c/me")
      expect(mocks.clear).toHaveBeenCalledOnce()
    }
  } finally {view.unmount();metadata.unmount();await registry.queryClient.cancelQueries()}
})
