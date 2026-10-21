import { beforeEach, expect, it, vi } from "vitest"
import { useLayoutEffect } from "react"
import { act, fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { CommunityModuleRouteContext } from "@/contexts/community/module-route"
import { CommunityRouteContext, CommunityServerRouteContext } from "@/contexts/community/route-frame"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { communityKeys } from "@/lib/query-keys"
import { captureCommunityLiveSnapshotToken, publishCommunityLiveSnapshot } from "@/lib/community-db/sync"
import { serversProjectedQueryFn, useServer } from "@/hooks/community/use-servers"
import { getActiveAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
import { beginOwnerServerDelete, commitOwnerServerDelete, createOwnerServerDeleteRouteToken, observeOwnerServerDeleteRouteCommit } from "@/lib/community/eject-server"
import { flushOwnerServerDeleteRouteCommit } from "@/hooks/community/community-ws/scope-eviction"
import { useCommunityNavigationController } from "./use-community-navigation-controller"
import ServerLandingRoute from "./server-landing-route"

const mocks = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), load: vi.fn(), breakpoint: "desktop" }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace, prefetch: mocks.prefetch }), usePathname: () => "/c/me", useSearchParams: () => new URLSearchParams() }))
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: mocks.load }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint }))
vi.mock("@/components/brand/alook-loading/AlookLoading", () => ({ AlookLoading: () => null }))
beforeEach(() => { vi.clearAllMocks(); mocks.breakpoint = "desktop"; mocks.load.mockImplementation(() => new Promise(() => {})) })

function ServerRead({ enabled }: { enabled: boolean }) {
  useServer(enabled ? "target" : null)
  return null
}

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
    const current = useCommunityNavigationController(frame)
    useLayoutEffect(() => { navigation = current }, [current])
    const href = current.pendingHref ?? frame.href
    return <CommunityRouteContext value={{ breakpoint: "desktop", frame, navigation: current, ownerDeleteRouteScope: undefined }}>
      <button onClick={() => current[method]("/c/channels/target")}>Open server</button>
      <output data-testid="pending">{href}</output>
      <ServerRead enabled={href.startsWith("/c/channels/target")} />
      {href === "/c/channels/target" && <CommunityModuleRouteContext value={{ href, routeCommitted: false }}>
        <CommunityServerRouteContext value={{ serverId: server.id, serverParam: server.id }}><ServerLandingRoute /></CommunityServerRouteContext>
      </CommunityModuleRouteContext>}
    </CommunityRouteContext>
  }
  const view = render(<CommunityTestProvider client={client} registry={registry}>
    <CurrentUserProvider initialUser={{ id: "viewer", name: "Viewer", avatar: "V", email: "viewer@example.test" }}><Harness /></CurrentUserProvider>
  </CommunityTestProvider>)
  return { view, calls, release, client, registry, get navigation() { return navigation } }
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

it("finishes the current root after an older server deletion retires its in-flight detail proof", async () => {
  const { view, calls, release, client, registry } = await setup("push", { cold: true })
  const token = createOwnerServerDeleteRouteToken(client)
  act(() => {
    publishCommunityLiveSnapshot(client, {
      snapshot: { kind: "server-detail", data: { id: "deleted", name: "Deleted", discriminator: "0002", description: "", icon: null, ownerId: "viewer", categories: [{ id: "old-category", name: "", private: 0, channels: [{ id: "old-channel", name: "Old", active: false, unread: false }] }] } },
      proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(client), signal: undefined },
    })
    beginOwnerServerDelete(client, "deleted", token)
    expect(commitOwnerServerDelete(client, "deleted", token)).toBe(false)
  })
  fireEvent.click(view.getByRole("button", { name: "Open server" }))
  await waitFor(() => expect(mocks.load.mock.calls.some(([path]) => String(path).endsWith("/target/channels"))).toBe(true))
  const original = client.getQueryCache().find({ queryKey: communityKeys.server("target"), exact: true })!
  expect(original.state.fetchStatus).toBe("fetching")
  await act(async () => {
    observeOwnerServerDeleteRouteCommit(client, "/c/channels/target")
    expect(flushOwnerServerDeleteRouteCommit(client)).toEqual(["deleted"])
    release()
  })
  await waitFor(() => expect(calls.at(-1)).toBe("/c/channels/target/channel"))
  await waitFor(() => {
    expect(original.state.fetchStatus).toBe("idle")
    expect(original.state.error).toBeNull()
  })
  expect(client.getQueryCache().find({ queryKey: communityKeys.server("target"), exact: true })).toBe(original)
  expect(registry.collections.servers.get("deleted")).toBeUndefined()
  expect(registry.collections.servers.get("target")?.detailComplete).toBe(true)
  expect(original.state.error).toBeNull()
  expect(mocks.load.mock.calls.filter(([path]) => String(path).endsWith("/target/categories"))).toHaveLength(2)
})
