import { beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { CommunityModuleRouteContext } from "@/contexts/community/module-route"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { communityKeys } from "@/lib/query-keys"
import { friendsQueryFn } from "@/hooks/community/use-friends"
import { dmsProjectedQueryFn } from "@/hooks/community/use-dms"
import FriendsRoute from "../social/friends-route"
import { DmSidebarSlot } from "./dm-sidebar-slot"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: load }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop", useIsMobile: () => false }))
vi.mock("@/hooks/community/use-friends", async original => ({ ...await original<typeof import("@/hooks/community/use-friends")>(), useFriendsPresence: () => {} }))
vi.mock("@/hooks/community/use-inbox", () => ({ useInboxUnreads: () => ({ friendRequests: [] }) }))
beforeEach(() => { load.mockReset() })

type Kind = "friends" | "dms"
const friend = { id: "friendship", userId: "peer", name: "Cached person", discriminator: "0001", avatar: "P", status: "offline", sub: "" }
const dm = { id: "dm", userId: "peer", name: "Cached person", discriminator: "0001", avatar: "P", status: "offline", preview: "Cached conversation" }
const primaryPath = (kind: Kind) => kind === "friends" ? "/api/community/friends/accepted" : "/api/community/users/me/dms"
const key = (kind: Kind) => kind === "friends" ? communityKeys.friends() : communityKeys.dms()
const emptyText = (kind: Kind) => kind === "friends" ? "No friends yet. Add someone from the New tab." : "Your direct messages will appear here."
function response(path: string, populated = false) {
  if (path.endsWith("/accepted")) return { friends: populated ? [friend] : [] }
  if (path.endsWith("/blocked")) return { blocked: [] }
  if (path.endsWith("/pending")) return { pending: [] }
  if (path.endsWith("/dms")) return { conversations: populated ? [dm] : [] }
  throw new Error(`Unexpected list request: ${path}`)
}
function node(owner: Awaited<ReturnType<typeof createCommunityQueryOwner>>, kind: Kind) {
  const href = kind === "friends" ? "/c/me/friends" : "/c/me"
  return <CommunityTestProvider client={owner.client} registry={owner.registry}>
    <CurrentUserProvider initialUser={{ id: "viewer", name: "Viewer", avatar: "V", email: "viewer@example.test" }}>
      <CommunityRouteContext value={{ frame: { ...normalizeCommunityHref(href), revision: 1 } } as never}>
        <CommunityModuleRouteContext value={{ href, routeCommitted: false }}>
          {kind === "friends" ? <FriendsRoute /> : <DmSidebarSlot href={href} routeCommitted={false} />}
        </CommunityModuleRouteContext>
      </CommunityRouteContext>
    </CurrentUserProvider>
  </CommunityTestProvider>
}

it.each(["friends", "dms"] as const)("shows the real %s initial error and retries its native Query through loading to confirmed empty", async kind => {
  const owner = await createCommunityQueryOwner()
  let calls = 0
  let resolve!: () => void
  const held = new Promise<void>(done => { resolve = done })
  load.mockImplementation(async (path: string) => {
    if (path === primaryPath(kind)) {
      calls++
      if (calls === 1) throw new Error("Initial list unavailable")
      await held
    }
    return response(path)
  })
  const view = render(node(owner, kind))
  const alert = await view.findByRole("alert")
  expect(alert).toHaveTextContent(kind === "friends" ? "Couldn't load friends" : "Couldn't load direct messages")
  expect(owner.client.getQueryState(key(kind))).toMatchObject({ status: "error", fetchStatus: "idle", data: undefined })
  expect(view.queryByText(emptyText(kind))).toBeNull()
  if (kind === "dms") expect(view.getByRole("link", { name: "Friends" })).toBeVisible()
  fireEvent.click(view.getByRole("button", { name: "Retry" }))
  await waitFor(() => expect(calls).toBe(2))
  expect(owner.client.getQueryState(key(kind))).toMatchObject({ status: "pending", fetchStatus: "fetching", data: undefined })
  expect(view.queryByText(emptyText(kind))).toBeNull()
  expect(view.container.querySelector('[data-slot="skeleton"]')).not.toBeNull()
  await act(async () => { resolve() })
  expect(await view.findByText(emptyText(kind))).toBeVisible()
  expect(view.queryByRole("alert")).toBeNull()
  expect(owner.client.getQueryState(key(kind))).toMatchObject({ status: "success", data: { ids: [] } })
  expect(load.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true)
})

it.each([
  ["friends", false], ["friends", true], ["dms", false], ["dms", true],
] as const)("keeps the same qualified %s content through background failure (populated=%s)", async (kind, populated) => {
  const owner = await createCommunityQueryOwner()
  load.mockImplementation(async (path: string) => response(path, populated))
  const queryKey = key(kind)
  await owner.client.query({ queryKey, queryFn: kind === "friends" ? friendsQueryFn : dmsProjectedQueryFn(owner.client) })
  let reject!: (error: Error) => void
  const held = new Promise<never>((_, fail) => { reject = fail })
  load.mockImplementation((path: string) => path === primaryPath(kind) ? held : Promise.resolve(response(path, populated)))
  await owner.client.invalidateQueries({ queryKey, exact: true, refetchType: "none" })
  const view = render(node(owner, kind))
  const text = populated ? "Cached person" : emptyText(kind)
  const content = view.getByText(text)
  expect(content).toBeVisible()
  await waitFor(() => expect(owner.client.getQueryState(queryKey)?.fetchStatus).toBe("fetching"))
  await act(async () => { reject(new Error("Background list unavailable")) })
  await waitFor(() => expect(owner.client.getQueryState(queryKey)?.status).toBe("error"))
  expect(owner.client.getQueryData(queryKey)).toEqual({ ids: populated ? [kind === "friends" ? "friendship" : "dm"] : [] })
  expect(view.getByText(text)).toBe(content)
  expect(content).toBeVisible()
  expect(view.queryByRole("alert")).toBeNull()
})
