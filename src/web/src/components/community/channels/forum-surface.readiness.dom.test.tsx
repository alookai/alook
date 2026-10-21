import { IsRestoringProvider } from "@tanstack/react-query"
import { beforeEach, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { forumConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { ForumSurface } from "./forum-surface"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: load }))
vi.mock("@/hooks/community/use-channel-panels", () => ({ useForumTags: () => ({ data: { tags: [] }, isSuccess: true }) }))
vi.mock("@/hooks/community/use-read-observer", () => ({ useTimelineReadObserver: () => {} }))
vi.mock("./forum-view", () => ({ ForumView: ({ loading, posts }: { loading: boolean; posts: Array<{ name: string }> }) => <main>{loading ? "Loading posts" : posts.length ? posts.map(post => post.name).join(",") : "No posts"}</main> }))
beforeEach(() => { load.mockReset(); load.mockImplementation(() => new Promise(() => {})) })
it.each([false, true])("keeps absent forum data loading and renders qualified cached empty (cached=%s)", async cached => {
  const { client, registry } = await createCommunityQueryOwner()
  if (cached) await seedConversationEntry(client, forumConversationEntryFixture("c1", "s1", true))
  const view = render(<CommunityTestProvider client={client} registry={registry}>
    <IsRestoringProvider value><ForumSurface serverId="s1" forumChannelId="c1" members={[]} onOpenPost={() => {}} /></IsRestoringProvider>
  </CommunityTestProvider>)
  expect(view.getByText(cached ? "No posts" : "Loading posts")).toBeVisible()
  expect(view.queryByText(cached ? "Loading posts" : "No posts")).toBeNull()
  expect(load).not.toHaveBeenCalled()
})
