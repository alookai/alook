import React from "react"
import { renderToString } from "react-dom/server"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { beforeEach, describe, expect, it, vi } from "vitest"
import MeFriendsPage from "./page"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { useCommunityNavigationController } from "@/components/community/shell/use-community-navigation-controller"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { normalizeCommunityHref, resolveCommunityCheckpointPlan, type CommunityCommittedFrame } from "@/lib/community/community-route"
import { CommunityModuleRouteContext } from "@/contexts/community/module-route"

const mocks = vi.hoisted(() => ({ breakpoint: "unknown", props: vi.fn(), back: vi.fn(), realPage: false, pathname: "/c/channels/source/channel", search: "", push: vi.fn(), replace: vi.fn() }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint }))
vi.mock("next/navigation", () => ({ useRouter: () => ({push: mocks.push, replace: mocks.replace}), usePathname: () => mocks.pathname, useSearchParams: () => new URLSearchParams(mocks.search) }))
vi.mock("@/hooks/community/use-friends", () => ({ useFriends: () => ({ friends: [], pending: [], blocked: [], isPending: !mocks.realPage }) }))
vi.mock("@/stores/community", () => ({ useUiHandlers: () => ({ goBackMobile: mocks.back }) }))
vi.mock("@/lib/community-db/projections", async original => ({...await original<typeof import("@/lib/community-db/projections")>(), useCanonicalProfilesByUserId: () => new Map()}))
vi.mock("@/hooks/community/mutations", () => {
  const mutation = () => ({ mutateAsync: vi.fn(), mutate: vi.fn() })
  return { useSendFriendRequest: mutation, useAcceptFriendRequest: mutation, useRejectFriendRequest: mutation,
    useCancelBotFriendRequest: mutation, useRemoveFriend: mutation, useBlockUser: mutation,
    useUnblockUser: mutation, useCreateOrGetDm: mutation }
})
vi.mock("@/components/community/social/friends-page", async original => {
  const actual = await original<typeof import("@/components/community/social/friends-page")>()
  return {...actual, FriendsPage: (props: React.ComponentProps<typeof actual.FriendsPage>) => { mocks.props(props); return mocks.realPage ? <actual.FriendsPage {...props} /> : null }}
})

beforeEach(() => { mocks.props.mockClear(); mocks.back.mockClear(); mocks.realPage = false; mocks.push.mockClear(); mocks.replace.mockClear(); mocks.pathname = "/c/channels/source/channel"; mocks.search = "" })

async function pendingFriends() {
  mocks.realPage = true
  const owner = await createCommunityQueryOwner()
  let committedFrame: CommunityCommittedFrame = {...normalizeCommunityHref(mocks.pathname), revision: 0}
  let navigation!: ReturnType<typeof useCommunityNavigationController>
  function Scenario() {
    const currentNavigation = useCommunityNavigationController(committedFrame)
    React.useLayoutEffect(() => { navigation = currentNavigation }, [currentNavigation])
    const checkpoint = resolveCommunityCheckpointPlan({committedFrame, targetHref: currentNavigation.pendingHref ?? currentNavigation.publishedHref, pending: currentNavigation.navigationPending, targetReady: true})
    return <CommunityRouteContext value={{frame: committedFrame, navigation: currentNavigation, breakpoint: "desktop", ownerDeleteRouteScope: undefined}}>
      {checkpoint.main.kind === "module-route" ? <CommunityModuleRouteContext value={{href: checkpoint.main.href, routeCommitted: !currentNavigation.navigationPending}}><MeFriendsPage /></CommunityModuleRouteContext> : null}
    </CommunityRouteContext>
  }
  const node = () => <CommunityTestProvider client={owner.client} registry={owner.registry} retainOwner><Scenario /></CommunityTestProvider>
  const view = render(node())
  act(() => navigation.pushImmediate("/c/me/friends?tab=new"))
  return {view, get navigation() { return navigation }, publish(href: string) {
    const url = new URL(href, "https://alook.test")
    mocks.pathname = url.pathname; mocks.search = url.search.slice(1)
    committedFrame = {...normalizeCommunityHref(url.pathname), revision: 1}
    view.rerender(node())
  }}
}

describe("friends route initial mobile back ownership", () => {
  it("changes the real New tab to All before route delivery through the latest navigation owner", async () => {
    const page = await pendingFriends()
    expect(page.view.getByRole("tab", {name: "New"})).toHaveAttribute("aria-selected", "true")
    const original = page.navigation.captureIntent()
    fireEvent.click(page.view.getByRole("tab", {name: "All"}))
    expect(page.navigation.pendingHref).toBe("/c/me/friends")
    expect(original()).toBe(false)
    expect(page.view.getByRole("tab", {name: "All"})).toHaveAttribute("aria-selected", "true")
    expect(mocks.pathname).toBe("/c/channels/source/channel")
  })

  it("keeps a newer All intent when the old New-tab response publishes first", async () => {
    const page = await pendingFriends()
    act(() => page.navigation.replace("/c/me/friends"))
    page.publish("/c/me/friends?tab=new")
    expect(page.navigation.navigationPending).toBe(true)
    expect(page.navigation.pendingHref).toBe("/c/me/friends")
    expect(page.view.getByRole("tab", {name: "All"})).toHaveAttribute("aria-selected", "true")
    page.publish("/c/me/friends")
    expect(page.navigation.navigationPending).toBe(false)
    expect(page.view.getByRole("tab", {name: "All"})).toHaveAttribute("aria-selected", "true")
  })

  it("uses pending target tab parameters while Next still publishes the old search", () => {
    const node = (href: string, routeCommitted: boolean) => <CommunityModuleRouteContext value={{href, routeCommitted}}><MeFriendsPage /></CommunityModuleRouteContext>
    const view = render(node("/c/me/friends?tab=new", false))
    expect(mocks.props.mock.calls.at(-1)![0]).toMatchObject({activeTab: "new"})
    view.rerender(node("/c/me/friends?tab=all", false))
    expect(mocks.props.mock.calls.at(-1)![0]).toMatchObject({activeTab: "all"})
    view.rerender(node("/c/me/friends?tab=all", true))
    expect(mocks.props.mock.calls.at(-1)![0]).toMatchObject({activeTab: "all"})
  })

  it.each(["unknown", "mobile", "desktop"])("supplies the same viewport-owned Back action at %s", (breakpoint) => {
    mocks.breakpoint = breakpoint
    renderToString(<MeFriendsPage />)
    const props = mocks.props.mock.calls.at(-1)![0] as { onBack?: () => void }
    expect(props.onBack).toBeTypeOf("function")
    const view = render(<MeFriendsPage />)
    const clientProps = mocks.props.mock.calls.at(-1)![0] as { onBack?: () => void }
    expect(clientProps.onBack).toBeTypeOf("function")
    props.onBack!()
    clientProps.onBack!()
    expect(mocks.back).toHaveBeenCalledTimes(2)
    view.unmount()
  })
})
