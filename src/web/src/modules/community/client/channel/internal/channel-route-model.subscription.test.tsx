import React from "react"
import { createRequire } from "node:module"
import { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useCommunityStore } from "@/stores/community"

type ReactTestRenderer = {
  unmount: () => void
  update: (element: React.ReactElement) => void
}
const rendererModule = createRequire(import.meta.url)("react-test-renderer") as {
  act: (callback: () => void) => void
  create: (element: React.ReactElement) => ReactTestRenderer
}
const { act } = rendererModule

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  replace: vi.fn(),
  clearLastChannel: vi.fn(),
  removeUnread: vi.fn(),
  removeThread: vi.fn(),
  toastApiError: vi.fn(),
  denied: false,
  lastChannel: "post-1" as string | null,
  metaQuery: {
    data: undefined as undefined | Record<string, unknown>,
    error: null as unknown,
    isVerified: false,
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
vi.mock("@/hooks/community/use-servers", () => ({
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
vi.mock("@/hooks/community/use-child-channel-meta", () => ({
  useChildChannelMeta: () => mocks.metaQuery,
}))
vi.mock("@/hooks/community/use-community-ws", () => ({
  communityWsSubscribe: (...args: unknown[]) => mocks.subscribe(...args),
  communityWsUnsubscribe: (...args: unknown[]) => mocks.unsubscribe(...args),
}))
vi.mock("@/lib/api/client", () => ({ toastApiError: (...args: unknown[]) => mocks.toastApiError(...args) }))
vi.mock("@/lib/community/eject-server", () => ({
  isDefinitiveChildMetaFailure: () => mocks.denied,
}))
vi.mock("@/lib/community/last-channel", () => ({
  getLastChannel: () => mocks.lastChannel,
  clearLastChannel: (...args: unknown[]) => mocks.clearLastChannel(...args),
}))
vi.mock("@/hooks/community/use-forum-sidebar-threads", () => ({
  removeForumSidebarUnreadChild: (...args: unknown[]) => mocks.removeUnread(...args),
  removeForumSidebarThreadExact: (...args: unknown[]) => mocks.removeThread(...args),
}))

import { useChannelRouteModel } from "./channel-route-model"

function Harness({ channelId = "post-1" }: { channelId?: string }) {
  useChannelRouteModel("server-1", "server-1", channelId)
  return null
}

beforeEach(() => {
  useCommunityStore.getState().reset()
  mocks.subscribe.mockClear()
  mocks.unsubscribe.mockClear()
  mocks.replace.mockClear()
  mocks.clearLastChannel.mockClear()
  mocks.removeUnread.mockClear()
  mocks.removeThread.mockClear()
  mocks.toastApiError.mockClear()
  mocks.denied = false
  mocks.lastChannel = "post-1"
  mocks.metaQuery = { data: undefined, error: null, isVerified: false }
})

afterEach(() => {
  useCommunityStore.getState().reset()
})

describe("useChannelRouteModel subscription ownership", () => {
  it("does not unsubscribe/resubscribe when metadata becomes verified", () => {
    let renderer: ReactTestRenderer
    act(() => {
      renderer = rendererModule.create(React.createElement(Harness))
    })
    expect(mocks.subscribe).toHaveBeenCalledTimes(1)
    expect(mocks.unsubscribe).not.toHaveBeenCalled()

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

    act(() => renderer!.unmount())
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("clears exact child state and remembered navigation after definitive denial", () => {
    mocks.denied = true
    mocks.metaQuery = { data: undefined, error: new Error("forbidden"), isVerified: false }
    let renderer: ReactTestRenderer
    act(() => {
      renderer = rendererModule.create(React.createElement(Harness))
    })
    expect(mocks.removeUnread).toHaveBeenCalledWith(queryClient, "server-1", "post-1")
    expect(mocks.removeThread).toHaveBeenCalledWith(queryClient, "server-1", "post-1")
    expect(mocks.clearLastChannel).toHaveBeenCalledWith("server-1")
    expect(mocks.replace).toHaveBeenCalledWith("/c/channels/server-1")
    act(() => renderer!.unmount())
  })

  it("clears top-level metadata without invoking child cleanup", () => {
    let renderer: ReactTestRenderer
    act(() => { renderer = rendererModule.create(React.createElement(Harness, { channelId: "forum-1" })) })
    expect(useCommunityStore.getState().currentChannelMeta).toBeNull()
    expect(mocks.removeUnread).not.toHaveBeenCalled()
    act(() => renderer!.unmount())
  })

  it("ejects archived children without clearing another remembered channel", () => {
    mocks.lastChannel = "another-channel"
    mocks.metaQuery = {
      data: { id: "post-1", archived: true },
      error: null,
      isVerified: true,
    }
    let renderer: ReactTestRenderer
    act(() => { renderer = rendererModule.create(React.createElement(Harness)) })
    expect(mocks.removeUnread).toHaveBeenCalled()
    expect(mocks.clearLastChannel).not.toHaveBeenCalled()
    expect(mocks.replace).toHaveBeenCalledWith("/c/channels/server-1")
    act(() => renderer!.unmount())
  })

  it("reports transient child metadata failures without ejecting the route", () => {
    const error = new Error("network")
    mocks.metaQuery = { data: undefined, error, isVerified: false }
    let renderer: ReactTestRenderer
    act(() => { renderer = rendererModule.create(React.createElement(Harness)) })
    expect(mocks.toastApiError).toHaveBeenCalledWith(error, "Failed to load thread")
    expect(mocks.replace).not.toHaveBeenCalled()
    act(() => renderer!.unmount())
  })
})
