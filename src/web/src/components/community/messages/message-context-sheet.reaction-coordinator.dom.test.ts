import React from "react"
import { act, render } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const state = {
    cache: undefined as undefined | {
      notFound: boolean
      anchorId: string
      messages: Array<Record<string, unknown>>
    },
    renderSnapshot: undefined as undefined | {
      notFound: boolean
      anchorId: string
      messages: Array<Record<string, unknown>>
    },
  }
  const queryClient = {
    getQueryData: vi.fn(() => state.cache),
    setQueryData: vi.fn((_key: unknown, updater: unknown) => {
      state.cache = typeof updater === "function"
        ? updater(state.cache)
        : updater as typeof state.cache
      return state.cache
    }),
  }
  return {
    state,
    queryClient,
    apiFetch: vi.fn(),
    toastApiError: vi.fn(),
    onToggle: undefined as undefined | ((messageId: string, emoji: string) => void),
    onAdd: undefined as undefined | ((messageId: string, emoji: string) => void),
  }
})

vi.mock("next/navigation", () => ({
  useParams: () => ({ serverId: "server_1" }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQuery: () => ({
      data: mocks.state.renderSnapshot,
      isLoading: false,
      isError: false,
    }),
    useQueryClient: () => mocks.queryClient,
  }
})
vi.mock("@/components/community/shell/community-sheet", () => ({
  CommunitySheet: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("./message-row", () => ({
  MessageRow: ({
    onToggleReactionId,
    onReactId,
  }: {
    onToggleReactionId?: (messageId: string, emoji: string) => void
    onReactId?: (messageId: string, emoji: string) => void
  }) => {
    mocks.onToggle = onToggleReactionId
    mocks.onAdd = onReactId
    return null
  },
}))
vi.mock("./message-share-dialog", () => ({ MessageShareDialog: () => null }))
vi.mock("../channels/channel-icon", () => ({ ChannelIcon: () => null }))
vi.mock("@/components/ui/skeleton", () => ({ Skeleton: () => null }))
vi.mock("../dividers", () => ({ DateDivider: () => null }))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "viewer_1" }),
}))
vi.mock("@/stores/community", async () => {
  const actual = await vi.importActual<typeof import("@/stores/community")>("@/stores/community")
  return { ...actual, useUiHandlers: () => ({}) }
})
vi.mock("@/hooks/use-hover-capable", () => ({ useHoverCapable: () => true }))
vi.mock("@/hooks/community/mutations", async () => {
  const reactions = await vi.importActual<typeof import("@/hooks/community/mutations/messages")>(
    "@/hooks/community/mutations/messages",
  )
  return {
    useToggleReactionApi: reactions.useToggleReactionApi,
    useAddReactionApi: reactions.useAddReactionApi,
    usePinMessage: () => ({ mutate: vi.fn() }),
    useUnpinMessage: () => ({ mutate: vi.fn() }),
    useCreateThread: () => ({ mutateAsync: vi.fn() }),
    useToggleMark: () => vi.fn(),
  }
})
vi.mock("sonner", () => ({ toast: vi.fn() }))
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
  toastApiError: (...args: unknown[]) => mocks.toastApiError(...args),
}))

import { useCommunityStore } from "@/stores/community"
import { MessageContextSheet } from "./message-context-sheet"

function sheetCache(me: boolean) {
  return {
    notFound: false,
    anchorId: "message_1",
    messages: [{
      id: "message_1",
      seq: 1,
      type: "chat",
      authorId: "author_1",
      authorName: "Author",
      content: "Message",
      createdAt: "2026-09-11T00:00:00.000Z",
      reactions: me
        ? [{ emoji: "👍", count: 1, me: true, userIds: ["viewer_1"] }]
        : [],
    }],
  }
}

function renderSheet(me: boolean) {
  const initial = sheetCache(me)
  mocks.state.cache = initial
  mocks.state.renderSnapshot = initial
  return render(React.createElement(MessageContextSheet, {
    open: true,
    onOpenChange: vi.fn(),
    channelId: "channel_1",
    targetSeq: 1,
  }))
}

function currentMe() {
  const reactions = mocks.state.cache?.messages[0]?.reactions as Array<{ emoji: string; me: boolean }>
  return reactions.find((reaction) => reaction.emoji === "👍")?.me ?? false
}

describe("MessageContextSheet reaction coordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.onToggle = undefined
    mocks.onAdd = undefined
    const timers = useCommunityStore.getState().reactionTimers
    for (const { timer } of timers.values()) clearTimeout(timer)
    timers.clear()
  })

  afterEach(() => {
    const timers = useCommunityStore.getState().reactionTimers
    for (const { timer } of timers.values()) clearTimeout(timer)
    timers.clear()
    vi.useRealTimers()
  })

  it("repeats picker add without a rerender and preserves the first timer deadline", async () => {
    mocks.apiFetch.mockResolvedValue(undefined)
    renderSheet(false)

    act(() => mocks.onAdd?.("message_1", "👍"))
    const timerKey = "message_1:👍"
    const firstPending = useCommunityStore.getState().reactionTimers.get(timerKey)
    const firstWriteCount = mocks.queryClient.setQueryData.mock.calls.length
    expect(currentMe()).toBe(true)
    expect(firstPending).toBeDefined()

    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    act(() => mocks.onAdd?.("message_1", "👍"))
    expect(mocks.queryClient.setQueryData).toHaveBeenCalledTimes(firstWriteCount)
    expect(useCommunityStore.getState().reactionTimers.get(timerKey)).toBe(firstPending)

    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/community/messages/message_1/reactions/"),
      { method: "PUT" },
    )
  })

  it("coalesces chip remove then picker add without a rerender to zero requests", async () => {
    renderSheet(true)

    act(() => mocks.onToggle?.("message_1", "👍"))
    expect(currentMe()).toBe(false)
    act(() => mocks.onAdd?.("message_1", "👍"))

    expect(currentMe()).toBe(true)
    expect(useCommunityStore.getState().reactionTimers.size).toBe(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

  it("rolls a failed add back and emits one error toast", async () => {
    const error = new Error("boom")
    mocks.apiFetch.mockRejectedValueOnce(error)
    renderSheet(false)

    act(() => mocks.onAdd?.("message_1", "👍"))
    expect(currentMe()).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
      await Promise.resolve()
    })

    expect(currentMe()).toBe(false)
    expect(mocks.toastApiError).toHaveBeenCalledOnce()
    expect(mocks.toastApiError).toHaveBeenCalledWith(error, "Failed to update reaction")
  })
})
