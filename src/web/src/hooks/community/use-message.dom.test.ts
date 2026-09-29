import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { useMessage } from "./use-message"
import type { Msg } from "@/lib/community/models/message"

const apiFetchMock = vi.fn(() => new Promise(() => {}))
const canonicalMessagesMock = vi.hoisted(() => vi.fn<() => ReadonlyMap<string, Msg> | undefined>(
  () => undefined,
))
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))
vi.mock("@/lib/community-db/projections", () => ({
  useCanonicalMessagesById: () => canonicalMessagesMock(),
  useOptionalCommunityDbRegistry: () => canonicalMessagesMock() === undefined ? null : {},
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

describe("useMessage canonical projection", () => {
  it("keeps a missing id disabled and returns no message", () => {
    const queryClient = new QueryClient()
    const rendered = renderHook(() => useMessage(null), {
      wrapper: wrapperFor(queryClient),
    })

    expect(rendered.result.current.message).toBeNull()
    expect(rendered.result.current.isCanonicalPending).toBe(false)
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

  it("does not fall back to a raw single-message response in an active partial registry", () => {
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

    expect(rendered.result.current.message).toBeNull()
    expect(rendered.result.current.isCanonicalPending).toBe(true)
  })
})
