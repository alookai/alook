import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useMessageChannelController } from "./message-channel-controller-state"
import { avatarInitial } from "@/lib/community/avatar"
import type {
  MessageChannelControllerProps,
} from "./message-channel-controller-types"
import type { MessageChannelControllerValue } from "./message-channel-controller"

const mocks = vi.hoisted(() => {
  const order: string[] = []
  const router = { replace: vi.fn() }
  const storeState = {
    pendingReply: null as null | { channelId: string; target: { id: string; authorName: string; text: string } },
    setPendingReply: vi.fn(),
    registerUiHandlers: vi.fn(),
  }
  const messageActions = {
    onToggleReaction: vi.fn(), onReact: vi.fn(), onReply: vi.fn(), onPin: vi.fn(),
    onMark: vi.fn(), onCreateThread: vi.fn(async () => {}), onCopy: vi.fn(), onEdit: vi.fn(),
    onRetry: vi.fn(), onDismiss: vi.fn(), onPreviewImage: vi.fn(),
    onPreviewAttachment: vi.fn(), onDownloadFile: vi.fn(),
  }
  return {
    order,
    router,
    storeState,
    messageActions,
    apiFetch: vi.fn(),
    toastApiError: vi.fn(),
    sendTyping: vi.fn(),
    createActions: vi.fn((_input?: unknown) => messageActions),
    accept: vi.fn(() => true),
    run: vi.fn(async () => {}),
    seq: null as string | null,
    sendMutation: vi.fn(),
    reactionMutation: vi.fn(),
    pinMutation: vi.fn(),
    unpinMutation: vi.fn(),
    markMutation: vi.fn(),
    editMutation: vi.fn(),
    threadMutation: vi.fn(),
    uploadMutation: vi.fn(),
    typingScopes: { users: [] as string[], names: [] as string[] },
    typingIds: ["u1"],
    typingNames: { u1: "Alice" },
  }
})

vi.mock("next/navigation", () => ({
  useRouter: () => mocks.router,
  useSearchParams: () => ({ get: (key: string) => key === "seq" ? mocks.seq : null }),
}))
vi.mock("@/lib/api/client", () => ({
  apiFetch: mocks.apiFetch,
  toastApiError: mocks.toastApiError,
}))
vi.mock("@/stores/community", () => {
  const useCommunityStore = Object.assign(
    (selector: (state: typeof mocks.storeState) => unknown) => {
      mocks.order.push("pending-store")
      return selector(mocks.storeState)
    },
    { getState: () => mocks.storeState },
  )
  return {
    useCommunityStore,
    useTypingUsersForScope: (scope: string) => {
      mocks.order.push("typing-users")
      mocks.typingScopes.users.push(scope)
      return mocks.typingIds
    },
    useTypingNamesForScope: (scope: string) => {
      mocks.order.push("typing-names")
      mocks.typingScopes.names.push(scope)
      return mocks.typingNames
    },
  }
})
vi.mock("@/hooks/community/mutations", () => ({
  useSendMessage: () => { mocks.order.push("send"); return { mutateAsync: mocks.sendMutation } },
  useToggleReactionApi: () => { mocks.order.push("reaction"); return mocks.reactionMutation },
  usePinMessage: () => { mocks.order.push("pin"); return { mutate: mocks.pinMutation } },
  useUnpinMessage: () => { mocks.order.push("unpin"); return { mutate: mocks.unpinMutation } },
  useToggleMark: () => { mocks.order.push("mark"); return mocks.markMutation },
  useEditMessage: () => { mocks.order.push("edit"); return { mutate: mocks.editMutation } },
  useCreateThread: () => { mocks.order.push("thread"); return { mutateAsync: mocks.threadMutation } },
  useUploadFile: () => { mocks.order.push("upload"); return { mutateAsync: mocks.uploadMutation } },
}))
vi.mock("@/hooks/community/use-community-ws", () => ({
  communityWsSendTyping: mocks.sendTyping,
}))
vi.mock("./message-channel-controller-actions", () => ({
  createMessageActions: mocks.createActions,
}))
vi.mock("./message-channel-controller-send", () => ({
  acceptChannelMessage: mocks.accept,
  runAcceptedMessageIntent: mocks.run,
}))

const feed = {
  messages: [{ id: "m1", seq: 1, type: "chat", authorName: "Alice", content: "hi" }],
  pinned: [],
  isError: false,
} as MessageChannelControllerProps["feed"]

function props(overrides: Partial<MessageChannelControllerProps> = {}): Omit<MessageChannelControllerProps, "children"> {
  return {
    channelId: "channel_1",
    serverId: "server_1",
    serverParam: "server_1",
    channelName: "general",
    viewer: { id: "viewer_1", name: "Viewer", avatar: "V" },
    anchorMessageId: "m1",
    feed,
    uiHandlers: {},
    onOpenThread: vi.fn(),
    onOpenPinned: vi.fn(),
    resolveUserName: (id) => id,
    ...overrides,
  }
}

let latest: MessageChannelControllerValue
function Probe({ value }: { value: Omit<MessageChannelControllerProps, "children"> }) {
  const controller = useMessageChannelController(value)
  React.useLayoutEffect(() => { latest = controller }, [controller])
  return null
}

function PassiveActionProbe({
  value,
}: {
  value: Omit<MessageChannelControllerProps, "children">
}) {
  const controller = useMessageChannelController(value)
  React.useLayoutEffect(() => { latest = controller }, [controller])
  React.useEffect(() => { controller.messageActions.onReply("probe") })
  return null
}

describe("useMessageChannelController", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.order.length = 0
    mocks.seq = null
    mocks.storeState.pendingReply = null
    mocks.apiFetch.mockResolvedValue({ results: [] })
    mocks.createActions.mockImplementation(() => mocks.messageActions)
    mocks.typingScopes.users.length = 0
    mocks.typingScopes.names.length = 0
    mocks.typingIds = ["u1"]
    mocks.typingNames = { u1: "Alice" }
  })
  afterEach(() => vi.clearAllMocks())

  it("preserves mutation/selector hook order and final-value identity churn", async () => {
    const valueProps = props()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(React.createElement(Probe, { value: valueProps })) })
    expect(mocks.order.slice(0, 11)).toEqual([
      "send", "reaction", "pin", "unpin", "mark", "edit", "thread", "upload",
      "typing-users", "typing-names", "pending-store",
    ])
    expect(mocks.typingScopes.users.length).toBeGreaterThan(0)
    expect(mocks.typingScopes.names.length).toBeGreaterThan(0)
    expect(mocks.typingScopes.users.every((scope) => scope === "ch:channel_1")).toBe(true)
    expect(mocks.typingScopes.names.every((scope) => scope === "ch:channel_1")).toBe(true)
    const firstValue = latest
    const firstActions = latest.messageActions
    const firstThreadActions = latest.threadActions
    const firstTyping = latest.handleTyping
    act(() => { renderer!.update(React.createElement(Probe, { value: valueProps })) })
    expect(latest).toBe(firstValue)
    expect(latest.threadActions).toBe(firstThreadActions)
    expect(latest.handleTyping).toBe(firstTyping)
    expect(latest.feed).toBe(valueProps.feed)

    await act(async () => { await (latest.search as (query: string) => Promise<void>)("hello") })
    expect(latest).not.toBe(firstValue)
    expect(latest.messageActions).toBe(firstActions)
    expect(latest.threadActions).not.toBe(firstThreadActions)
    expect(latest.handleTyping).not.toBe(firstTyping)
    act(() => latest.handleTyping())
    expect(mocks.sendTyping).toHaveBeenCalledWith({ channelId: "channel_1" })

    const afterSearch = latest
    const afterSearchThreadActions = latest.threadActions
    const afterSearchTyping = latest.handleTyping
    const updatedFeed = { ...feed, messages: [...feed.messages] }
    act(() => {
      renderer!.update(React.createElement(Probe, {
        value: { ...valueProps, feed: updatedFeed },
      }))
    })
    expect(latest).not.toBe(afterSearch)
    expect(latest.messageActions).toBe(firstActions)
    expect(latest.threadActions).not.toBe(afterSearchThreadActions)
    expect(latest.handleTyping).not.toBe(afterSearchTyping)
    expect(latest.feed).toBe(updatedFeed)

    const afterFeed = latest
    const latestOpenThread = vi.fn()
    act(() => {
      renderer!.update(React.createElement(Probe, {
        value: { ...valueProps, feed: updatedFeed, onOpenThread: latestOpenThread },
      }))
    })
    expect(latest).toBe(afterFeed)
    expect(latest.messageActions).toBe(firstActions)
  })

  it("keeps scroll target and lets a captured channel-one search complete after channel reset", async () => {
    let resolveOld: (value: unknown) => void = () => {}
    mocks.apiFetch.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    let renderer: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(React.createElement(Probe, { value: props() })) })
    let oldPromise: Promise<void>
    act(() => { oldPromise = (latest.search as (query: string) => Promise<void>)("old") })
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      "/api/community/messages/search?q=old&channelId=channel_1",
    )
    act(() => latest.setReplyTo({ id: "r1", authorName: "A", text: "x" }))
    act(() => latest.setContextTarget({
      serverId: "server_1", channelId: "channel_1", label: "general", seq: 42,
    }))
    expect(latest.searchQuery).toBe("old")
    expect(latest.contextTarget?.seq).toBe(42)
    act(() => {
      renderer!.update(React.createElement(Probe, {
        value: props({ channelId: "channel_2", channelName: "random" }),
      }))
    })
    expect(latest.replyTo).toBeNull()
    expect(latest.searchQuery).toBe("")
    expect(latest.searchResults).toEqual([])
    expect(latest.contextTarget).toBeNull()
    expect(latest.scrollTargetId).toBe("m1")

    await act(async () => {
      resolveOld({ results: [{
        message: { id: "old_1", content: "old", authorId: "u1", createdAt: "2026-01-01" },
        author: { name: "Alice", image: null },
      }] })
      await oldPromise!
    })
    expect(latest.searchQuery).toBe("")
    expect(latest.searchResults).toEqual([{
      id: "old_1",
      type: "chat",
      authorName: "Alice",
      authorAvatar: avatarInitial("Alice"),
      content: "old",
      createdAt: "2026-01-01",
    }])
    await act(async () => { await (latest.search as (query: string) => Promise<void>)("") })
    expect(latest.searchResults).toEqual([])
  })

  it("forwards complete accept input, run-helper wiring, and helper-owned reply clearing", async () => {
    const reply = { id: "r1", authorName: "Alice", text: "reply" }
    const attachments = [{ file: {} as File }]
    act(() => {
      TestRenderer.create(React.createElement(Probe, {
        value: props({ forumParentChannelId: "forum_1" }),
      }))
    })
    act(() => latest.setReplyTo(reply))

    let accepted = false
    act(() => { accepted = latest.acceptMessage("hello", attachments, "everyone") })
    expect(accepted).toBe(true)
    expect(mocks.accept).toHaveBeenCalledWith({
      markdown: "hello",
      attachments,
      mentionType: "everyone",
      messageScope: { kind: "channel", id: "channel_1", serverId: "server_1" },
      viewer: { id: "viewer_1", name: "Viewer", avatar: "V" },
      replyTo: reply,
      runAcceptedIntent: expect.any(Function),
      channelId: "channel_1",
      clearReply: expect.any(Function),
    })
    const input = mocks.accept.mock.calls.at(-1)?.[0] as {
      clearReply: () => void
      runAcceptedIntent: (nonce: string) => Promise<void>
    }
    await act(async () => input.runAcceptedIntent("nonce_1"))
    expect(mocks.run).toHaveBeenCalledWith({
      messageScope: { kind: "channel", id: "channel_1", serverId: "server_1" },
      nonce: "nonce_1",
      uploadFileAsync: mocks.uploadMutation,
      sendMessageAsync: mocks.sendMutation,
      channelId: "channel_1",
      forumParentChannelId: "forum_1",
      serverId: "server_1",
      viewer: { id: "viewer_1", name: "Viewer", avatar: "V" },
    })
    act(() => input.clearReply())
    expect(latest.replyTo).toBeNull()
  })

  it("preserves pending/context/seq navigation and UI handler cleanup", () => {
    mocks.seq = "7"
    const navigate = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe, {
        value: props({ uiHandlers: { navigate } }),
      }))
    })
    expect(latest.contextTarget).toEqual({
      serverId: "server_1", channelId: "channel_1", label: "general", seq: 7,
    })
    expect(mocks.router.replace).toHaveBeenCalledWith(
      "/c/channels/server_1/channel_1", { scroll: false },
    )
    expect(mocks.storeState.registerUiHandlers).toHaveBeenCalledWith({
      jumpToSeq: expect.any(Function), openMessageContext: expect.any(Function),
    })

    act(() => latest.setContextTarget({
      serverId: "server_2", channelId: "channel_2", label: "other", seq: 2,
    }))
    act(() => latest.onSheetReply({ id: "r1", authorName: "Alice", text: "reply" }))
    expect(mocks.storeState.setPendingReply).toHaveBeenCalledWith({
      channelId: "channel_2",
      target: { id: "r1", authorName: "Alice", text: "reply" },
    })
    expect(navigate).toHaveBeenCalledWith("server_2", "channel_2")
    act(() => renderer!.unmount())
    expect(mocks.storeState.registerUiHandlers).toHaveBeenLastCalledWith({
      jumpToSeq: undefined, openMessageContext: undefined,
    })
  })

  it("clears missing anchors only on authoritative error and consumes only the matching target", () => {
    const missingFeed = { ...feed, messages: [], isError: false }
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe, {
        value: props({ feed: missingFeed, anchorMessageId: "missing" }),
      }))
    })
    expect(latest.scrollTargetId).toBe("missing")
    act(() => {
      renderer!.update(React.createElement(Probe, {
        value: props({ feed: { ...missingFeed, isError: true }, anchorMessageId: "missing" }),
      }))
    })
    expect(latest.scrollTargetId).toBeNull()
    act(() => renderer!.unmount())

    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe, { value: props() }))
    })
    act(() => latest.consumeScrollTarget("other"))
    expect(latest.scrollTargetId).toBe("m1")
    act(() => latest.consumeScrollTarget("m1"))
    expect(latest.scrollTargetId).toBeNull()
  })

  it("maps search avatars, reports failures, and retains the current unguarded completion race", async () => {
    const failure = new Error("search down")
    mocks.apiFetch
      .mockResolvedValueOnce({
        results: [
          {
            message: { id: "m2", content: "found", authorId: "u2", createdAt: "2026-01-02" },
            author: { name: "Bob", image: null },
          },
          {
            message: { id: "m3", content: "image", authorId: "u3", createdAt: "2026-01-03" },
            author: { name: "Carol", image: "https://example.test/carol.png" },
          },
        ],
      })
      .mockRejectedValueOnce(failure)
    act(() => { TestRenderer.create(React.createElement(Probe, { value: props() })) })
    await act(async () => { await (latest.search as (query: string) => Promise<void>)("found") })
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      "/api/community/messages/search?q=found&channelId=channel_1",
    )
    expect(latest.searchResults).toEqual([
      {
        id: "m2",
        type: "chat",
        authorName: "Bob",
        authorAvatar: avatarInitial("Bob"),
        content: "found",
        createdAt: "2026-01-02",
      },
      {
        id: "m3",
        type: "chat",
        authorName: "Carol",
        authorAvatar: "https://example.test/carol.png",
        content: "image",
        createdAt: "2026-01-03",
      },
    ])
    await act(async () => { await (latest.search as (query: string) => Promise<void>)("broken") })
    expect(latest.searchResults).toEqual([])
    expect(mocks.toastApiError).toHaveBeenCalledWith(failure, "Search failed")
  })

  it("handles same-channel and pending replies plus loaded/fallback seq jumps", () => {
    const pendingTarget = { id: "pending", authorName: "Pending", text: "reply" }
    mocks.storeState.pendingReply = { channelId: "channel_1", target: pendingTarget }
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe, { value: props() }))
    })
    expect(latest.replyTo).toEqual(pendingTarget)
    expect(mocks.storeState.setPendingReply).toHaveBeenCalledWith(null)

    act(() => latest.setContextTarget({
      serverId: "server_1", channelId: "channel_1", label: "general", seq: 1,
    }))
    const localTarget = { id: "local", authorName: "Local", text: "same" }
    act(() => latest.onSheetReply(localTarget))
    expect(latest.replyTo).toEqual(localTarget)
    expect(latest.contextTarget).toBeNull()

    act(() => latest.setScrollTargetId(null))
    act(() => latest.jumpToSeq(1))
    expect(latest.scrollTargetId).toBe("m1")
    act(() => latest.jumpToSeq(99))
    expect(latest.contextTarget).toEqual({
      serverId: "server_1", channelId: "channel_1", label: "general", seq: 99,
    })
    act(() => latest.openContextSeq(100))
    expect(latest.contextTarget?.seq).toBe(100)
    act(() => latest.setContextTarget(null))
    act(() => latest.openContextSeq(2))
    expect(latest.contextTarget).toEqual({
      serverId: "server_1", channelId: "channel_1", label: "general", seq: 2,
    })
    act(() => renderer!.unmount())
  })

  it("publishes the latest action context in layout before descendant passive actions", () => {
    mocks.createActions.mockImplementation((input) => {
      const { actionContext } = input as {
        actionContext: { current: { onOpenThread: (threadId: string) => void } }
      }
      return {
        ...mocks.messageActions,
        onReply: () => actionContext.current.onOpenThread("from-passive"),
      }
    })
    const first = vi.fn()
    const second = vi.fn()
    const valueProps = props({ onOpenThread: first })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(PassiveActionProbe, { value: valueProps }))
    })
    expect(first).toHaveBeenCalledWith("from-passive")
    const firstActions = latest.messageActions
    act(() => {
      renderer!.update(React.createElement(PassiveActionProbe, {
        value: { ...valueProps, onOpenThread: second },
      }))
    })
    expect(second).toHaveBeenCalledWith("from-passive")
    expect(latest.messageActions).toBe(firstActions)
  })

  it("ignores non-finite seq params and projects the exact public value surface", () => {
    mocks.seq = "not-a-number"
    mocks.typingIds = ["u1", "u2"]
    mocks.typingNames = { u1: "Alice" }
    const resolveUserName = vi.fn((id: string) => `resolved:${id}`)
    const projectedFeed = { ...feed, pinned: [{ ...feed.messages[0], id: "p1" }] }
    act(() => {
      TestRenderer.create(React.createElement(Probe, {
        value: props({
          feed: projectedFeed,
          resolveUserName,
        }),
      }))
    })
    expect(mocks.router.replace).not.toHaveBeenCalled()
    expect(latest.contextTarget).toBeNull()
    expect(latest.pinnedIds).toEqual(new Set(["p1"]))
    expect(latest.typingUsers).toEqual(["Alice", "resolved:u2"])
    expect(latest.feed).toBe(projectedFeed)
    expect(resolveUserName).toHaveBeenCalledWith("u2")
    expect(Object.keys(latest)).toEqual([
      "feed", "pinnedIds", "replyTo", "setReplyTo", "searchQuery", "searchResults",
      "search", "scrollTargetId", "setScrollTargetId", "consumeScrollTarget",
      "contextTarget", "setContextTarget", "openContextSeq", "onSheetReply", "jumpToSeq",
      "messageActions", "threadActions", "acceptMessage", "handleTyping", "typingUsers",
    ])
    const actionKeys = [
      "onToggleReaction", "onReact", "onReply", "onPin", "onMark", "onCreateThread",
      "onCopy", "onEdit", "onRetry", "onDismiss", "onPreviewImage",
      "onPreviewAttachment", "onDownloadFile",
    ]
    expect(Object.keys(latest.messageActions)).toEqual(actionKeys)
    expect(Object.keys(latest.threadActions)).toEqual(actionKeys)
    expect(latest.threadActions.onCreateThread).toBeUndefined()
  })
})
