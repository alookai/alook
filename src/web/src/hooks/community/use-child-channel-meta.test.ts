import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChildChannelMeta } from "./use-forum-sidebar-threads"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"

const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import { pickRenderableChildMeta, useChildChannelMeta } from "./use-child-channel-meta"

const meta = (overrides: Partial<ChildChannelMeta> = {}): ChildChannelMeta => ({
  id: "post-1",
  serverId: "server-1",
  name: "post",
  type: "thread",
  parentChannelId: "forum-1",
  parentMessageId: "opener-1",
  creatorId: "user-1",
  archived: false,
  activityAt: "2026-08-09T00:00:00.000Z",
  verifiedEpoch: 2,
  ...overrides,
})

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 40 && !predicate(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}

function Capture() {
  useChildChannelMeta("server-1", "post-1", true)
  return null
}

beforeEach(() => {
  apiFetchMock.mockReset()
  apiFetchMock.mockResolvedValue({
    id: "post-1",
    serverId: "server-1",
    name: "post",
    type: "thread",
    parentChannelId: "forum-1",
    parentMessageId: "opener-1",
    creatorId: "user-1",
    archived: false,
    lastMessageAt: "2026-08-09T00:00:00.000Z",
    createdAt: "2026-08-08T00:00:00.000Z",
  })
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().markAccessConnected()
})

describe("child channel metadata stale rendering", () => {
  it("keeps a previously authorized snapshot renderable across a WS epoch", () => {
    const trusted = meta({ verifiedEpoch: 2 })
    expect(pickRenderableChildMeta(trusted, trusted, 3)).toBe(trusted)
  })

  it("does not render an old first response that was never trusted", () => {
    expect(pickRenderableChildMeta(meta({ verifiedEpoch: 2 }), undefined, 3)).toBeUndefined()
  })

  it("authoritative current-epoch archive removes a previously trusted snapshot", () => {
    const trusted = meta({ verifiedEpoch: 2 })
    expect(pickRenderableChildMeta(
      meta({ verifiedEpoch: 3, archived: true }),
      trusted,
      3,
    )).toBeUndefined()
  })

  it("starts exact metadata loading without waiting for the forum sidebar", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let renderer: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture),
        ),
      )
    })
    await waitFor(() => apiFetchMock.mock.calls.length === 1)

    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/channels/post-1")
    expect(queryClient.getQueryData(
      communityKeys.channelMeta("server-1", "post-1"),
    )).toMatchObject({ id: "post-1", parentChannelId: "forum-1" })
    renderer!.unmount()
  })
})
