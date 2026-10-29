import { resourceBundleFixture, forumFeedScenarioFixture, friendBucketScenarioFixture } from "@/test/community-resource-fixtures"
import { afterEach, expect, it, vi } from "vitest"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, forumConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { communityKeys } from "@/lib/query-keys"
import { ConversationActivityContext, ConversationPresentationContext } from "@/contexts/community/conversation-activity"
import { useMessages } from "./use-messages"
import { usePins, useThreads } from "./use-channel-panels"
import { useFriends } from "./use-friends"
import { useNotificationSettings } from "./use-notification-settings"
import { useDms } from "./use-dms"
import { useForumFeed } from "./use-forum-feed"

const emptyPins = () => ({ pins: [], resources: resourceBundleFixture() })
const emptyThreads = () => forumFeedScenarioFixture("c1", { serverId: "s1", parentType: "text", threads: [], included: {}, hasMore: false })

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => load(...args) }))
afterEach(() => { load.mockReset(); localStorage.clear() })

it("retains hidden message and panel caches without starting requests, then loads the presented pending route before commit", async () => {
  const owner = await createCommunityQueryOwner()
  const value = conversationEntryFixture()
  const seeded = await seedConversationEntry(owner.client, value)
  owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
  owner.client.setQueryData(communityKeys.pins("c1"), { pins: [] }, { updatedAt: 1 })
  owner.client.setQueryData(communityKeys.threads("c1"), { parentChannelId: "c1", parentType: "text", serverId: "s1", threads: [] }, { updatedAt: 1 })
  let presented = false
  const held = new Promise(() => {})
  load.mockImplementation(async (url: string) => url.includes("entry=1") ? held : url.endsWith("/pins") ? emptyPins()
    : emptyThreads())
  const hook = renderHook(() => ({ feed: useMessages("c1", { serverId: "s1" }), pins: usePins("c1"), threads: useThreads("c1") }), {
    wrapper: ({ children }) => <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}>
      <ConversationActivityContext value={false}><ConversationPresentationContext value={presented}>{children}</ConversationPresentationContext></ConversationActivityContext>
    </CommunityDbProvider></QueryClientProvider>,
  })
  expect(hook.result.current.feed.messages.map(message => message.id)).toEqual(["m1"])
  expect(owner.client.getQueryData(seeded.resource.windowKey)).toBeDefined()
  expect(hook.result.current.feed.jumpToPresent().accepted).toBe(false)
  await act(async () => { await Promise.resolve() })
  expect(load).not.toHaveBeenCalled()
  presented = true
  hook.rerender()
  await waitFor(() => expect(load.mock.calls.map(([url]) => String(url))).toHaveLength(3))
  expect(load.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
    "/api/community/channels/c1/messages?entry=1", "/api/community/channels/c1/pins",
    "/api/community/channels/c1/threads?include=parentMessage,firstMessage,tags,participants&archived=false",
  ]))
  expect(hook.result.current.feed.messages.map(message => message.id)).toEqual(["m1"])
  hook.unmount()
})

it("reuses the entry-provided Forum first page instead of starting a parallel threads request", async () => {
  localStorage.clear()
  const owner = await createCommunityQueryOwner()
  const value = forumConversationEntryFixture()
  await seedConversationEntry(owner.client, value)
  owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
  owner.client.removeQueries({ queryKey: communityKeys.forumFeed("c1", null), exact: true })
  let release!: () => void
  load.mockImplementation(async (url: string) => url.includes("entry=1") ? new Promise(resolve => { release = () => resolve(value) }) : { tags: [] })
  const hook = renderHook(() => useForumFeed("s1", "c1"), {
    wrapper: ({ children }) => <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}>{children}</CommunityDbProvider></QueryClientProvider>,
  })
  await waitFor(() => expect(release).toBeTypeOf("function"))
  expect(load.mock.calls.some(([url]) => String(url).includes("/threads"))).toBe(false)
  await act(async () => release())
  await waitFor(() => expect(hook.result.current.posts.map(post => post.id)).toEqual(["t1"]))
  expect(load.mock.calls.some(([url]) => String(url).includes("/threads"))).toBe(false)
  hook.unmount()
})

it("shares account collections with subscribed consumers without refreshing them on consumer mount", async () => {
  const owner = await createCommunityQueryOwner()
  load.mockImplementation(async (url: string) => url.endsWith("/accepted") ? friendBucketScenarioFixture("friends", [])
    : url.endsWith("/blocked") ? friendBucketScenarioFixture("blocked", []) : url.endsWith("/pending") ? friendBucketScenarioFixture("pending", [])
      : url.endsWith("/dms") ? { conversations: [] } : [])
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}>{children}</CommunityDbProvider></QueryClientProvider>
  const consumer = renderHook(() => ({ friends: useFriends({ enabled: false }), settings: useNotificationSettings(false), dms: useDms(false, true) }), { wrapper })
  await act(async () => { await Promise.resolve() })
  expect(load).not.toHaveBeenCalled()
  const shared = renderHook(() => ({ friends: useFriends(), settings: useNotificationSettings(), dms: useDms() }), { wrapper })
  await waitFor(() => expect(shared.result.current.friends.isSuccess && shared.result.current.settings.isSuccess && shared.result.current.dms.isSuccess).toBe(true))
  expect(load).toHaveBeenCalledTimes(5)
  expect(consumer.result.current.friends.isSuccess && consumer.result.current.settings.isSuccess && consumer.result.current.dms.isSuccess).toBe(true)
  owner.client.setQueryDefaults(communityKeys.friends(), { staleTime: 0 })
  owner.client.setQueryDefaults(communityKeys.dms(), { staleTime: 0 })
  const another = renderHook(() => ({ friends: useFriends({ enabled: false }), settings: useNotificationSettings(false), dms: useDms(false, true) }), { wrapper })
  await act(async () => { await Promise.resolve() })
  expect(load).toHaveBeenCalledTimes(5)
  await act(async () => { await owner.client.invalidateQueries({ queryKey: communityKeys.friends(), exact: true }) })
  expect(load).toHaveBeenCalledTimes(8)
  expect(another.result.current.friends.isSuccess).toBe(true)
  another.unmount(); consumer.unmount(); shared.unmount()
})

it("reads the complete active threads only on panel demand and keeps pin status available while closed", async () => {
  const owner = await createCommunityQueryOwner()
  let requested = false
  load.mockImplementation(async (url: string) => url.endsWith("/pins") ? emptyPins() : emptyThreads())
  const hook = renderHook(() => ({ threads: useThreads("c1", requested), pins: usePins("c1") }), {
    wrapper: ({ children }) => <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}>{children}</CommunityDbProvider></QueryClientProvider>,
  })
  await waitFor(() => expect(hook.result.current.pins.isSuccess).toBe(true))
  expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/pins"])
  requested = true; hook.rerender()
  await waitFor(() => expect(hook.result.current.threads.isSuccess).toBe(true))
  expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/pins", "/api/community/channels/c1/threads?include=parentMessage,firstMessage,tags,participants&archived=false"])
  requested = false; hook.rerender()
  expect(hook.result.current.threads.data?.threads).toEqual([])
  hook.unmount()
})
