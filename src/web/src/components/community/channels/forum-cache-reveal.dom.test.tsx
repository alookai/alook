import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { forumConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { communityKeys } from "@/lib/query-keys"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize } from "@/test/message-scroll-fixture"
import { ForumSurface } from "./forum-surface"
import { ForumPostList } from "./forum-post-list"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: load }))
vi.mock("@/hooks/community/use-channel-panels", () => ({ useForumTags: () => ({ data: { tags: [] }, isSuccess: true }) }))
vi.mock("@/hooks/community/use-read-observer", () => ({ useTimelineReadObserver: () => {} }))
vi.mock("./forum-view", () => ({ ForumView: (props: Parameters<typeof ForumPostList>[0]) => <ForumPostList {...props}
  loadingContent={<span>Loading actual cards</span>} renderPost={post => <div data-msg-id={post.openerMessageId}>{post.name}</div>} /> }))
beforeEach(() => { installMessageScrollFixture(); load.mockReset(); localStorage.clear() })
afterEach(restoreMessageScrollFixture)

it.each([false, true].flatMap(empty => (["success", "offline", "timeout"] as const).map(result => ({ empty, result }))))("keeps a qualified Forum instance through pending entry and $result, empty=$empty", async ({ empty, result }) => {
  const owner = await createCommunityQueryOwner()
  const packet = forumConversationEntryFixture("c1", "s1", empty)
  await seedConversationEntry(owner.client, packet)
  owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
  let resolve!: (value: typeof packet) => void, reject!: (error: Error) => void
  load.mockReturnValue(new Promise((yes, no) => { resolve = yes; reject = no }))
  const view = render(<CommunityTestProvider {...owner}><ForumSurface serverId="s1" forumChannelId="c1" routeTag="" members={[]} onOpenPost={() => {}} /></CommunityTestProvider>)
  try {
    resize()
    const root = view.getByTestId("community-forum-post-list")
    expect(root).not.toHaveAttribute("aria-busy")
    expect(view.queryByText("Loading actual cards")).toBeNull()
    expect(root.textContent).toContain(empty ? "No posts with this tag" : "Body")
    await act(async () => {
      if (result === "success") resolve(packet)
      else if (result === "offline") reject(new Error("offline"))
      await vi.advanceTimersByTimeAsync(result === "timeout" ? 15000 : result === "offline" ? 2000 : 0)
    })
    resize()
    expect(view.getByTestId("community-forum-post-list")).toBe(root)
    expect(root).not.toHaveAttribute("aria-busy")
    expect(view.queryByText("Loading actual cards")).toBeNull()
  } finally { view.unmount(); owner.client.clear() }
})

it.each(["child", "opener", "author", "participant"] as const)("does not turn missing Forum %s into an empty list, and has a finite failure exit", async missing => {
  const owner = await createCommunityQueryOwner()
  const packet = forumConversationEntryFixture()
  await seedConversationEntry(owner.client, packet)
  const key = communityKeys.forumFeed("c1", null)
  if (missing === "child") owner.registry.collections.channels.utils.writeDelete("t1")
  if (missing === "opener") owner.registry.collections.messages.utils.writeDelete("m1")
  if (missing === "author") owner.registry.collections.profiles.utils.writeDelete("peer")
  if (missing === "participant") owner.client.setQueryData(key, (data: { pages: Array<{ threads: Array<{ participantIds: string[] }> }> }) => ({
    ...data, pages: data.pages.map(page => ({ ...page, threads: page.threads.map(thread => ({ ...thread, participantIds: ["absent-profile"] })) })),
  }))
  owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
  load.mockReturnValue(new Promise(() => {}))
  const view = render(<CommunityTestProvider {...owner}><ForumSurface serverId="s1" forumChannelId="c1" routeTag="" members={[]} onOpenPost={() => {}} /></CommunityTestProvider>)
  try {
    resize()
    expect(view.getByLabelText("Loading forum")).toHaveAttribute("aria-busy", "true")
    expect(view.queryByText(/No posts with this tag/)).toBeNull()
    expect(view.queryByText("Body")).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    resize()
    expect(view.getByRole("alert")).toBeVisible()
    expect(view.getByRole("button", { name: "Retry" })).toBeEnabled()
    expect(view.queryByText(/No posts with this tag/)).toBeNull()
  } finally { view.unmount(); owner.client.clear() }
})


it.each(["child", "opener"] as const)("keeps the Forum root while complete data loses its %s and recovers", async missing => {
  const owner = await createCommunityQueryOwner()
  const packet = forumConversationEntryFixture()
  await seedConversationEntry(owner.client, packet)
  load.mockReturnValue(new Promise(() => {}))
  const view = render(<CommunityTestProvider {...owner}><ForumSurface serverId="s1" forumChannelId="c1" routeTag="" members={[]} onOpenPost={() => {}} /></CommunityTestProvider>)
  try {
    resize()
    const root = view.getByTestId("community-forum-post-list")
    expect(root.textContent).toContain("Body")
    await act(async () => {
      if (missing === "child") owner.registry.collections.channels.utils.writeDelete("t1")
      else owner.registry.collections.messages.utils.writeDelete("m1")
      await vi.advanceTimersByTimeAsync(0)
    })
    resize()
    expect(view.getByTestId("community-forum-post-list")).toBe(root)
    expect(root).toHaveAttribute("aria-busy", "true")
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
    expect(view.queryByText(/No posts with this tag/)).toBeNull()
    await act(async () => { await seedConversationEntry(owner.client, packet); await vi.advanceTimersByTimeAsync(0) })
    resize()
    expect(view.getByTestId("community-forum-post-list")).toBe(root)
    expect(root).not.toHaveAttribute("aria-busy")
    expect(root.textContent).toContain("Body")
  } finally { view.unmount(); owner.client.clear() }
})
