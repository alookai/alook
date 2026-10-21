import { beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { CommunityModuleRouteContext } from "@/contexts/community/module-route"
import { CommunityRouteContext, CommunityServerRouteContext } from "@/contexts/community/route-frame"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { communityKeys } from "@/lib/query-keys"
import { captureCommunityLiveSnapshotToken, publishCommunityLiveSnapshot } from "@/lib/community-db/sync"
import { serversProjectedQueryFn } from "@/hooks/community/use-servers"
import { getActiveAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
import { useCommunityNavigationController } from "./use-community-navigation-controller"
import ServerLandingRoute from "./server-landing-route"

const mocks = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), load: vi.fn(), breakpoint: "desktop" }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace, prefetch: mocks.prefetch }), usePathname: () => "/c/me", useSearchParams: () => new URLSearchParams() }))
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: mocks.load }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint }))
vi.mock("@/components/brand/alook-loading/AlookLoading", () => ({ AlookLoading: () => null }))
beforeEach(() => { vi.clearAllMocks(); mocks.breakpoint = "desktop"; mocks.load.mockImplementation(() => new Promise(() => {})) })

async function setup(method: "push" | "pushImmediate", { cold = false, empty = false, mobile = false } = {}) {
  const { client, registry } = await createCommunityQueryOwner()
  const server = { id: "target", name: "Target", discriminator: "0001", description: "", icon: null, ownerId: "viewer" }
  mocks.breakpoint = mobile ? "mobile" : "desktop"
  mocks.load.mockResolvedValueOnce({ servers: [{ ...server, role: "owner", memberId: "membership" }] })
  await client.query({ queryKey: communityKeys.servers(), queryFn: serversProjectedQueryFn(getActiveAccountUnreadProjection(client), client) })
  const channels = empty ? [] : [{ id: "channel", name: "Channel", active: false, unread: false, muted: false, type: "text" as const }]
  if (!cold) {
    publishCommunityLiveSnapshot(client, {
      snapshot: { kind: "server-detail", data: { ...server, categories: [{ id: "category", name: "", private: 0, channels }] } },
      proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(client), signal: undefined },
    })
    client.setQueryData(communityKeys.server(server.id), server.id)
  }
  let release!: () => void
  const response = new Promise<void>(resolve => { release = resolve })
  mocks.load.mockImplementation(async (path: string) => {
    await response
    if (path.endsWith("/categories")) return { categories: [{ id: "category", name: "", private: 0 }] }
    if (path.endsWith("/channels")) return { channels: channels.map(channel => ({ ...channel, categoryId: "category" })) }
    throw new Error(`Unexpected request ${path}`)
  })
  const calls: string[] = []
  mocks.push.mockImplementation((href: string) => { calls.push(href) })
  mocks.replace.mockImplementation((href: string) => { calls.push(href) })
  const frame = { ...normalizeCommunityHref("/c/me"), revision: 0 }
  let navigation!: ReturnType<typeof useCommunityNavigationController>
  function Harness() {
    navigation = useCommunityNavigationController(frame)
    const href = navigation.pendingHref ?? frame.href
    return <CommunityRouteContext value={{ breakpoint: "desktop", frame, navigation, ownerDeleteRouteScope: undefined }}>
      <button onClick={() => navigation[method]("/c/channels/target")}>Open server</button>
      <output data-testid="pending">{href}</output>
      {href === "/c/channels/target" && <CommunityModuleRouteContext value={{ href, routeCommitted: false }}>
        <CommunityServerRouteContext value={{ serverId: server.id, serverParam: server.id }}><ServerLandingRoute /></CommunityServerRouteContext>
      </CommunityModuleRouteContext>}
    </CommunityRouteContext>
  }
  const view = render(<CommunityTestProvider client={client} registry={registry}>
    <CurrentUserProvider initialUser={{ id: "viewer", name: "Viewer", avatar: "V", email: "viewer@example.test" }}><Harness /></CurrentUserProvider>
  </CommunityTestProvider>)
  return { view, calls, release, get navigation() { return navigation } }
}

it.each(["push", "pushImmediate"] as const)("keeps the actual landing consumer's leaf as the final native dispatch during %s", async method => {
  const test = await setup(method)
  const { view, calls } = test
  let releaseOlder!: (href: string) => void
  let older!: Promise<boolean>
  await act(async () => { older = test.navigation.resolveAndPush(() => new Promise(resolve => { releaseOlder = resolve })) })
  const oldIntent = test.navigation.captureIntent()
  fireEvent.click(view.getByRole("button", { name: "Open server" }))
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/c/channels/target/channel"))
  expect(view.getByTestId("pending")).toHaveTextContent("/c/channels/target/channel")
  expect(calls).toEqual(["/c/channels/target/channel"])
  expect(oldIntent()).toBe(false)
  await act(async () => { releaseOlder("/c/channels/old/channel"); expect(await older).toBe(false) })
  expect(calls).toEqual(["/c/channels/target/channel"])
})

it.each(["push", "pushImmediate"] as const)("submits the root then the native leaf when cold server data arrives after %s", async method => {
  const { view, calls, release } = await setup(method, { cold: true })
  fireEvent.click(view.getByRole("button", { name: "Open server" }))
  expect(calls).toEqual(["/c/channels/target"])
  await act(async () => { release() })
  await waitFor(() => expect(calls).toEqual(["/c/channels/target", "/c/channels/target/channel"]))
})

it.each([{ empty: true }, { mobile: true }])("retains the root when the real landing consumer has no desktop leaf redirect: %j", async options => {
  const { view, calls } = await setup("push", options)
  fireEvent.click(view.getByRole("button", { name: "Open server" }))
  await act(async () => {})
  expect(calls).toEqual(["/c/channels/target"])
  expect(mocks.replace).not.toHaveBeenCalled()
  if (options.empty) expect(view.getByText("No channels yet")).toBeVisible()
})
