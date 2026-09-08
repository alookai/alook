import React from "react"
import { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { useCommunityStore } from "@/stores/community"
import { communityKeys } from "@/lib/query-keys"

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  replace: vi.fn(),
  clearLastChannel: vi.fn(),
  consumeColdEntryFailure: vi.fn(() => false),
  lastChannel: null as string | null,
  server: undefined as undefined | Record<string, unknown>,
  metaQuery: {
    data: undefined as undefined | Record<string, unknown>,
    error: null as unknown,
    isVerified: false,
    isError: false,
  },
}))

const queryClient = new QueryClient()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}))
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return { ...actual, useQueryClient: () => queryClient }
})
vi.mock("./use-servers", () => ({
  useServer: () => ({ server: mocks.server }),
}))
vi.mock("./use-child-channel-meta", () => ({
  useChildChannelMeta: () => mocks.metaQuery,
}))
vi.mock("./use-community-ws", () => ({
  communityWsSubscribe: (...args: unknown[]) => mocks.subscribe(...args),
  communityWsUnsubscribe: (...args: unknown[]) => mocks.unsubscribe(...args),
}))
vi.mock("@/lib/api/client", () => ({ toastApiError: vi.fn() }))
vi.mock("@/lib/community/last-channel", () => ({
  getLastChannel: () => mocks.lastChannel,
  clearLastChannel: (...args: unknown[]) => mocks.clearLastChannel(...args),
}))
vi.mock("@/lib/community/last-community-route", () => ({
  COMMUNITY_COLD_ENTRY_FALLBACK: "/c/me/machines",
  consumeCommunityColdEntryFailure: (...args: unknown[]) => mocks.consumeColdEntryFailure(...args),
}))

import { buildChannelRouteModel, useChannelRouteModel } from "./use-channel-route-model"

function Harness({ channelId = "post-1" }: { channelId?: string }) {
  const result = useChannelRouteModel("server-1", "server-1", channelId, "viewer-1")
  return React.createElement("span", {
    "data-lifecycle": result.routeLifecycle,
    "data-skeleton-subtype": result.skeletonSubtype,
  })
}

function lifecycle(renderer: ReturnType<typeof render>) {
  return renderer.container.querySelector("span")?.getAttribute("data-lifecycle")
}

beforeEach(() => {
  useCommunityStore.getState().reset()
  mocks.subscribe.mockClear()
  mocks.unsubscribe.mockClear()
  mocks.replace.mockClear()
  mocks.clearLastChannel.mockClear()
  mocks.consumeColdEntryFailure.mockReset()
  mocks.consumeColdEntryFailure.mockReturnValue(false)
  mocks.lastChannel = null
  mocks.server = {
    id: "server-1",
    categories: [{
      id: "cat-1",
      channels: [{ id: "forum-1", name: "Forum", type: "forum" }],
    }],
  }
  mocks.metaQuery = { data: undefined, error: null, isVerified: false, isError: false }
})

afterEach(() => {
  useCommunityStore.getState().reset()
})

describe("useChannelRouteModel subscription ownership", () => {
  it("moves a top-level channel from pending to ready when server categories hydrate", () => {
    mocks.server = undefined
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(React.createElement(Harness, { channelId: "forum-1" }))
    })
    expect(lifecycle(renderer!)).toBe("pending")

    mocks.server = {
      id: "server-1",
      categories: [{
        id: "cat-1",
        channels: [{ id: "forum-1", name: "Forum", type: "forum" }],
      }],
    }
    act(() => {
      renderer!.rerender(React.createElement(Harness, { channelId: "forum-1" }))
    })

    expect(lifecycle(renderer!)).toBe("ready")
    expect(mocks.metaQuery.isVerified).toBe(false)
    act(() => renderer!.unmount())
  })

  it("uses persisted structure only to choose the pending skeleton subtype", () => {
    mocks.server = undefined
    queryClient.setQueryData(communityKeys.structuralSnapshot(), {
      schemaVersion: 1,
      accountId: "viewer-1",
      capturedAt: Date.now(),
      serverOrder: ["server-1"],
      folders: [],
      servers: [{
        id: "server-1",
        name: "Server",
        discriminator: "0001",
        icon: null,
        categories: [],
        channels: [{ id: "forum-1", name: "Forum", type: "forum", categoryId: null }],
        childRouteHints: [],
      }],
    })

    let renderer!: ReturnType<typeof render>
    act(() => {
      renderer = render(React.createElement(Harness, { channelId: "forum-1" }))
    })

    const node = renderer.container.querySelector("span")
    expect(node?.getAttribute("data-lifecycle")).toBe("pending")
    expect(node?.getAttribute("data-skeleton-subtype")).toBe("forum")
    expect(useCommunityStore.getState().currentChannelMeta).toBeNull()
    act(() => renderer.unmount())
  })

  it("reports the live top-level text subtype after access is ready", () => {
    mocks.server = {
      id: "server-1",
      categories: [{
        id: "cat-1",
        channels: [{ id: "text-1", name: "Chat", type: "text" }],
      }],
    }

    const renderer = render(React.createElement(Harness, { channelId: "text-1" }))

    const node = renderer.container.querySelector("span")
    expect(node?.getAttribute("data-lifecycle")).toBe("ready")
    expect(node?.getAttribute("data-skeleton-subtype")).toBe("text")
    act(() => renderer.unmount())
  })

  it("does not hydrate a verified child with the previous child's store metadata", () => {
    const model = buildChannelRouteModel(
      {
        id: "server-1",
        categories: [{
          id: "cat-1",
          channels: [{ id: "forum-1", name: "Forum", type: "forum" }],
        }],
      } as never,
      {
        id: "post-old",
        parentChannelId: "forum-1",
        parentMessageId: "opener-old",
      } as never,
      "post-1",
      { channelId: "post-1", settled: true },
    )

    expect(model.currentChannelMeta).toBeNull()
    expect(model.routeHydrated).toBe(false)
  })

  it("does not unsubscribe/resubscribe when metadata becomes verified", () => {
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(React.createElement(Harness))
    })
    expect(mocks.subscribe).toHaveBeenCalledTimes(1)
    expect(mocks.unsubscribe).not.toHaveBeenCalled()
    expect(lifecycle(renderer!)).toBe("pending")

    mocks.metaQuery = {
      data: {
        id: "post-1",
        serverId: "server-1",
        name: "Post",
        type: "thread",
        parentChannelId: "forum-1",
        parentMessageId: "opener-1",
        creatorId: "user-1",
        archived: false,
        activityAt: "2026-08-09T00:00:00.000Z",
        verifiedEpoch: 0,
      },
      error: null,
      isVerified: true,
      isError: false,
    }
    act(() => {
      renderer!.rerender(React.createElement(Harness))
    })

    expect(mocks.subscribe).toHaveBeenCalledTimes(1)
    expect(mocks.unsubscribe).not.toHaveBeenCalled()
    expect(useCommunityStore.getState().currentChannelMeta).toMatchObject({
      parentChannelId: "forum-1",
      parentMessageId: "opener-1",
    })
    expect(lifecycle(renderer!)).toBe("ready")

    act(() => renderer!.unmount())
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("exposes terminal-error only after the child metadata query errors", () => {
    mocks.metaQuery = {
      data: undefined,
      error: new Error("metadata unavailable"),
      isVerified: false,
      isError: true,
    }
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(React.createElement(Harness))
    })
    expect(lifecycle(renderer!)).toBe("terminal-error")
    act(() => renderer!.unmount())
  })

  it("clears an exact flat last-channel value when verified metadata is archived", () => {
    mocks.lastChannel = "post-1"
    mocks.metaQuery = {
      data: {
        id: "post-1",
        serverId: "server-1",
        name: "Post",
        type: "thread",
        parentChannelId: "forum-1",
        parentMessageId: "opener-1",
        creatorId: "user-1",
        archived: true,
        activityAt: "2026-08-09T00:00:00.000Z",
        verifiedEpoch: 0,
      },
      error: null,
      isVerified: true,
      isError: false,
    }
    let renderer: ReturnType<typeof render>

    act(() => {
      renderer = render(React.createElement(Harness))
    })

    expect(mocks.clearLastChannel).toHaveBeenCalledWith("server-1")
    expect(mocks.replace).toHaveBeenCalledWith("/c/channels/server-1")
    expect(mocks.subscribe).toHaveBeenCalledTimes(1)
    expect(mocks.unsubscribe).not.toHaveBeenCalled()

    act(() => renderer!.unmount())
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("falls back once to Machines when the archived child was a cold-entry restore", () => {
    mocks.consumeColdEntryFailure.mockReturnValue(true)
    mocks.metaQuery = {
      data: {
        id: "post-1",
        serverId: "server-1",
        name: "Post",
        type: "thread",
        parentChannelId: "forum-1",
        parentMessageId: "opener-1",
        creatorId: "user-1",
        archived: true,
        activityAt: "2026-08-09T00:00:00.000Z",
        verifiedEpoch: 0,
      },
      error: null,
      isVerified: true,
      isError: false,
    }

    let renderer!: ReturnType<typeof render>
    act(() => {
      renderer = render(React.createElement(Harness))
    })

    expect(mocks.consumeColdEntryFailure).toHaveBeenCalledWith(
      "viewer-1",
      "/c/channels/server-1/post-1",
    )
    expect(mocks.replace).toHaveBeenCalledWith("/c/me/machines")
    act(() => renderer.unmount())
  })
})
