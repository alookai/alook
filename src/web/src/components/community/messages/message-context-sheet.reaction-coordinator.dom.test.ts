import React from "react"
import { act } from "@/test/react-dom-harness"
import { render } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { publishCommunityMessages, captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(), toastApiError: vi.fn(),
  onToggle: undefined as undefined | ((messageId: string, emoji: string) => void),
  onAdd: undefined as undefined | ((messageId: string, emoji: string) => void),
}))
let owner: Awaited<ReturnType<typeof createCommunityQueryOwner>>

vi.mock("next/navigation", () => ({
  useParams: () => ({ serverId: "server_1" }),
  useRouter: () => ({ push: vi.fn() }),
}))
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

async function renderSheet(me: boolean) {
  const initial = sheetCache(me)
  publishCommunityMessages(owner.client, { channelId: "channel_1", messages: initial.messages, proof: { token: captureCommunityLiveSnapshotToken(owner.client), signal: undefined } })
  owner.client.setQueryData(communityKeys.messageContext("channel", "channel_1", 1), { ...initial, messages: initial.messages.map(({ id }) => ({ id })) })
  const rendered = render(React.createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "viewer_1", retainOwner: true }, React.createElement(MessageContextSheet, {
    open: true, onOpenChange: vi.fn(), channelId: "channel_1", targetSeq: 1,
  })))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(mocks.onAdd).toEqual(expect.any(Function))
  return rendered
}

function currentMe() {
  return owner.registry.collections.messages.get("message_1")?.reactions?.find((reaction) => reaction.emoji === "👍")?.me ?? false
}

describe("MessageContextSheet reaction coordinator", () => {
  beforeEach(async () => {
    owner = await createCommunityQueryOwner("viewer_1")
    vi.useFakeTimers()
    mocks.apiFetch.mockReset()
    mocks.toastApiError.mockReset()
    mocks.onToggle = undefined
    mocks.onAdd = undefined
  })

  afterEach(async () => {
    await act(async () => {
      owner.registry.runtime.lifecycle.setState((state) => ({ ...state, active: false, generation: state.generation + 1 }))
      await vi.advanceTimersByTimeAsync(500)
      vi.useRealTimers()
      await owner.client.cancelQueries()
      await owner.registry.cleanup()
      owner.client.clear()
    })
  })

  it("repeats picker add without a rerender and preserves the first timer deadline", async () => {
    mocks.apiFetch.mockResolvedValue(undefined)
    await renderSheet(false)
    const add = mocks.onAdd!

    act(() => add("message_1", "👍"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const firstPending = owner.client.getMutationCache().findAll({ status: "pending" })[0]
    const firstRow = owner.registry.collections.messages.get("message_1")
    expect(currentMe()).toBe(true)
    expect(firstPending).toBeDefined()

    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    act(() => add("message_1", "👍"))
    expect(owner.registry.collections.messages.get("message_1")).toBe(firstRow)
    expect(owner.client.getMutationCache().findAll({ status: "pending" })).toEqual([firstPending])

    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/community/messages/message_1/reactions/"),
      expect.objectContaining({ method: "PUT", signal: expect.any(AbortSignal), assertActive: expect.any(Function) }),
    )
  })

  it("coalesces chip remove then picker add without a rerender to zero requests", async () => {
    await renderSheet(true)
    const toggle = mocks.onToggle!, add = mocks.onAdd!

    act(() => toggle("message_1", "👍"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(currentMe()).toBe(false)
    act(() => add("message_1", "👍"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    expect(currentMe()).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(owner.client.getMutationCache().findAll({ status: "pending" })).toHaveLength(0)
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

  it("rolls a failed add back and emits one error toast", async () => {
    const error = new Error("boom")
    mocks.apiFetch.mockRejectedValueOnce(error)
    await renderSheet(false)

    act(() => mocks.onAdd?.("message_1", "👍"))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
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
