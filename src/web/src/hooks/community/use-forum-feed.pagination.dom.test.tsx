import { createElement, type PropsWithChildren } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { forumConversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { useForumFeed } from "./use-forum-feed"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: load }))
vi.mock("./use-channel-panels", () => ({ useForumTags: () => ({ data: { tags: [] }, isSuccess: true }) }))
beforeEach(() => { load.mockReset(); localStorage.clear() })

describe("forum native page demand", () => {
  it("reuses a held cursor operation across repeated demands and renders before advancing the cursor", async () => {
    const owner = await createCommunityQueryOwner()
    const entry = forumConversationEntryFixture()
    entry.forumFeed!.page = { hasMore: true, nextCursor: "older-2" }
    type Page = NonNullable<typeof entry.forumFeed>
    const page = (id: string, cursor: string | null): Page => ({
      ...entry.forumFeed!,
      threads: [{ ...entry.forumFeed!.threads[0], id, parentMessageId: `opener-${id}`, createdAt: `2026-09-${id === "t2" ? "29" : "28"}T00:00:00.000Z` }],
      included: { ...entry.forumFeed!.included, messages: [{ ...entry.forumFeed!.included.messages[0], id: `opener-${id}`, content: id, seq: id === "t2" ? 2 : 3 }] },
      page: { hasMore: cursor !== null, nextCursor: cursor },
    })
    let release!: (value: Page) => void
    const held = new Promise<Page>((resolve) => { release = resolve })
    const requests: Array<{ cursor: string | null; signal: AbortSignal }> = []
    load.mockImplementation((path: string, options?: { signal?: AbortSignal }) => {
      if (path.includes("/messages?entry=1")) return Promise.resolve(entry)
      if (path.includes("/threads?")) {
        const cursor = new URL(path, "https://local").searchParams.get("cursor")
        requests.push({ cursor, signal: options!.signal! })
        return cursor === "older-2" ? held : Promise.resolve(page("t3", null))
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client }, createElement(CommunityDbProvider, { registry: owner.registry }, children))
    const view = renderHook(() => useForumFeed("s1", "c1"), { wrapper })
    await waitFor(() => expect(view.result.current.posts.map(({ id }) => id)).toEqual(["t1"]))
    const append = view.result.current.fetchOlder
    act(() => { append() })
    await waitFor(() => expect(requests).toHaveLength(1))
    await act(async () => {
      view.rerender()
      append()
      view.result.current.fetchOlder()
      append()
      await Promise.resolve()
    })
    expect(view.result.current.fetchOlder).toBe(append)
    expect(requests).toHaveLength(1)
    expect(requests[0].signal.aborted).toBe(false)
    await act(async () => { release(page("t2", "older-3")) })
    await waitFor(() => expect(view.result.current.posts.map(({ id }) => id)).toEqual(["t1", "t2"]))
    act(() => { view.result.current.fetchOlder() })
    await waitFor(() => expect(view.result.current.posts.map(({ id }) => id)).toEqual(["t1", "t2", "t3"]))
    expect(requests.map(({ cursor }) => cursor)).toEqual(["older-2", "older-3"])
    expect(view.result.current.hasMoreOlder).toBe(false)
    view.unmount()
  })
})
