import { createElement, type PropsWithChildren } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { forumConversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { useForumFeed } from "./use-forum-feed"
import { useConversationEntry } from "./use-conversation-entry"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: load }))
vi.mock("./use-channel-panels", () => ({ useForumTags: () => ({ data: { tags: [] }, isSuccess: true }) }))
beforeEach(() => { load.mockReset(); localStorage.clear() })

describe("forum common entry", () => {
  it.each([false, true])("joins metadata, pointer and actual first feed in one GET, including confirmed empty=%s", async empty => {
    const owner = await createCommunityQueryOwner()
    load.mockResolvedValue(forumConversationEntryFixture("c1", "s1", empty))
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client }, createElement(CommunityDbProvider, { registry: owner.registry }, children))
    const view = renderHook(() => ({ feed: useForumFeed("s1", "c1"), entry: useConversationEntry({ channelId: "c1", serverId: "s1" }) }), { wrapper })
    await waitFor(() => expect(view.result.current.feed.data).toBeDefined())
    await waitFor(() => expect(view.result.current.entry.snapshot?.lastReadMessageId).toBe("m1"))
    expect(view.result.current.feed.posts.map(post => post.name)).toEqual(empty ? [] : ["Body"])
    expect(view.result.current.feed.isLoading).toBe(false)
    expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/messages?entry=1"])
    view.rerender()
    expect(load).toHaveBeenCalledOnce()
    view.unmount()
  })
})
