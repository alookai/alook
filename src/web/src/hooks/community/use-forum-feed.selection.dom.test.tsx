import { createElement, type PropsWithChildren } from "react"
import { renderToString } from "react-dom/server"
import { hydrateRoot } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { forumConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { useForumFeed } from "./use-forum-feed"

const api = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: api }))

function entryFor(tag: string | null) {
  const entry = forumConversationEntryFixture("forum", "server")
  const id = tag ?? "all"
  entry.forumFeed!.threads[0] = { ...entry.forumFeed!.threads[0], id: `post-${id}`, parentMessageId: `opener-${id}` }
  entry.forumFeed!.included.messages[0] = { ...entry.forumFeed!.included.messages[0], id: `opener-${id}`, content: `${id} body` }
  entry.forumFeed!.included.tags = tag ? [{ messageId: `opener-${id}`, tag }] : []
  return entry
}

beforeEach(() => {
  localStorage.clear()
  api.mockReset().mockImplementation(async (path: string) => {
    if (path.endsWith("/messages/tags")) return { tags: ["archived", "bug"] }
    if (path.includes("/messages?entry=1")) return entryFor(new URL(path, "https://local").searchParams.get("tag"))
    throw new Error(`Unexpected request: ${path}`)
  })
})

describe("Forum initial selection authority", () => {
  it.each([
    { routeTag: "bug", stored: "archived", expected: "bug", requestTag: "bug" },
    { routeTag: "", stored: "archived", expected: "All", requestTag: null },
    { routeTag: null, stored: "archived", expected: "archived", requestTag: "archived" },
    { routeTag: null, stored: null, expected: "All", requestTag: null },
  ])("resolves URL=$routeTag and storage=$stored as $expected before requesting its entry", async ({ routeTag, stored, expected, requestTag }) => {
    const owner = await createCommunityQueryOwner()
    if (stored) localStorage.setItem("alook:forum-tag:forum", stored)
    const wrapper = ({ children }: PropsWithChildren) => <CommunityTestProvider {...owner}>{children}</CommunityTestProvider>
    const view = renderHook(() => useForumFeed("server", "forum", { routeTag }), { wrapper })
    await waitFor(() => expect(view.result.current.posts.map(post => post.id)).toEqual([`post-${requestTag ?? "all"}`]))
    expect(view.result.current.tag).toBe(expected)
    const entries = api.mock.calls.map(([path]) => path as string).filter(path => path.includes("/messages?entry=1"))
    expect(entries).toHaveLength(1)
    expect(new URL(entries[0], "https://local").searchParams.get("tag")).toBe(requestTag)
    view.unmount()
  })

  it("restores the URL category after selecting another category and navigating back", async () => {
    const owner = await createCommunityQueryOwner()
    const onSelectTag = vi.fn()
    const wrapper = ({ children }: PropsWithChildren) => <CommunityTestProvider {...owner}>{children}</CommunityTestProvider>
    const view = renderHook(({ routeTag }) => useForumFeed("server", "forum", { routeTag, onSelectTag }), {
      wrapper, initialProps: { routeTag: "bug" },
    })
    await waitFor(() => expect(view.result.current.posts.map(post => post.id)).toEqual(["post-bug"]))
    act(() => view.result.current.selectTag("archived"))
    expect(onSelectTag).toHaveBeenCalledWith("archived")
    view.rerender({ routeTag: "archived" })
    await waitFor(() => expect(view.result.current.posts.map(post => post.id)).toEqual(["post-archived"]))
    view.rerender({ routeTag: "bug" })
    expect(view.result.current.tag).toBe("bug")
    await waitFor(() => expect(view.result.current.posts.map(post => post.id)).toEqual(["post-bug"]))
    expect(localStorage.getItem("alook:forum-tag:forum")).toBe("archived")
    view.unmount()
  })

  it("hydrates an unknown stored selection without first displaying a qualified All window", async () => {
    const owner = await createCommunityQueryOwner()
    await seedConversationEntry(owner.client, entryFor(null))
    localStorage.setItem("alook:forum-tag:forum", "archived")
    const displayed: string[] = []
    function Probe() {
      const feed = useForumFeed("server", "forum")
      if (feed.posts.length) displayed.push(...feed.posts.map(post => post.id))
      return <span>{feed.selectionReady ? feed.posts.map(post => post.id).join("|") : "selection pending"}</span>
    }
    const tree = createElement(CommunityTestProvider, { ...owner }, createElement(Probe))
    const container = document.createElement("div")
    container.innerHTML = renderToString(tree)
    expect(container.textContent).toBe("selection pending")
    expect(displayed).toEqual([])
    document.body.appendChild(container)
    let root!: ReturnType<typeof hydrateRoot>
    try {
      await act(async () => { root = hydrateRoot(container, tree) })
      await waitFor(() => expect(container.textContent).toBe("post-archived"))
      expect(displayed.length).toBeGreaterThan(0)
      expect(displayed.every(id => id === "post-archived")).toBe(true)
    } finally { act(() => root.unmount()); container.remove() }
  })
})
