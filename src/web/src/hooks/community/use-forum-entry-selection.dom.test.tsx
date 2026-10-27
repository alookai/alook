import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { forumConversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { writeForumTagSelection } from "@/lib/community/forum-tag-selection"
import { useChannelRouteModel } from "./use-channel-route-model"
import { useChannelMetadata } from "./use-channel-metadata"
import { useForumFeed } from "./use-forum-feed"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => load(...args) }))
vi.mock("next/navigation", () => ({ usePathname: () => window.location.pathname, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock("./use-servers", () => ({ useServer: () => ({ server: null, isError: false, isFetching: false }) }))
vi.mock("./use-community-ws", () => ({ communityWsSubscribe: vi.fn(), communityWsUnsubscribe: vi.fn() }))
vi.mock("./use-channel-panels", () => ({ useForumTags: () => ({ data: { tags: ["beta", "gamma"] }, isSuccess: true }) }))
beforeEach(() => { load.mockReset(); localStorage.clear(); window.history.replaceState(null, "", "/c/channels/s1/c1") })
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); window.history.replaceState(null, "", "/") })

it.each(["URL", "saved"] as const)("shares one cold %s-tag entry between route metadata and Forum body", async source => {
  const owner = await createCommunityQueryOwner()
  const value = forumConversationEntryFixture()
  value.forumFeed!.included.tags = [{ messageId: "m1", tag: "beta" }]
  if (source === "saved") writeForumTagSelection(localStorage, "c1", "beta")
  else window.history.replaceState(null, "", "/c/channels/s1/c1?tag=beta")
  let release!: () => void
  load.mockImplementation(() => new Promise(resolve => { release = () => resolve(value) }))
  const hook = renderHook(() => ({
    route: useChannelRouteModel("s1", "s1", "c1", "viewer", null, source === "URL" ? "beta" : null),
    feed: useForumFeed("s1", "c1", source === "URL" ? { routeTag: "beta" } : undefined),
  }), { wrapper: ({ children }) => <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}>{children}</CommunityDbProvider></QueryClientProvider> })
  await waitFor(() => expect(release).toBeTypeOf("function"))
  expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/messages?entry=1&tag=beta"])
  await act(async () => release())
  await waitFor(() => expect(hook.result.current.feed.posts.map(post => post.id)).toEqual(["t1"]))
  expect(hook.result.current.route.routeLifecycle).toBe("ready")
  expect(load).toHaveBeenCalledOnce()
  hook.unmount()
})

it("updates metadata and body from the same-window saved selection without an extra All read", async () => {
  const owner = await createCommunityQueryOwner()
  writeForumTagSelection(localStorage, "c1", "beta")
  load.mockImplementation((url: string) => {
    const value = forumConversationEntryFixture()
    value.forumFeed!.included.tags = [{ messageId: "m1", tag: url.includes("gamma") ? "gamma" : "beta" }]
    return value
  })
  const hook = renderHook(() => ({ metadata: useChannelMetadata("s1", "c1"), feed: useForumFeed("s1", "c1") }), {
    wrapper: ({ children }) => <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}>{children}</CommunityDbProvider></QueryClientProvider>,
  })
  await waitFor(() => expect(hook.result.current.feed.data).toBeDefined())
  await act(async () => hook.result.current.feed.selectTag("gamma"))
  await waitFor(() => expect(hook.result.current.feed.tag).toBe("gamma"))
  expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/messages?entry=1&tag=beta", "/api/community/channels/c1/messages?entry=1&tag=gamma"])
  hook.unmount()
})

it("keeps tag selection usable when storage writes fail", async () => {
  const owner = await createCommunityQueryOwner()
  load.mockImplementation(() => forumConversationEntryFixture())
  const hook = renderHook(() => useForumFeed("s1", "c1"), { wrapper: ({ children }) => <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}>{children}</CommunityDbProvider></QueryClientProvider> })
  await waitFor(() => expect(hook.result.current.data).toBeDefined())
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable") })
  await act(async () => hook.result.current.selectTag("beta"))
  expect(hook.result.current.tag).toBe("beta")
  hook.unmount()
})
