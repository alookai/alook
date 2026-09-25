import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { useMessage } from "./use-message"
import type { Msg } from "@/lib/community/models/message"
import { getActiveAccountUnreadProjection } from "./account-unread-projection"
import { takeMessageIdsForAccessScope } from "@/lib/community-db/message-access-scope"

const apiFetchMock = vi.fn(() => new Promise(() => {}))
const canonicalMessagesMock = vi.hoisted(() => vi.fn<() => ReadonlyMap<string, Msg> | undefined>(
  () => undefined,
))
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))
vi.mock("@/lib/community-db/projections", () => ({
  useCanonicalMessagesById: () => canonicalMessagesMock(),
}))

beforeEach(() => {
  apiFetchMock.mockClear()
  canonicalMessagesMock.mockReset()
  canonicalMessagesMock.mockReturnValue(undefined)
})

function wrapperFor(queryClient: QueryClient) {
  return function QueryWrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

describe("useMessage cache-first placeholder", () => {
  it("returns a cached list message while the canonical message query is pending", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.channelMessages("channel-1"), {
      pages: [{
        messages: [{
          id: "m_1",
          type: "chat",
          authorId: "u_1",
          authorName: "Alice",
          content: "cached opener",
          createdAt: "2026-07-03T00:00:00.000Z",
        }],
        hasMore: false,
      }],
      pageParams: [{ mode: "newest" }],
    })

    const rendered = renderHook(() => useMessage("m_1", {
      channelId: "channel-1",
      serverId: "server-1",
    }), {
      wrapper: wrapperFor(queryClient),
    })

    expect(rendered.result.current.message).toMatchObject({
      id: "m_1",
      authorId: "u_1",
      content: "cached opener",
    })
    expect(rendered.result.current.isPlaceholderData).toBe(true)
  })

  it("keeps a missing id disabled and returns no message", () => {
    const queryClient = new QueryClient()
    const rendered = renderHook(() => useMessage(null), {
      wrapper: wrapperFor(queryClient),
    })

    expect(rendered.result.current.message).toBeNull()
    expect(rendered.result.current.fetchStatus).toBe("idle")
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it("uses canonical identity exclusively when the DB provider is active", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.message("m_1"), {
      id: "m_1",
      type: "chat",
      authorId: "raw",
      authorName: "Raw",
      authorAvatar: "R",
      authorAvatarVersion: 0,
      content: "raw query",
      createdAt: "2026-09-25T00:00:00.000Z",
    })
    canonicalMessagesMock.mockReturnValue(new Map([[
      "m_1",
      {
        id: "m_1",
        type: "chat",
        authorId: "canonical",
        authorName: "Canonical",
        authorAvatar: "C",
        authorAvatarVersion: 0,
        content: "canonical row",
        createdAt: "2026-09-25T00:00:00.000Z",
      },
    ]]))
    const rendered = renderHook(() => useMessage("m_1", {
      channelId: "channel-1",
      serverId: "server-1",
    }), {
      wrapper: wrapperFor(queryClient),
    })

    expect(rendered.result.current.message).toMatchObject({
      authorId: "canonical",
      content: "canonical row",
    })
  })

  it("falls back to a raw single-message response in an active partial registry", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.message("m_1"), {
      id: "m_1",
      type: "chat",
      authorId: "raw",
      authorName: "Raw",
      authorAvatar: "R",
      authorAvatarVersion: 0,
      content: "raw query",
      createdAt: "2026-09-25T00:00:00.000Z",
      attachments: [{
        kind: "file",
        name: "raw.txt",
        url: "/raw.txt",
        size: "1 KB",
      }],
    })
    canonicalMessagesMock.mockReturnValue(new Map())
    const rendered = renderHook(() => useMessage("m_1", {
      channelId: "channel-1",
      serverId: "server-1",
    }), {
      wrapper: wrapperFor(queryClient),
    })

    expect(rendered.result.current.message).toMatchObject({
      authorId: "raw",
      content: "raw query",
      attachments: [expect.objectContaining({ name: "raw.txt" })],
    })
  })

  it("keeps the access index empty while fenced and restores it after rollback or grant", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.message("m_1"), {
      id: "m_1",
      type: "chat",
      authorId: "raw",
      authorName: "Raw",
      authorAvatar: "R",
      authorAvatarVersion: 0,
      content: "must not revive",
      createdAt: "2026-09-25T00:00:00.000Z",
    })
    canonicalMessagesMock.mockReturnValue(new Map())
    const rendered = renderHook(() => useMessage("m_1", {
      channelId: "channel-1",
      serverId: "server-1",
    }), {
      wrapper: wrapperFor(queryClient),
    })
    expect(rendered.result.current.message).toMatchObject({ content: "must not revive" })
    expect(takeMessageIdsForAccessScope(
      queryClient,
      new Set(["channel-1"]),
      null,
    )).toEqual(["m_1"])

    const projection = getActiveAccountUnreadProjection(queryClient)
    let retirement!: ReturnType<typeof projection.beginScopeRetirement>
    act(() => {
      retirement = projection.beginScopeRetirement({ kind: "channel", channelId: "channel-1" })
    })
    expect(rendered.result.current.message).toBeNull()
    expect(rendered.result.current.fetchStatus).toBe("idle")
    expect(takeMessageIdsForAccessScope(
      queryClient,
      new Set(["channel-1"]),
      null,
    )).toEqual([])

    act(() => projection.rollbackScopeRetirement(retirement))
    expect(rendered.result.current.message).toMatchObject({ content: "must not revive" })
    expect(takeMessageIdsForAccessScope(
      queryClient,
      new Set(["channel-1"]),
      null,
    )).toEqual(["m_1"])

    act(() => projection.retireAccessScope({ kind: "channel", channelId: "channel-1" }))
    expect(rendered.result.current.message).toBeNull()
    expect(takeMessageIdsForAccessScope(
      queryClient,
      new Set(["channel-1"]),
      null,
    )).toEqual([])

    act(() => {
      projection.grantAccessScope({ kind: "channel", channelId: "channel-1" })
      projection.confirmAccessScopes(
        [{ kind: "channel", channelId: "channel-1" }],
        projection.beginAccessConfirmation(),
      )
    })
    expect(rendered.result.current.message).toMatchObject({ content: "must not revive" })
    expect(takeMessageIdsForAccessScope(
      queryClient,
      new Set(["channel-1"]),
      null,
    )).toEqual(["m_1"])
  })
})
