import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { beginCommunityProfileSeed } from "@/lib/community/profile-seed"

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  cancel: vi.fn(),
  close: vi.fn(),
  openThread: undefined as undefined | ((threadId: string) => void),
  pin: undefined as undefined | ((messageId: string) => void),
  toggleReaction: undefined as undefined | ((messageId: string, emoji: string) => void),
  addReaction: undefined as undefined | ((messageId: string, emoji: string) => void),
  toggleReactionApi: vi.fn(),
  addReactionApi: vi.fn(),
  setQueryData: vi.fn(),
  pinMutate: vi.fn(),
  unpinMutate: vi.fn(),
  toastApiError: vi.fn(),
  apiFetch: vi.fn(),
  noData: false,
  canonicalMessages: vi.fn<(_ids?: readonly string[]) => undefined>(() => undefined),
}))

vi.mock("next/navigation", () => ({
  useParams: () => ({ serverId: "server_1" }),
  useRouter: () => ({ push: mocks.push }),
}))
vi.mock("@tanstack/react-query", async (importOriginal) => ({ ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQuery: () => ({
    data: mocks.noData ? undefined : {
      notFound: false,
      anchorId: "message_1",
      messages: [{
        id: "message_1",
        seq: 1,
        type: "chat",
        authorId: "author_1",
        authorName: "Author",
        content: "Message",
        createdAt: "2026-08-20T00:00:00.000Z",
        thread: { id: "child_1", name: "Child", messageCount: 1 },
      }],
    },
    isLoading: false,
    isError: false,
  }),
  useQueryClient: () => ({
    getQueryData: () => ({
      notFound: false,
      anchorId: "message_1",
      messages: [{
        id: "message_1",
        seq: 1,
        type: "chat",
        reactions: [],
      }],
    }),
    setQueryData: mocks.setQueryData,
  }),
}))
vi.mock("@/components/community/shell/community-sheet", () => ({
  CommunitySheet: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("@/components/ui/sheet-resize-handle", () => ({
  useSheetResize: () => ({
    width: 420,
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
  }),
  SheetResizeHandle: () => null,
}))
vi.mock("./message-row", () => ({
  MessageRow: ({
    onOpenThread,
    onPinId,
    onToggleReactionId,
    onReactId,
  }: {
    onOpenThread: (threadId: string) => void
    onPinId?: (messageId: string) => void
    onToggleReactionId?: (messageId: string, emoji: string) => void
    onReactId?: (messageId: string, emoji: string) => void
  }) => {
    mocks.openThread = onOpenThread
    mocks.pin = onPinId
    mocks.toggleReaction = onToggleReactionId
    mocks.addReaction = onReactId
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
vi.mock("@/stores/community", async (importOriginal) => ({ ...await importOriginal<typeof import("@/stores/community")>(), useUiHandlers: () => ({ cancelPendingNavigation: mocks.cancel }) }))
vi.mock("@/hooks/use-hover-capable", () => ({ useHoverCapable: () => true }))
vi.mock("@/hooks/community/mutations", () => ({
  usePinMessage: () => ({ mutate: mocks.pinMutate }),
  useUnpinMessage: () => ({ mutate: mocks.unpinMutate }),
  useCreateThread: () => ({ mutateAsync: vi.fn() }),
  useToggleMark: () => vi.fn(),
  useToggleReactionApi: () => mocks.toggleReactionApi,
  useAddReactionApi: () => mocks.addReactionApi,
}))
vi.mock("sonner", () => ({ toast: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.apiFetch, toastApiError: mocks.toastApiError }))
vi.mock("@/lib/community-db/projections", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community-db/projections")>(
    "@/lib/community-db/projections",
  )
  return { ...actual, useCanonicalMessagesById: mocks.canonicalMessages }
})

import {
  MessageContextSheet,
  openMessageContextThread,
  messageContextQueryFn,
} from "./message-context-sheet"

describe("MessageContextSheet native query publication", () => {
  beforeEach(() => mocks.apiFetch.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it("publishes author profiles once with the sorted canonical context window and ID-only sheet cache", async () => {
    const owner = await createCommunityQueryOwner("context_viewer")
    const writer = await import("@/lib/community-db/write")
    const write = vi.spyOn(writer, "writeCommunityCollectionRows")
    const signal = new AbortController().signal
    mocks.apiFetch.mockResolvedValueOnce({ id: "anchor" }).mockResolvedValueOnce({ messages: [
      { id: "after", seq: 3, type: "chat", content: "after", authorId: "author", authorName: "Author" },
      { id: "anchor", seq: 2, type: "chat", content: "anchor", authorId: "author", authorName: "Author" },
    ], hasMore: false })
    await expect(messageContextQueryFn("channel", "context_channel", 2, owner.client)({ signal })).resolves.toEqual({
      notFound: false, anchorId: "anchor", messages: [{ id: "anchor" }, { id: "after" }],
    })
    expect(mocks.apiFetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/community/channels/context_channel/messages/seq/2",
      "/api/community/channels/context_channel/messages?anchor=anchor&limit=11",
    ])
    expect(mocks.apiFetch.mock.calls.every(([, options]) => options.signal === signal)).toBe(true)
    expect(write.mock.calls.filter(([, collection]) => collection === "profiles")).toHaveLength(1)
    expect(owner.registry.collections.messages.get("anchor")).toMatchObject({ content: "anchor", channelId: "context_channel", authorId: "author" })
    expect(owner.registry.collections.profiles.get("author")).toMatchObject({ name: "Author" })
    write.mockRestore()
  })

  it("keeps seq lookup404 as notFound without fetching or publishing a context page", async () => {
    const owner = await createCommunityQueryOwner("context_viewer")
    const revision = beginCommunityProfileSeed(owner.registry).revision
    const { ApiError } = await import("@/lib/errors")
    mocks.apiFetch.mockRejectedValueOnce(new ApiError("missing", 404))
    await expect(messageContextQueryFn("dm", "context_dm", 8, owner.client)()).resolves.toEqual({ notFound: true })
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)
    expect(beginCommunityProfileSeed(owner.registry).revision).toBe(revision)
    expect([...owner.registry.collections.messages.values()]).toEqual([])
  })

  it("rejects a late context page when its original channel scope retires", async () => {
    const owner = await createCommunityQueryOwner("context_viewer")
    const { retireCommunityChannelReading } = await import("@/lib/community-db/sync")
    let resolvePage!: (page: unknown) => void
    mocks.apiFetch.mockResolvedValueOnce({ id: "anchor" }).mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve }))
    const pending = messageContextQueryFn("channel", "context_channel", 2, owner.client)().catch((error) => error)
    while (!resolvePage) await Promise.resolve()
    retireCommunityChannelReading(owner.registry, "context_channel", { reason: "read-denied", serverId: "context_server" })
    resolvePage({ messages: [{ id: "anchor", seq: 2, type: "chat", content: "late", authorId: "author", authorName: "Late Author" }], hasMore: false })
    expect(await pending).toMatchObject({ name: "AbortError" })
    expect(owner.registry.collections.messages.get("anchor")).toBeUndefined()
    expect(owner.registry.collections.profiles.get("author")).toBeUndefined()
  })
})

describe("MessageContextSheet thread navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.openThread = undefined
    mocks.pin = undefined
    mocks.toggleReaction = undefined
    mocks.addReaction = undefined
    mocks.noData = false
  })

  it("selects only context window IDs and no canonical rows without query data", () => {
    const view = render(React.createElement(MessageContextSheet, {
      open: true, onOpenChange: mocks.close, channelId: "parent_1", targetSeq: 1,
    }))
    expect(mocks.canonicalMessages).toHaveBeenCalledWith(["message_1"])
    mocks.canonicalMessages.mockClear()
    mocks.noData = true
    view.rerender(React.createElement(MessageContextSheet, {
      open: true, onOpenChange: mocks.close, channelId: "parent_1", targetSeq: 2,
    }))
    expect(mocks.canonicalMessages).toHaveBeenCalledWith([])
  })

  it("opens a rendered channel thread by its flat child id and closes the sheet", () => {
    render(React.createElement(MessageContextSheet, {
      open: false,
      onOpenChange: mocks.close,
      channelId: "parent_1",
      targetSeq: 1,
    }))
    act(() => mocks.openThread?.("child_1"))

    expect(mocks.cancel).toHaveBeenCalledOnce()
    expect(mocks.cancel.mock.invocationCallOrder[0]).toBeLessThan(mocks.push.mock.invocationCallOrder[0]!)
    expect(mocks.push).toHaveBeenCalledWith("/c/channels/server_1/child_1")
    expect(mocks.close).toHaveBeenCalledWith(false)
  })

  it("does not navigate from a DM or without a server route", () => {
    const push = vi.fn()
    const close = vi.fn()

    expect(openMessageContextThread({
      type: "dm",
      serverId: "server_1",
      threadId: "child_1",
      push,
      close,
    })).toBe(false)
    expect(openMessageContextThread({
      type: "channel",
      threadId: "child_1",
      push,
      close,
    })).toBe(false)
    expect(push).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it("routes chips to toggle and picker choices to add through the sheet cache", () => {
    render(React.createElement(MessageContextSheet, {
      open: true,
      onOpenChange: mocks.close,
      channelId: "parent_1",
      targetSeq: 1,
    }))

    act(() => mocks.toggleReaction?.("message_1", "👍"))
    act(() => mocks.addReaction?.("message_1", "🔥"))

    expect(mocks.toggleReactionApi).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "parent_1",
      messageId: "message_1",
      emoji: "👍",
      currentMe: false,
      userId: "viewer_1",
      onError: expect.any(Function),
    }))
    expect(mocks.addReactionApi).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "parent_1",
      messageId: "message_1",
      emoji: "🔥",
      currentMe: false,
      userId: "viewer_1",
      onError: expect.any(Function),
    }))

    expect(mocks.setQueryData).not.toHaveBeenCalled()
  })

  it("exposes preview Pin only to managers and opens pinned only after success", () => {
    const onOpenPinned = vi.fn()
    const member = render(React.createElement(MessageContextSheet, {
      open: true,
      onOpenChange: mocks.close,
      channelId: "parent_1",
      targetSeq: 1,
      canManagePins: false,
      onOpenPinned,
    }))
    expect(mocks.pin).toBeUndefined()

    member.rerender(React.createElement(MessageContextSheet, {
      open: true,
      onOpenChange: mocks.close,
      channelId: "parent_1",
      targetSeq: 1,
      canManagePins: true,
      onOpenPinned,
    }))
    expect(mocks.pin).toEqual(expect.any(Function))

    act(() => mocks.pin?.("message_1"))
    expect(mocks.pinMutate).toHaveBeenCalledWith(
      { channelId: "parent_1", messageId: "message_1" },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    )
    expect(mocks.close).not.toHaveBeenCalled()
    expect(onOpenPinned).not.toHaveBeenCalled()

    const options = mocks.pinMutate.mock.calls.at(-1)?.[1]
    const error = new Error("role changed")
    act(() => options.onError(error))
    expect(mocks.toastApiError).toHaveBeenCalledWith(error, "Failed to pin message")
    expect(mocks.close).not.toHaveBeenCalled()
    expect(onOpenPinned).not.toHaveBeenCalled()

    act(() => options.onSuccess())
    expect(mocks.close).toHaveBeenCalledWith(false)
    expect(onOpenPinned).toHaveBeenCalledOnce()
  })

  it("never opens pinned automatically after preview Unpin", () => {
    const onOpenPinned = vi.fn()
    render(React.createElement(MessageContextSheet, {
      open: true,
      onOpenChange: mocks.close,
      channelId: "parent_1",
      targetSeq: 1,
      pinnedIds: new Set(["message_1"]),
      canManagePins: true,
      onOpenPinned,
    }))

    act(() => mocks.pin?.("message_1"))
    const options = mocks.unpinMutate.mock.calls.at(-1)?.[1]
    act(() => options.onSuccess())
    expect(mocks.close).not.toHaveBeenCalled()
    expect(onOpenPinned).not.toHaveBeenCalled()
  })
})
