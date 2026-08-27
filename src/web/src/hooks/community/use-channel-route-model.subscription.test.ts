import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useCommunityStore } from "@/stores/community"

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  replace: vi.fn(),
  clearLastChannel: vi.fn(),
  lastChannel: null as string | null,
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
  useServer: () => ({
    server: {
      id: "server-1",
      categories: [{
        id: "cat-1",
        channels: [{ id: "forum-1", name: "Forum", type: "forum" }],
      }],
    },
  }),
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

import { buildChannelRouteModel, useChannelRouteModel } from "./use-channel-route-model"

function Harness() {
  const result = useChannelRouteModel("server-1", "server-1", "post-1")
  return React.createElement("span", { "data-lifecycle": result.routeLifecycle })
}

function lifecycle(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType("span").props["data-lifecycle"]
}

beforeEach(() => {
  useCommunityStore.getState().reset()
  mocks.subscribe.mockClear()
  mocks.unsubscribe.mockClear()
  mocks.replace.mockClear()
  mocks.clearLastChannel.mockClear()
  mocks.lastChannel = null
  mocks.metaQuery = { data: undefined, error: null, isVerified: false, isError: false }
})

afterEach(() => {
  useCommunityStore.getState().reset()
})

describe("useChannelRouteModel subscription ownership", () => {
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
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(Harness))
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
      renderer!.update(React.createElement(Harness))
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
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(Harness))
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
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(React.createElement(Harness))
    })

    expect(mocks.clearLastChannel).toHaveBeenCalledWith("server-1")
    expect(mocks.replace).toHaveBeenCalledWith("/c/channels/server-1")
    expect(mocks.subscribe).toHaveBeenCalledTimes(1)
    expect(mocks.unsubscribe).not.toHaveBeenCalled()

    act(() => renderer!.unmount())
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
