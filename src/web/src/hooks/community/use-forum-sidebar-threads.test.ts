import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import {
  deriveForumSidebarProjection,
  grantForumSidebarChild,
  hasForumSidebarOwnershipEvidence,
  invalidateForumSidebarBaseExact,
  patchForumSidebarActivityExact,
  patchForumSidebarTitleExact,
  removeForumSidebarThreadExact,
  normalizeForumSidebarEnvelope,
  patchForumSidebarActivity,
  patchForumSidebarUnread,
  projectForumSidebarThreads,
  reconcileForumSidebarUnreadFallbacks,
  recordForumSidebarChildUnread,
  removeForumSidebarThread,
  removeForumSidebarUnreadChild,
  restoreForumSidebarThreadInflight,
  resolveForumSidebarRouteCandidate,
  setForumSidebarParentUnreadBase,
  type ForumSidebarQueryData,
  type ForumSidebarThread,
  type ForumSidebarUnreadFallbackState,
  type SidebarThreadEnvelope,
  useForumSidebarThreads,
} from "./use-forum-sidebar-threads"
import type { ServerDetail } from "./use-servers"
import { useCommunityWsStore } from "@/stores/community/ws"

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
    serverId: "server-1",
    type: "thread",
    creatorId: "creator-1",
    archived: false,
    createdAt: `2026-08-08T0${index}:00:00.000Z`,
  })),
  included: {
    parentMessages: ids.map((id) => ({ id: `opener-${id}`, content: `title-${id}` })),
  },
  serverNow: "2026-08-08T00:00:00.000Z",
})

function Capture({ retainId, onRender, enabled }: {
  retainId: string | null
  onRender: (ids: string[]) => void
  enabled?: boolean
}) {
  const result = useForumSidebarThreads("server-1", retainId, enabled)
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
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().markAccessConnected()
})

afterEach(() => {
  vi.useRealTimers()
  useCommunityWsStore.getState().reset()
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
    const sidebarKey = communityKeys.forumSidebarThreads("server-1")
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
    apiFetchMock.mockRejectedValueOnce(new Error("offline"))

    act(() => vi.advanceTimersByTime(10 * 60 * 60 * 1000))
    const key = communityKeys.forumSidebarThreads("server-1")
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
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: communityKeys.forumSidebarThreads("server-1"),
      exact: true,
      refetchType: "active",
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(queryClient.getQueryData<ForumSidebarQueryData>(key)?.threads).toEqual([])
    expect(JSON.stringify(queryClient.getQueryData(key))).not.toContain("thread-1")
    expect(queryClient.getQueryState(
      communityKeys.channelMeta("server-1", "thread-1"),
    )).toBeUndefined()
    expect(queryClient.getQueryState(
      communityKeys.forumOpenerHint("server-1", "opener-thread-1"),
    )).toBeUndefined()
    expect(renders.at(-1)).toEqual([])
    renderer!.unmount()
  })

  it("retains a warm canonical route through expiry and offline refresh until navigation and GC", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"))
    apiFetchMock.mockRejectedValue(new Error("offline"))
    const source = envelope(["canonical-a"])
    source.channels[0]!.expiresAt = "2026-08-08T00:00:00.100Z"
    const normalized = normalizeForumSidebarEnvelope({
      ...source,
      canonicalChannels: source.channels,
      retainedChannel: null,
    }, null, 0)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(communityKeys.server("server-1"), serverDetail(false))
    queryClient.setQueryData(
      communityKeys.forumSidebarThreads("server-1"),
      { ...normalized.base, verifiedEpoch: 0 },
    )

    const renders: string[][] = []
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
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(renders.at(-1)).toEqual(["canonical-a"])

    await act(async () => {
      renderer!.update(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, {
            retainId: "canonical-a",
            onRender: (ids) => renders.push(ids),
          }),
        ),
      )
      await vi.advanceTimersByTimeAsync(0)
    })
    const retainedKey = communityKeys.forumSidebarRetained("server-1", "canonical-a")
    expect(queryClient.getQueryData<ForumSidebarThread>(retainedKey)?.id).toBe("canonical-a")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(126)
    })
    expect(queryClient.getQueryData<ForumSidebarQueryData>(
      communityKeys.forumSidebarThreads("server-1"),
    )?.threads).toEqual([])
    expect(renders.at(-1)).toEqual(["canonical-a"])

    await act(async () => {
      renderer!.update(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, {
            retainId: null,
            onRender: (ids) => renders.push(ids),
          }),
        ),
      )
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(renders.at(-1)).toEqual([])

    await act(async () => {
      await vi.advanceTimersByTimeAsync((5 * 60 * 1000) + 1)
    })
    expect(queryClient.getQueryState(retainedKey)).toBeUndefined()
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

describe("forum sidebar Stage B resources", () => {
  it("does not retain known top-level routes and keeps an unknown direct child candidate", () => {
    expect(resolveForumSidebarRouteCandidate("general", ["general", "forum"])).toBeNull()
    expect(resolveForumSidebarRouteCandidate("post-1", ["general", "forum"])).toBe("post-1")
    expect(resolveForumSidebarRouteCandidate("post-1", null)).toBeNull()
  })

  it("requires positive forum ownership evidence", () => {
    const queryClient = new QueryClient()
    expect(hasForumSidebarOwnershipEvidence(queryClient, "server-1", "child-1"))
      .toBe(false)

    const detail = serverDetail(false)
    detail.categories[0]!.channels.push({
      id: "general-1",
      name: "General",
      type: "text",
      active: false,
      unread: false,
      muted: false,
    })
    queryClient.setQueryData(communityKeys.server("server-1"), detail)
    queryClient.setQueryData(communityKeys.channelMeta("server-1", "child-1"), {
      id: "child-1",
      serverId: "server-1",
      name: "Thread",
      type: "thread",
      parentChannelId: "general-1",
      parentMessageId: "message-1",
      creatorId: "user-1",
      archived: false,
      activityAt: "2026-08-08T00:00:00.000Z",
      verifiedEpoch: 0,
    })
    queryClient.setQueryData(
      communityKeys.forumSidebarRetained("server-1", "child-1"),
      projectForumSidebarThreads(envelope(["child-1"]))[0],
    )
    expect(hasForumSidebarOwnershipEvidence(queryClient, "server-1", "child-1"))
      .toBe(false)

    queryClient.setQueryData(communityKeys.channelMeta("server-1", "child-1"), {
      ...queryClient.getQueryData<ChildChannelMeta>(
        communityKeys.channelMeta("server-1", "child-1"),
      )!,
      parentChannelId: "forum-1",
    })
    expect(hasForumSidebarOwnershipEvidence(queryClient, "server-1", "child-1"))
      .toBe(true)
  })

  it("settles an omitted text-thread candidate without deleting exact metadata", async () => {
    apiFetchMock.mockResolvedValue({
      ...envelope([]),
      canonicalChannels: [],
      retainedChannel: null,
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const detail = serverDetail(false)
    detail.categories[0]!.channels.push({
      id: "general-1",
      name: "General",
      type: "text",
      active: false,
      unread: false,
      muted: false,
    })
    queryClient.setQueryData(communityKeys.server("server-1"), detail)
    let renderer: TestRenderer.ReactTestRenderer
    const tree = (retainId: string | null) => React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(Capture, { retainId, onRender: () => undefined }),
    )
    await act(async () => {
      renderer = TestRenderer.create(tree(null))
    })
    await waitFor(() => queryClient.getQueryState(
      communityKeys.forumSidebarThreads("server-1"),
    )?.status === "success")
    const meta: ChildChannelMeta = {
      id: "thread-1",
      serverId: "server-1",
      name: "Thread",
      type: "thread",
      parentChannelId: "general-1",
      parentMessageId: "message-1",
      creatorId: "user-1",
      archived: false,
      activityAt: "2026-08-08T00:00:00.000Z",
      verifiedEpoch: 0,
    }
    queryClient.setQueryData(communityKeys.channelMeta("server-1", "thread-1"), meta)

    await act(async () => {
      renderer!.update(tree("thread-1"))
    })
    await waitFor(() => queryClient.getQueryState(
      communityKeys.forumSidebarRetained("server-1", "thread-1"),
    )?.status === "success")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
    })

    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(queryClient.getQueryData(
      communityKeys.channelMeta("server-1", "thread-1"),
    )).toEqual(meta)
    expect(queryClient.getQueryData(
      communityKeys.forumSidebarRetained("server-1", "thread-1"),
    )).toBeNull()
    renderer!.unmount()
  })

  it("uses one cold combined request and seeds sibling resources before base settles", async () => {
    const canonical = envelope(["base-1"])
    const retained = envelope(["retained-1"])
    apiFetchMock.mockResolvedValue({
      ...canonical,
      canonicalChannels: canonical.channels,
      retainedChannel: retained.channels[0],
      included: {
        parentMessages: [
          ...canonical.included.parentMessages,
          ...retained.included.parentMessages,
        ],
      },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, { retainId: "retained-1", onRender: () => undefined }),
        ),
      )
    })
    await waitFor(() => queryClient.getQueryState(
      communityKeys.forumSidebarThreads("server-1"),
    )?.status === "success")

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock.mock.calls[0]?.[0]).toContain("retainId=retained-1")
    expect(queryClient.getQueryData(
      communityKeys.forumSidebarRetained("server-1", "retained-1"),
    )).toMatchObject({ id: "retained-1" })
    expect(queryClient.getQueryData(
      communityKeys.channelMeta("server-1", "retained-1"),
    )).toMatchObject({ id: "retained-1" })
    expect(queryClient.getQueryData(
      communityKeys.forumOpenerHint("server-1", "opener-retained-1"),
    )).toEqual({ id: "opener-retained-1", content: "title-retained-1" })
    renderer!.unmount()
  })

  it("does not restart the first request when enablement and the route candidate arrive together", async () => {
    let resolveRequest: ((value: SidebarThreadEnvelope) => void) | undefined
    apiFetchMock.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const tree = (retainId: string | null, enabled: boolean) => React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(Capture, {
        retainId,
        enabled,
        onRender: () => undefined,
      }),
    )
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(tree(null, false))
    })
    await act(async () => {
      renderer!.update(tree("retained-1", true))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock.mock.calls[0]?.[0]).toContain("retainId=retained-1")

    const canonical = envelope(["base-1"])
    const retained = envelope(["retained-1"])
    await act(async () => resolveRequest?.({
      ...canonical,
      canonicalChannels: canonical.channels,
      retainedChannel: retained.channels[0],
      included: {
        parentMessages: [
          ...canonical.included.parentMessages,
          ...retained.included.parentMessages,
        ],
      },
    }))
    renderer!.unmount()
  })

  it("shares one cold request across an asynchronous StrictMode-style remount", async () => {
    let resolveRequest: ((value: SidebarThreadEnvelope) => void) | undefined
    apiFetchMock.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const renders: string[][] = []
    const tree = () => React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(Capture, {
        retainId: "retained-1",
        onRender: (ids) => renders.push(ids),
      }),
    )
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(tree())
    })
    await waitFor(() => apiFetchMock.mock.calls.length === 1)
    act(() => renderer!.unmount())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      renderer = TestRenderer.create(tree())
    })
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    const canonical = envelope(["base-1"])
    const retained = envelope(["retained-1"])
    await act(async () => resolveRequest?.({
      ...canonical,
      canonicalChannels: canonical.channels,
      retainedChannel: retained.channels[0],
      included: {
        parentMessages: [
          ...canonical.included.parentMessages,
          ...retained.included.parentMessages,
        ],
      },
    }))
    await waitFor(() => renders.at(-1)?.includes("retained-1") ?? false)

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(
      communityKeys.channelMeta("server-1", "retained-1"),
    )).toMatchObject({ id: "retained-1" })
    renderer!.unmount()
  })

  it("does not seed resources when an unmounted consumer loses the response race", async () => {
    let resolveRequest: ((value: SidebarThreadEnvelope) => void) | undefined
    apiFetchMock.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, { retainId: "retained-1", onRender: () => undefined }),
        ),
      )
    })
    await waitFor(() => apiFetchMock.mock.calls.length === 1)
    const canonical = envelope(["base-1"])
    const retained = envelope(["retained-1"])
    await act(async () => {
      renderer!.unmount()
      resolveRequest?.({
        ...canonical,
        canonicalChannels: canonical.channels,
        retainedChannel: retained.channels[0],
        included: {
          parentMessages: [
            ...canonical.included.parentMessages,
            ...retained.included.parentMessages,
          ],
        },
      })
      await Promise.resolve()
    })

    expect(queryClient.getQueryData(
      communityKeys.forumSidebarThreads("server-1"),
    )).toBeUndefined()
    expect(queryClient.getQueriesData({
      queryKey: communityKeys.channelMetaRoot("server-1"),
    })).toEqual([])
    expect(queryClient.getQueriesData({
      queryKey: communityKeys.forumOpenerHintRoot("server-1"),
    })).toEqual([])
  })

  it("does not relabel an old in-flight response with a newer access epoch", async () => {
    let resolveRequest: ((value: SidebarThreadEnvelope) => void) | undefined
    apiFetchMock.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const renders: string[][] = []
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
    await waitFor(() => apiFetchMock.mock.calls.length === 1)

    await act(async () => {
      useCommunityWsStore.getState().markAccessDisconnected()
      useCommunityWsStore.getState().markAccessConnected()
      resolveRequest?.(envelope(["base-1"]))
    })
    await waitFor(() => queryClient.getQueryState(
      communityKeys.forumSidebarThreads("server-1"),
    )?.status === "success")

    expect(queryClient.getQueryData<ForumSidebarQueryData>(
      communityKeys.forumSidebarThreads("server-1"),
    )?.verifiedEpoch).toBe(0)
    expect(useCommunityWsStore.getState().accessEpoch).toBe(1)
    expect(renders.at(-1)).toEqual([])
    renderer!.unmount()
  })

  it("keeps an already-rendered sidebar snapshot visible while WS is disconnected", async () => {
    apiFetchMock.mockResolvedValue(envelope(["base-1"]))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const renders: string[][] = []
    let renderer!: TestRenderer.ReactTestRenderer
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
    await waitFor(() => renders.at(-1)?.includes("base-1") === true)

    await act(async () => {
      useCommunityWsStore.getState().markAccessDisconnected()
    })

    expect(renders.at(-1)).toEqual(["base-1"])
    renderer.unmount()
  })

  it("replays a title patch that lands while the canonical request is in flight", async () => {
    let resolveRequest: ((value: SidebarThreadEnvelope) => void) | undefined
    apiFetchMock.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
    patchForumSidebarTitleExact(queryClient, "server-1", "base-1", "live title")
    await act(async () => resolveRequest?.(envelope(["base-1"])))
    await waitFor(() => queryClient.getQueryState(
      communityKeys.forumSidebarThreads("server-1"),
    )?.status === "success")

    expect(queryClient.getQueryData<ForumSidebarQueryData>(
      communityKeys.forumSidebarThreads("server-1"),
    )?.threads[0]?.title).toBe("live title")
    expect(queryClient.getQueryData(
      communityKeys.forumOpenerHint("server-1", "opener-base-1"),
    )).toEqual({ id: "opener-base-1", content: "live title" })
    renderer!.unmount()
  })

  it("replays in-flight activity into the exact metadata seed", async () => {
    let resolveRequest: ((value: SidebarThreadEnvelope) => void) | undefined
    apiFetchMock.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
    patchForumSidebarActivityExact(
      queryClient,
      "server-1",
      "base-1",
      "forum-1",
      "2026-08-09T00:00:00.000Z",
    )
    await act(async () => resolveRequest?.(envelope(["base-1"])))
    await waitFor(() => queryClient.getQueryState(
      communityKeys.forumSidebarThreads("server-1"),
    )?.status === "success")

    expect(queryClient.getQueryData<ForumSidebarQueryData>(
      communityKeys.forumSidebarThreads("server-1"),
    )?.threads[0]?.activityAt).toBe("2026-08-09T00:00:00.000Z")
    expect(queryClient.getQueryData(
      communityKeys.channelMeta("server-1", "base-1"),
    )).toMatchObject({ activityAt: "2026-08-09T00:00:00.000Z" })
    renderer!.unmount()
  })

  it("does not let a delayed response revive removed metadata or opener hints", async () => {
    let resolveRequest: ((value: SidebarThreadEnvelope) => void) | undefined
    apiFetchMock.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
    removeForumSidebarThreadExact(queryClient, "server-1", "base-1")
    await act(async () => resolveRequest?.(envelope(["base-1"])))
    await waitFor(() => queryClient.getQueryState(
      communityKeys.forumSidebarThreads("server-1"),
    )?.status === "success")

    expect(queryClient.getQueryData<ForumSidebarQueryData>(
      communityKeys.forumSidebarThreads("server-1"),
    )?.threads).toEqual([])
    expect(queryClient.getQueryData(
      communityKeys.channelMeta("server-1", "base-1"),
    )).toBeUndefined()
    expect(queryClient.getQueryData(
      communityKeys.forumOpenerHint("server-1", "opener-base-1"),
    )).toBeUndefined()
    renderer!.unmount()
  })

  it("allows a failed optimistic removal to accept the restored server row", async () => {
    let resolveRequest: ((value: SidebarThreadEnvelope) => void) | undefined
    apiFetchMock.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
    removeForumSidebarThreadExact(queryClient, "server-1", "base-1")
    restoreForumSidebarThreadInflight("server-1", "base-1")
    await act(async () => resolveRequest?.(envelope(["base-1"])))
    await waitFor(() => queryClient.getQueryState(
      communityKeys.forumSidebarThreads("server-1"),
    )?.status === "success")

    expect(queryClient.getQueryData<ForumSidebarQueryData>(
      communityKeys.forumSidebarThreads("server-1"),
    )?.threads.map((thread) => thread.id)).toEqual(["base-1"])
    renderer!.unmount()
  })

  it("restarts a cold request when the route candidate changes", async () => {
    let resolveFirst: ((value: SidebarThreadEnvelope) => void) | undefined
    let resolveSecond: ((value: SidebarThreadEnvelope) => void) | undefined
    apiFetchMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
    await waitFor(() => apiFetchMock.mock.calls.length === 1)
    await act(async () => {
      renderer!.update(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, { retainId: "post-b", onRender: () => undefined }),
        ),
      )
    })
    await waitFor(() => apiFetchMock.mock.calls.length === 2)
    const first = envelope(["base-a"])
    const secondBase = envelope(["base-a"])
    const secondRetained = envelope(["post-b"])
    await act(async () => resolveFirst?.(first))
    await act(async () => resolveSecond?.({
      ...secondBase,
      canonicalChannels: secondBase.channels,
      retainedChannel: secondRetained.channels[0],
      included: {
        parentMessages: [
          ...secondBase.included.parentMessages,
          ...secondRetained.included.parentMessages,
        ],
      },
    }))
    await waitFor(() => queryClient.getQueryData<ForumSidebarThread | null>(
      communityKeys.forumSidebarRetained("server-1", "post-b"),
    )?.id === "post-b")

    expect(apiFetchMock.mock.calls[1]?.[0]).toContain("retainId=post-b")
    expect(queryClient.getQueryData<ForumSidebarThread | null>(
      communityKeys.forumSidebarRetained("server-1", "post-b"),
    )?.id).toBe("post-b")
    renderer!.unmount()
  })

  it("clears an exact negative retained result on a grant without touching siblings", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.forumSidebarRetained("server-1", "post-1"), null)
    queryClient.setQueryData(
      communityKeys.forumSidebarRetained("server-1", "post-2"),
      { id: "post-2" },
    )

    await grantForumSidebarChild(queryClient, "server-1", "post-1")

    expect(queryClient.getQueryState(
      communityKeys.forumSidebarRetained("server-1", "post-1"),
    )).toBeUndefined()
    expect(queryClient.getQueryData(
      communityKeys.forumSidebarRetained("server-1", "post-2"),
    )).toEqual({ id: "post-2" })
  })

  it("clears stale metadata and opener content when the retained candidate is unauthorized", async () => {
    apiFetchMock.mockResolvedValue({
      ...envelope([]),
      canonicalChannels: [],
      retainedChannel: null,
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(communityKeys.server("server-1"), {
      ...serverDetail(true),
      forumUnreadState: {
        "forum-1": { baseUnread: true, childIds: ["private-post"] },
      },
    })
    queryClient.setQueryData<ForumSidebarUnreadFallbackState>(
      communityKeys.forumSidebarUnreadFallbacks("server-1"),
      { "forum-1": { baseUnread: true, childIds: ["private-post"] } },
    )
    queryClient.setQueryData(
      communityKeys.forumSidebarRetained("server-1", "private-post"),
      {
        ...projectForumSidebarThreads(envelope(["private-post"]))[0],
        parentMessageId: "private-opener",
      },
    )
    queryClient.setQueryData(
      communityKeys.channelMeta("server-1", "private-post"),
      {
        id: "private-post",
        serverId: "server-1",
        name: "Private post",
        type: "thread",
        parentChannelId: "forum-1",
        parentMessageId: "private-opener",
        creatorId: "user-1",
        archived: false,
        activityAt: "2026-08-08T00:00:00.000Z",
        verifiedEpoch: 0,
      },
    )
    queryClient.setQueryData(
      communityKeys.forumOpenerHint("server-1", "private-opener"),
      { id: "private-opener", content: "Private title" },
    )
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, { retainId: "private-post", onRender: () => undefined }),
        ),
      )
    })
    await waitFor(() => queryClient.getQueryState(
      communityKeys.forumSidebarThreads("server-1"),
    )?.status === "success")

    expect(queryClient.getQueryData(
      communityKeys.forumSidebarRetained("server-1", "private-post"),
    )).toBeNull()
    expect(queryClient.getQueryState(
      communityKeys.channelMeta("server-1", "private-post"),
    )).toBeUndefined()
    expect(queryClient.getQueryState(
      communityKeys.forumOpenerHint("server-1", "private-opener"),
    )).toBeUndefined()
    expect(queryClient.getQueryData<ServerDetail>(
      communityKeys.server("server-1"),
    )?.forumUnreadState?.["forum-1"]).toEqual({ baseUnread: true, childIds: [] })
    expect(parentUnread(queryClient)).toBe(true)
    expect(queryClient.getQueryData<ForumSidebarUnreadFallbackState>(
      communityKeys.forumSidebarUnreadFallbacks("server-1"),
    )).toEqual({})
    renderer!.unmount()
  })

  it("force-restarts an in-flight request on grant instead of reusing its negative response", async () => {
    let resolveFirst: ((value: SidebarThreadEnvelope) => void) | undefined
    let resolveSecond: ((value: SidebarThreadEnvelope) => void) | undefined
    apiFetchMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, { retainId: "post-granted", onRender: () => undefined }),
        ),
      )
    })
    await waitFor(() => apiFetchMock.mock.calls.length === 1)
    act(() => { void grantForumSidebarChild(queryClient, "server-1", "post-granted") })
    await waitFor(() => apiFetchMock.mock.calls.length === 2)

    const granted = envelope(["post-granted"])
    await act(async () => resolveSecond?.({
      ...granted,
      canonicalChannels: granted.channels,
      retainedChannel: granted.channels[0],
    }))
    await waitFor(() => queryClient.getQueryData<ForumSidebarQueryData>(
      communityKeys.forumSidebarThreads("server-1"),
    )?.threads[0]?.id === "post-granted")
    await act(async () => resolveFirst?.({
      ...envelope([]),
      canonicalChannels: [],
      retainedChannel: null,
    }))

    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(queryClient.getQueryData<ForumSidebarQueryData>(
      communityKeys.forumSidebarThreads("server-1"),
    )?.threads.map((thread) => thread.id)).toEqual(["post-granted"])
    expect(queryClient.getQueryData(
      communityKeys.channelMeta("server-1", "post-granted"),
    )).toMatchObject({ id: "post-granted", verifiedEpoch: 0 })
    renderer!.unmount()
  })

  it("force-restarts an old-epoch request before reconnect validation", async () => {
    let resolveFirst: ((value: SidebarThreadEnvelope) => void) | undefined
    let resolveSecond: ((value: SidebarThreadEnvelope) => void) | undefined
    apiFetchMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
    await waitFor(() => apiFetchMock.mock.calls.length === 1)
    let reconnectWork!: Promise<void>
    await act(async () => {
      useCommunityWsStore.getState().markAccessDisconnected()
      useCommunityWsStore.getState().markAccessConnected()
      reconnectWork = invalidateForumSidebarBaseExact(queryClient, "server-1")
    })
    await waitFor(() => apiFetchMock.mock.calls.length === 2)
    expect(queryClient.getQueryState(
      communityKeys.forumSidebarThreads("server-1"),
    )?.fetchStatus).toBe("fetching")

    await act(async () => resolveSecond?.(envelope(["epoch-1"])))
    await reconnectWork
    await waitFor(() => queryClient.getQueryData<ForumSidebarQueryData>(
      communityKeys.forumSidebarThreads("server-1"),
    )?.threads[0]?.id === "epoch-1")
    await act(async () => resolveFirst?.(envelope(["epoch-0"])))

    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(queryClient.getQueryState(
      communityKeys.forumSidebarThreads("server-1"),
    )?.fetchStatus).toBe("idle")
    expect(queryClient.getQueryData<ForumSidebarQueryData>(
      communityKeys.forumSidebarThreads("server-1"),
    )).toMatchObject({
      verifiedEpoch: 1,
      threads: [expect.objectContaining({ id: "epoch-1" })],
    })
    expect(queryClient.getQueryState(
      communityKeys.channelMeta("server-1", "epoch-0"),
    )).toBeUndefined()
    renderer!.unmount()
  })

  it("normalizes one canonical base plus one exact retained resource", () => {
    const source = {
      ...envelope(["base-1", "base-2"]),
      canonicalChannels: envelope(["base-1", "base-2"]).channels,
      retainedChannel: envelope(["retained-1"]).channels[0],
      included: {
        parentMessages: [
          { id: "opener-base-1", content: "Base 1" },
          { id: "opener-base-2", content: "Base 2" },
          { id: "opener-retained-1", content: "Retained 1" },
        ],
      },
    }

    const normalized = normalizeForumSidebarEnvelope(source, "retained-1", 0)

    expect(normalized.base.threads.map((thread) => thread.id)).toEqual(["base-1", "base-2"])
    expect(normalized.retained?.id).toBe("retained-1")
    expect(normalized.channelMetas["retained-1"]).toMatchObject({
      id: "retained-1",
      parentMessageId: "opener-retained-1",
    })
    expect(normalized.openerHints["opener-retained-1"]).toEqual({
      id: "opener-retained-1",
      content: "Retained 1",
    })
    expect(normalized.openerHints["opener-retained-1"]).not.toHaveProperty("authorId")
    expect(JSON.stringify(normalized.base)).not.toContain("retained-1")
    expect(JSON.stringify(normalized.base)).not.toContain("Retained 1")
  })

  it("removes a child and opener from every exact resource without raw base residue", () => {
    const source = envelope(["base-1"])
    const normalized = normalizeForumSidebarEnvelope({
      ...source,
      canonicalChannels: source.channels,
      retainedChannel: null,
    }, null, 0)
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.forumSidebarThreads("server-1"), normalized.base)
    queryClient.setQueryData(
      communityKeys.forumSidebarRetained("server-1", "base-1"),
      normalized.base.threads[0],
    )
    queryClient.setQueryData(
      communityKeys.channelMeta("server-1", "base-1"),
      normalized.channelMetas["base-1"],
    )
    queryClient.setQueryData(
      communityKeys.forumOpenerHint("server-1", "opener-base-1"),
      normalized.openerHints["opener-base-1"],
    )

    removeForumSidebarThreadExact(queryClient, "server-1", "base-1")

    expect(JSON.stringify(queryClient.getQueryData(
      communityKeys.forumSidebarThreads("server-1"),
    ))).not.toContain("base-1")
    expect(queryClient.getQueryState(
      communityKeys.forumSidebarRetained("server-1", "base-1"),
    )).toBeUndefined()
    expect(queryClient.getQueryState(
      communityKeys.channelMeta("server-1", "base-1"),
    )).toBeUndefined()
    expect(queryClient.getQueryState(
      communityKeys.forumOpenerHint("server-1", "opener-base-1"),
    )).toBeUndefined()
  })

  it("keeps a positive retained resource but does not duplicate a canonical child", () => {
    const source = {
      ...envelope(["base-1"]),
      canonicalChannels: envelope(["base-1"]).channels,
      retainedChannel: envelope(["base-1"]).channels[0],
    }

    const normalized = normalizeForumSidebarEnvelope(source, "base-1", 0)
    expect(normalized.retained?.id).toBe("base-1")
    expect(deriveForumSidebarProjection(
      normalized.base,
      normalized.retained,
      {},
      Date.parse("2026-08-08T00:00:00.000Z"),
    ).threads.map((thread) => thread.id)).toEqual(["base-1"])
  })

  it("derives child and parent unread from one ownership snapshot", () => {
    const source = envelope(["base-1", "base-2"])
    const normalized = normalizeForumSidebarEnvelope({
      ...source,
      canonicalChannels: source.channels,
      retainedChannel: envelope(["retained-1"]).channels[0],
    }, "retained-1", 0)
    const ownership = {
      "forum-1": {
        baseUnread: false,
        childIds: ["base-2", "retained-1"],
      },
    }

    const active = deriveForumSidebarProjection(
      normalized.base,
      normalized.retained,
      ownership,
      Date.parse("2026-08-08T01:00:00.000Z"),
      2,
    )
    expect(active.threads.map((thread) => [thread.id, thread.unread])).toEqual([
      ["retained-1", true],
      ["base-1", false],
    ])
    expect(active.parentUnread["forum-1"]).toBe(true)

    const inactive = deriveForumSidebarProjection(
      normalized.base,
      null,
      ownership,
      Date.parse("2026-08-08T01:00:00.000Z"),
      2,
    )
    expect(inactive.threads.map((thread) => [thread.id, thread.unread])).toEqual([
      ["base-1", false],
      ["base-2", true],
    ])
    expect(inactive.parentUnread["forum-1"]).toBe(true)
  })

  it("prunes expired base rows before a refresh can succeed", () => {
    const source = envelope(["expired", "fresh"])
    source.channels[0]!.expiresAt = "2026-08-08T00:30:00.000Z"
    source.channels[1]!.expiresAt = "2026-08-08T02:00:00.000Z"
    const normalized = normalizeForumSidebarEnvelope({
      ...source,
      canonicalChannels: source.channels,
      retainedChannel: null,
    }, null, 0)

    const projection = deriveForumSidebarProjection(
      normalized.base,
      null,
      {},
      Date.parse("2026-08-08T01:00:00.000Z"),
    )
    expect(projection.threads.map((thread) => thread.id)).toEqual(["fresh"])
  })
})
