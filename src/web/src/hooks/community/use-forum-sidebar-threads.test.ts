import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import {
  patchForumSidebarActivity,
  patchForumSidebarUnread,
  projectForumSidebarThreads,
  reconcileForumSidebarUnreadFallbacks,
  recordForumSidebarChildUnread,
  removeForumSidebarThread,
  removeForumSidebarUnreadChild,
  setForumSidebarParentUnreadBase,
  type ForumSidebarQueryData,
  type ForumSidebarUnreadFallbackState,
  type SidebarThreadEnvelope,
  useForumSidebarThreads,
} from "./use-forum-sidebar-threads"
import type { ServerDetail } from "./use-servers"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

const envelope = (ids: string[]): SidebarThreadEnvelope => ({
  channels: ids.map((id, index) => ({
    id,
    name: `fallback-${id}`,
    parentChannelId: "forum-1",
    parentMessageId: `opener-${id}`,
    activityAt: `2026-08-08T0${index}:00:00.000Z`,
    expiresAt: `2026-08-11T0${index}:00:00.000Z`,
    unread: index === 0,
  })),
  included: {
    parentMessages: ids.map((id) => ({ id: `opener-${id}`, content: `title-${id}` })),
  },
  serverNow: "2026-08-08T00:00:00.000Z",
})

function Capture({ retainId, onRender }: {
  retainId: string | null
  onRender: (ids: string[]) => void
}) {
  const result = useForumSidebarThreads("server-1", retainId)
  onRender(result.threads.map((thread) => thread.id))
  return null
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 40 && !predicate(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

function serverDetail(parentUnread: boolean): ServerDetail {
  return {
    id: "server-1",
    name: "Server",
    description: "",
    icon: null,
    ownerId: "owner-1",
    categories: [{
      id: "category-1",
      name: "Channels",
      private: 0,
      channels: [{
        id: "forum-1",
        name: "Forum",
        type: "forum",
        active: false,
        unread: parentUnread,
        muted: false,
      }],
    }],
  }
}

function parentUnread(queryClient: QueryClient): boolean {
  return !!queryClient.getQueryData<ServerDetail>(communityKeys.server("server-1"))
    ?.categories[0]?.channels[0]?.unread
}

describe("useForumSidebarThreads", () => {
  it("preserves a genuine parent unread when a child fallback becomes locatable", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.server("server-1"), serverDetail(true))
    recordForumSidebarChildUnread(queryClient, "server-1", "forum-1", "post-1")

    reconcileForumSidebarUnreadFallbacks(queryClient, "server-1", ["post-1"])

    expect(parentUnread(queryClient)).toBe(true)
    expect(queryClient.getQueryData<ForumSidebarUnreadFallbackState>(
      communityKeys.forumSidebarUnreadFallbacks("server-1"),
    )).toEqual({})
  })

  it("preserves a parent unread that arrives while a child fallback is pending", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.server("server-1"), serverDetail(false))
    recordForumSidebarChildUnread(queryClient, "server-1", "forum-1", "post-1")
    expect(setForumSidebarParentUnreadBase(queryClient, "server-1", "forum-1", true)).toBe(true)

    reconcileForumSidebarUnreadFallbacks(queryClient, "server-1", ["post-1"])

    expect(parentUnread(queryClient)).toBe(true)
  })

  it("keeps the parent fallback while another unread child is still unlisted", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.server("server-1"), serverDetail(false))
    recordForumSidebarChildUnread(queryClient, "server-1", "forum-1", "post-1")
    recordForumSidebarChildUnread(queryClient, "server-1", "forum-1", "post-2")
    expect(queryClient.getQueryData<ForumSidebarUnreadFallbackState>(
      communityKeys.forumSidebarUnreadFallbacks("server-1"),
    )?.["forum-1"]?.childIds).toEqual(["post-1", "post-2"])

    reconcileForumSidebarUnreadFallbacks(queryClient, "server-1", ["post-1"])
    expect(parentUnread(queryClient)).toBe(true)
    expect(queryClient.getQueryData<ForumSidebarUnreadFallbackState>(
      communityKeys.forumSidebarUnreadFallbacks("server-1"),
    )?.["forum-1"]?.childIds).toEqual(["post-2"])

    reconcileForumSidebarUnreadFallbacks(queryClient, "server-1", ["post-1", "post-2"])
    expect(parentUnread(queryClient)).toBe(false)
  })

  it("transfers a loaded unread child back to its parent when top-five/expiry hides it", async () => {
    apiFetchMock
      .mockResolvedValueOnce(envelope(["post-1"]))
      .mockResolvedValueOnce(envelope([]))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(communityKeys.server("server-1"), {
      ...serverDetail(true),
      forumUnreadState: {
        "forum-1": { baseUnread: false, childIds: ["post-1"] },
      },
    })

    let renderer: TestRenderer.ReactTestRenderer
    const renders: string[][] = []
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, {
            retainId: null,
            onRender: (ids) => renders.push(ids),
          }),
        ),
      )
    })
    await waitFor(() => renders.at(-1)?.[0] === "post-1")
    await waitFor(() => Object.keys(
      queryClient.getQueryData<ForumSidebarUnreadFallbackState>(
        communityKeys.forumSidebarUnreadFallbacks("server-1"),
      ) ?? {},
    ).length === 0)

    expect(parentUnread(queryClient)).toBe(false)
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: communityKeys.forumSidebarThreads("server-1"),
      })
    })
    await waitFor(() => renders.at(-1)?.length === 0)
    await waitFor(() => parentUnread(queryClient))

    expect(queryClient.getQueryData<ForumSidebarUnreadFallbackState>(
      communityKeys.forumSidebarUnreadFallbacks("server-1"),
    )).toEqual({
      "forum-1": { baseUnread: false, childIds: ["post-1"] },
    })
    renderer!.unmount()
  })

  it("does not create a fallback after an explicit leave/delete/archive removal", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.server("server-1"), {
      ...serverDetail(false),
      forumUnreadState: {
        "forum-1": { baseUnread: false, childIds: ["post-1"] },
      },
    })
    reconcileForumSidebarUnreadFallbacks(queryClient, "server-1", ["post-1"])

    removeForumSidebarUnreadChild(queryClient, "server-1", "post-1")
    reconcileForumSidebarUnreadFallbacks(queryClient, "server-1", [])

    expect(parentUnread(queryClient)).toBe(false)
    expect(queryClient.getQueryData<ServerDetail>(
      communityKeys.server("server-1"),
    )?.forumUnreadState?.["forum-1"]?.childIds).toEqual([])
  })

  it("clears a hidden fallback when a canonical refetch removes access or participation", async () => {
    apiFetchMock.mockResolvedValue(envelope([]))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(communityKeys.server("server-1"), {
      ...serverDetail(true),
      forumUnreadState: {
        "forum-1": { baseUnread: false, childIds: ["post-inaccessible"] },
      },
    })

    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, { retainId: null, onRender: () => undefined }),
        ),
      )
    })
    await waitFor(() => queryClient.getQueryData<ForumSidebarUnreadFallbackState>(
      communityKeys.forumSidebarUnreadFallbacks("server-1"),
    )?.["forum-1"]?.childIds[0] === "post-inaccessible")

    await act(async () => {
      queryClient.setQueryData(communityKeys.server("server-1"), {
        ...serverDetail(false),
        forumUnreadState: {
          "forum-1": { baseUnread: false, childIds: [] },
        },
      })
    })
    await waitFor(() => Object.keys(
      queryClient.getQueryData<ForumSidebarUnreadFallbackState>(
        communityKeys.forumSidebarUnreadFallbacks("server-1"),
      ) ?? {},
    ).length === 0)

    expect(parentUnread(queryClient)).toBe(false)
    expect(queryClient.getQueryData<ForumSidebarUnreadFallbackState>(
      communityKeys.forumSidebarUnreadFallbacks("server-1"),
    )).toEqual({})
    renderer!.unmount()
  })

  it("migrates a missing-child fallback dot to the child after the sidebar refetch", async () => {
    apiFetchMock.mockResolvedValue(envelope(["post-missing"]))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const sidebarKey = communityKeys.forumSidebarThreadsView("server-1", null)
    queryClient.setQueryData<ForumSidebarQueryData>(sidebarKey, {
      ...envelope([]),
      threads: [],
      serverClockOffsetMs: 0,
    })
    queryClient.setQueryData(communityKeys.server("server-1"), serverDetail(false))

    // message.create invalidates the missing row; unread.bump temporarily owns
    // the parent fallback while that refetch is outstanding.
    await queryClient.invalidateQueries({ queryKey: communityKeys.forumSidebarThreads("server-1") })
    recordForumSidebarChildUnread(queryClient, "server-1", "forum-1", "post-missing")
    expect(parentUnread(queryClient)).toBe(true)

    let renderer: TestRenderer.ReactTestRenderer
    const renders: string[][] = []
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, {
            retainId: null,
            onRender: (ids) => renders.push(ids),
          }),
        ),
      )
    })
    await waitFor(() => renders.at(-1)?.[0] === "post-missing")
    await waitFor(() => !parentUnread(queryClient))

    expect(queryClient.getQueryData<ForumSidebarQueryData>(sidebarKey)?.threads[0]?.unread).toBe(true)
    expect(parentUnread(queryClient)).toBe(false)
    expect(queryClient.getQueryData<ForumSidebarUnreadFallbackState>(
      communityKeys.forumSidebarUnreadFallbacks("server-1"),
    )).toEqual({})

    queryClient.setQueryData<ForumSidebarQueryData>(sidebarKey, (data) =>
      patchForumSidebarUnread(data, "post-missing", false),
    )
    expect(queryClient.getQueryData<ForumSidebarQueryData>(sidebarKey)?.threads[0]?.unread).toBe(false)
    expect(parentUnread(queryClient)).toBe(false)
    renderer!.unmount()
  })

  it("expires live activity 72h after the event instead of reusing the old serverNow", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"))
    apiFetchMock.mockResolvedValue(envelope(["thread-1"]))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries")
    let renderer: TestRenderer.ReactTestRenderer
    const renders: string[][] = []
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, {
            retainId: null,
            onRender: (ids) => renders.push(ids),
          }),
        ),
      )
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(renders.at(-1)).toEqual(["thread-1"])
    invalidateSpy.mockClear()

    act(() => vi.advanceTimersByTime(10 * 60 * 60 * 1000))
    const key = communityKeys.forumSidebarThreadsView("server-1", null)
    await act(async () => {
      queryClient.setQueryData<ForumSidebarQueryData>(key, (data) =>
        patchForumSidebarActivity(
          data,
          "thread-1",
          "forum-1",
          "2026-08-08T10:00:00.000Z",
        ),
      )
      await vi.advanceTimersByTimeAsync(0)
    })

    act(() => vi.advanceTimersByTime((72 * 60 * 60 * 1000) + 24))
    expect(invalidateSpy).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: communityKeys.forumSidebarThreads("server-1"),
    })
    renderer!.unmount()
  })

  it("keeps the cached list painted while a retainId-specific view is loading", async () => {
    let resolveRetained: ((value: SidebarThreadEnvelope) => void) | undefined
    apiFetchMock
      .mockResolvedValueOnce(envelope(["thread-1"]))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveRetained = resolve
      }))

    const renders: string[][] = []
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, {
            retainId: null,
            onRender: (ids) => renders.push(ids),
          }),
        ),
      )
    })
    await waitFor(() => renders.at(-1)?.[0] === "thread-1")
    const switchRenderStart = renders.length

    await act(async () => {
      renderer!.update(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, {
            retainId: "thread-2",
            onRender: (ids) => renders.push(ids),
          }),
        ),
      )
    })

    expect(renders.slice(switchRenderStart)).not.toContainEqual([])
    expect(renders.at(-1)).toEqual(["thread-1"])
    expect(apiFetchMock.mock.calls[1]?.[0]).toContain("retainId=thread-2")

    await act(async () => {
      resolveRetained?.(envelope(["thread-2"]))
    })
    await waitFor(() => renders.at(-1)?.[0] === "thread-2")
    expect(renders.at(-1)).toEqual(["thread-2"])
    expect(renders.slice(switchRenderStart)).not.toContainEqual([])
    renderer!.unmount()
  })

  it("projects opener titles and patches activity/removal without mutating the source", () => {
    const source = envelope(["thread-1", "thread-2"])
    const threads = projectForumSidebarThreads(source)
    const data = { ...source, threads, serverClockOffsetMs: 0 }

    expect(threads.map((thread) => thread.title)).toEqual(["title-thread-1", "title-thread-2"])
    const patched = patchForumSidebarActivity(
      data,
      "thread-1",
      "forum-1",
      "2026-08-09T00:00:00.000Z",
    )
    expect(patched?.threads[0]?.id).toBe("thread-1")
    expect(patched?.threads[0]?.expiresAt).toBe("2026-08-12T00:00:00.000Z")
    expect(data.threads[0]?.activityAt).toBe("2026-08-08T00:00:00.000Z")
    expect(removeForumSidebarThread(patched, "thread-1")?.threads.map((thread) => thread.id))
      .toEqual(["thread-2"])
    expect(patchForumSidebarUnread(data, "thread-1", false)?.threads[0]?.unread).toBe(false)
  })
})
