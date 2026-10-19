import React from "react"
import { act } from "@/test/react-dom-harness"
import { render as renderDom } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { ingestMessages } from "@/lib/community-db/sync"
let fixtureOwner: Awaited<ReturnType<typeof createCommunityQueryOwner>>
const rtlRender: typeof renderDom = (node, options) => renderDom(node, { ...options, wrapper: ({ children }) => React.createElement(CommunityTestProvider, { client: fixtureOwner.client, registry: fixtureOwner.registry, userId: "viewer_1", retainOwner: true }, children) })
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useMessageChannelController } from "./message-channel-controller-state"
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
    onPreviewAttachment: vi.fn(),
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
    pathname: "/c/channels/server_1/channel_1",
    seq: null as string | null,
    sendMutation: vi.fn(),
    reactionMutation: vi.fn(),
    addReactionMutation: vi.fn(),
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
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(
    mocks.seq ? `seq=${mocks.seq}&keep=1` : "",
  ),
}))
vi.mock("@/lib/api/client", () => ({
  apiFetch: mocks.apiFetch,
  toastApiError: mocks.toastApiError,
}))
vi.mock("@/stores/community", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/community")>();
  const useCommunityStore = Object.assign(
    (selector: (state: typeof mocks.storeState) => unknown) => {
      mocks.order.push("pending-store")
      return selector(mocks.storeState)
    },
    { getState: () => mocks.storeState },
  )
  return {
    ...actual,
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
  useAddReactionApi: () => { mocks.order.push("reaction-add"); return mocks.addReactionMutation },
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
  React.useLayoutEffect(() => { ingestMessages(fixtureOwner.registry, value.channelId, value.feed.messages) }, [value.channelId, value.feed.messages])
  const controller = useMessageChannelController(value)
  React.useLayoutEffect(() => { latest = controller }, [controller])
  return null
}

function PassiveActionProbe({
  value,
}: {
  value: Omit<MessageChannelControllerProps, "children">
}) {
  React.useLayoutEffect(() => { ingestMessages(fixtureOwner.registry, value.channelId, value.feed.messages) }, [value.channelId, value.feed.messages])
  const controller = useMessageChannelController(value)
  React.useLayoutEffect(() => { latest = controller }, [controller])
  React.useEffect(() => { controller.messageActions.onReply("probe") })
  return null
}

describe("useMessageChannelController", () => {
  beforeEach(async () => {
    fixtureOwner = await createCommunityQueryOwner("viewer_1")
    mocks.storeState.setPendingReply = vi.spyOn(fixtureOwner.registry.runtime.ui.actions, "setPendingReply")
    vi.clearAllMocks()
    mocks.order.length = 0
    mocks.pathname = "/c/channels/server_1/channel_1"
    mocks.seq = null
    mocks.storeState.pendingReply = null
    mocks.apiFetch.mockResolvedValue({ results: [] })
    mocks.accept.mockReturnValue(true)
    mocks.createActions.mockImplementation(() => mocks.messageActions)
    mocks.typingScopes.users.length = 0
    mocks.typingScopes.names.length = 0
    mocks.typingIds = ["u1"]
    mocks.typingNames = { u1: "Alice" }
  })
  afterEach(() => vi.clearAllMocks())

  it("preserves mutation/selector hook order and final-value identity churn", async () => {
    const valueProps = props()
    let renderer: ReturnType<typeof rtlRender>
    act(() => { renderer = rtlRender(React.createElement(Probe, { value: valueProps })) })
    expect(mocks.order.slice(0, 12)).toEqual([
      "send", "reaction", "reaction-add", "pin", "unpin", "mark", "edit", "thread", "upload",
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
    act(() => { renderer!.rerender(React.createElement(Probe, { value: valueProps })) })
    expect(latest).toBe(firstValue)
    expect(latest.threadActions).toBe(firstThreadActions)
    expect(latest.handleTyping).toBe(firstTyping)
    expect(latest.feed).toBe(valueProps.feed)

    const updatedFeed = { ...feed, messages: [...feed.messages] }
    act(() => {
      renderer!.rerender(React.createElement(Probe, {
        value: { ...valueProps, feed: updatedFeed },
      }))
    })
    expect(latest).not.toBe(firstValue)
    expect(latest.messageActions).toBe(firstActions)
    expect(latest.threadActions).not.toBe(firstThreadActions)
    expect(latest.handleTyping).not.toBe(firstTyping)
    expect(latest.feed).toBe(updatedFeed)

    const afterFeed = latest
    const latestOpenThread = vi.fn()
    act(() => {
      renderer!.rerender(React.createElement(Probe, {
        value: { ...valueProps, feed: updatedFeed, onOpenThread: latestOpenThread },
      }))
    })
    expect(latest).toBe(afterFeed)
    expect(latest.messageActions).toBe(firstActions)
  })

  it("keeps the scroll target while clearing reply and context after channel reset", () => {
    let renderer: ReturnType<typeof rtlRender>
    act(() => { renderer = rtlRender(React.createElement(Probe, { value: props() })) })
    act(() => latest.setReplyTo({ id: "r1", authorName: "A", text: "x" }))
    act(() => latest.setContextTarget({ serverId: "server_1", channelId: "channel_1", label: "general", seq: 42 }))
    expect(latest.contextTarget?.seq).toBe(42)
    act(() => { renderer!.rerender(React.createElement(Probe, { value: props({ channelId: "channel_2", channelName: "random" }) })) })
    expect(latest.replyTo).toBeNull()
    expect(latest.contextTarget).toBeNull()
    expect(latest.scrollTargetId).toBe("m1")
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

  it("forwards complete accept input, run-helper wiring, and helper-owned reply clearing", async () => {
    const reply = { id: "r1", authorName: "Alice", text: "reply" }
    const attachments = [{ file: {} as File }]
    act(() => {
      rtlRender(React.createElement(Probe, {
        value: props({ forumParentChannelId: "forum_1" }),
      }))
    })
    act(() => latest.setReplyTo(reply))

    let accepted = false
    act(() => { accepted = latest.acceptMessage("hello", attachments, "everyone") })
    expect(accepted).toBe(true)
    expect(mocks.accept).toHaveBeenCalledWith({
      runtime: fixtureOwner.registry.runtime,
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
      assertActive: expect.any(Function),
      assertCommand: expect.any(Function),
      runtime: fixtureOwner.registry.runtime,
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

  it("publishes one local intent per accepted submission and requests the newest history window", () => {
    const jumpToPresent = vi.fn()
    const view = rtlRender(React.createElement(Probe, {
      value: props({ feed: { ...feed, hasMoreNewer: true, jumpToPresent } }),
    }))
    expect(latest.localSubmitVersion).toBe(0)
    mocks.accept.mockReturnValueOnce(false)
    act(() => { expect(latest.acceptMessage("")).toBe(false) })
    expect(latest.localSubmitVersion).toBe(0)
    expect(jumpToPresent).not.toHaveBeenCalled()
    act(() => { expect(latest.acceptMessage("new text")).toBe(true) })
    expect(latest.localSubmitVersion).toBe(1)
    expect(jumpToPresent).toHaveBeenCalledOnce()
    act(() => { expect(latest.acceptMessage("", [{ file: {} as File }])).toBe(true) })
    expect(latest.localSubmitVersion).toBe(2)
    expect(jumpToPresent).toHaveBeenCalledTimes(2)
    act(() => latest.messageActions.onRetry("failed-nonce"))
    expect(latest.localSubmitVersion).toBe(2)
    view.rerender(React.createElement(Probe, {
      value: props({ feed: { ...feed, hasMoreNewer: false, jumpToPresent } }),
    }))
    act(() => { expect(latest.acceptMessage("at present")).toBe(true) })
    expect(latest.localSubmitVersion).toBe(3)
    expect(jumpToPresent).toHaveBeenCalledTimes(2)
  })

  it("preserves pending/context/seq navigation without claiming global pane handlers", () => {
    mocks.seq = "7"
    const navigate = vi.fn()
    let renderer: ReturnType<typeof rtlRender>
    act(() => {
      renderer = rtlRender(React.createElement(Probe, {
        value: props({ uiHandlers: { navigate } }),
      }))
    })
    expect(latest.contextTarget).toEqual({
      serverId: "server_1", channelId: "channel_1", label: "general", seq: 7,
    })
    expect(mocks.router.replace).toHaveBeenCalledWith(
      "/c/channels/server_1/channel_1?keep=1", { scroll: false },
    )
    expect(mocks.storeState.registerUiHandlers).not.toHaveBeenCalled()

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
    expect(mocks.storeState.registerUiHandlers).not.toHaveBeenCalled()
  })

  it("consumes seq on the current canonical child route and preserves other query state", () => {
    mocks.pathname = "/c/channels/server_1/channel_1"
    mocks.seq = "7"
    act(() => {
      rtlRender(React.createElement(Probe, { value: props() }))
    })

    expect(latest.contextTarget).toEqual({
      serverId: "server_1", channelId: "channel_1", label: "general", seq: 7,
    })
    expect(mocks.router.replace).toHaveBeenCalledWith(
      "/c/channels/server_1/channel_1?keep=1",
      { scroll: false },
    )
  })

  it("gives a split route URL seq only to the child while preserving parent local jumps", () => {
    mocks.pathname = "/c/channels/server_1/child"
    mocks.seq = "7"
    const controllers = new Map<string, MessageChannelControllerValue>()
    function Pane({ channelId }: { channelId: string }) {
      const controller = useMessageChannelController(props({ channelId }))
      React.useLayoutEffect(() => { controllers.set(channelId, controller) }, [channelId, controller])
      return null
    }
    const panes = React.createElement(React.Fragment, null,
      React.createElement(Pane, { channelId: "parent" }),
      React.createElement(Pane, { channelId: "child" }),
    )
    const view = rtlRender(panes)
    expect(controllers.get("parent")!.contextTarget).toBeNull()
    expect(controllers.get("child")!.contextTarget).toMatchObject({ channelId: "child", seq: 7 })
    expect(mocks.router.replace).toHaveBeenCalledOnce()
    expect(mocks.router.replace).toHaveBeenCalledWith("/c/channels/server_1/child?keep=1", { scroll: false })
    mocks.seq = null
    view.rerender(panes)
    act(() => controllers.get("child")!.setContextTarget(null))
    act(() => controllers.get("parent")!.jumpToSeq(99))
    expect(controllers.get("parent")!.contextTarget).toMatchObject({ channelId: "parent", seq: 99 })
    expect(controllers.get("child")!.contextTarget).toBeNull()
    mocks.seq = "7"
    view.rerender(React.createElement(React.Fragment, null,
      React.createElement(Pane, { channelId: "parent" }),
      React.createElement(Pane, { channelId: "child" }),
    ))
    expect(controllers.get("parent")!.contextTarget).toMatchObject({ channelId: "parent", seq: 99 })
    expect(controllers.get("child")!.contextTarget).toMatchObject({ channelId: "child", seq: 7 })
    expect(mocks.router.replace).toHaveBeenCalledTimes(2)
  })

  it("renews a loaded URL target after Close and scroll consumption without a remount", () => {
    mocks.seq = "1"
    const value = props({ anchorMessageId: null })
    const view = rtlRender(React.createElement(Probe, { value }))
    expect(latest.contextTarget).toMatchObject({ channelId: "channel_1", seq: 1 })
    expect(latest.scrollTargetId).toBe("m1")
    mocks.seq = null
    view.rerender(React.createElement(Probe, { value }))
    act(() => { latest.setContextTarget(null); latest.consumeScrollTarget("m1") })
    expect(latest.scrollTargetId).toBeNull()
    mocks.seq = "1"
    view.rerender(React.createElement(Probe, { value }))
    expect(latest.scrollTargetId).toBe("m1")
    expect(latest.contextTarget).toMatchObject({ channelId: "channel_1", seq: 1 })
  })

  it("clears missing anchors only on authoritative error and consumes only the matching target", () => {
    const missingFeed = { ...feed, messages: [], isError: false }
    let renderer: ReturnType<typeof rtlRender>
    act(() => {
      renderer = rtlRender(React.createElement(Probe, {
        value: props({ feed: missingFeed, anchorMessageId: "missing" }),
      }))
    })
    expect(latest.scrollTargetId).toBe("missing")
    act(() => {
      renderer!.rerender(React.createElement(Probe, {
        value: props({ feed: { ...missingFeed, isError: true }, anchorMessageId: "missing" }),
      }))
    })
    expect(latest.scrollTargetId).toBeNull()
    act(() => renderer!.unmount())

    act(() => {
      renderer = rtlRender(React.createElement(Probe, { value: props() }))
    })
    act(() => latest.consumeScrollTarget("other"))
    expect(latest.scrollTargetId).toBe("m1")
    act(() => latest.consumeScrollTarget("m1"))
    expect(latest.scrollTargetId).toBeNull()
  })

  it("handles same-channel and pending replies plus loaded/fallback seq jumps", () => {
    const pendingTarget = { id: "pending", authorId: "pending-author", authorName: "Pending", text: "reply" }
    mocks.storeState.pendingReply = { channelId: "channel_1", target: pendingTarget }
    let renderer: ReturnType<typeof rtlRender>
    act(() => {
      renderer = rtlRender(React.createElement(Probe, { value: props() }))
    })
    expect(latest.replyTo).toEqual(pendingTarget)
    expect(mocks.storeState.setPendingReply).toHaveBeenCalledWith(null)

    act(() => latest.setContextTarget({
      serverId: "server_1", channelId: "channel_1", label: "general", seq: 1,
    }))
    const localTarget = { id: "local", authorId: "local-author", authorName: "Local", text: "same" }
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
        actionContext: { get: () => { onOpenThread: (threadId: string) => void } }
      }
      return {
        ...mocks.messageActions,
        onReply: () => actionContext.get().onOpenThread("from-passive"),
      }
    })
    const first = vi.fn()
    const second = vi.fn()
    const valueProps = props({ onOpenThread: first })
    let renderer: ReturnType<typeof rtlRender>
    act(() => {
      renderer = rtlRender(React.createElement(PassiveActionProbe, { value: valueProps }))
    })
    expect(first).toHaveBeenCalledWith("from-passive")
    const firstActions = latest.messageActions
    act(() => {
      renderer!.rerender(React.createElement(PassiveActionProbe, {
        value: { ...valueProps, onOpenThread: second },
      }))
    })
    expect(second).toHaveBeenCalledWith("from-passive")
    expect(latest.messageActions).toBe(firstActions)
  })

  it("reads only the clicked current canonical or local failed message with current author profiles", () => {
    act(() => { rtlRender(React.createElement(Probe, { value: props() })) })
    const { getMessage } = mocks.createActions.mock.calls[0][0] as Parameters<typeof import("./message-channel-controller-actions").createMessageActions>[0]
    const runtime = fixtureOwner.registry.runtime
    const scope = { kind: "channel" as const, id: "channel_1", serverId: "server_1" }
    act(() => {
      ingestMessages(fixtureOwner.registry, scope.id, [{ id: "m1", seq: 1, type: "chat", content: "current body", authorId: "u1", authorName: "Current Author", authorAvatar: "current.png", authorAvatarVersion: 7 }])
      ingestMessages(fixtureOwner.registry, "other_channel", [{ id: "other", seq: 2, type: "chat", content: "private other" }])
      runtime.messageStream.actions.accept(scope, { nonce: "clicked_failed", tempId: "temp_clicked_failed", message: { type: "chat", authorId: "u1", content: "local body" }, localUploads: [] })
      runtime.messageStream.actions.dispatch(scope, { type: "postFail", nonce: "clicked_failed" })
    })
    expect(getMessage("m1")).toMatchObject({ id: "m1", content: "current body", authorName: "Current Author", authorAvatar: "current.png", authorAvatarVersion: 7 })
    expect(getMessage("temp_clicked_failed")).toMatchObject({ content: "local body", failed: true, clientNonce: "clicked_failed", authorName: "Current Author", authorAvatarVersion: 7 })
    expect(getMessage("other")).toBeUndefined()
    act(() => {
      const confirmed = { id: "confirmed", seq: 3, type: "chat" as const, content: "confirmed body", authorId: "u1", clientNonce: "clicked_failed" }
      ingestMessages(fixtureOwner.registry, scope.id, [confirmed])
      runtime.messageStream.actions.dispatch(scope, { type: "wsMessage", message: confirmed })
    })
    expect(getMessage("temp_clicked_failed")).toBeUndefined()
    expect(getMessage("confirmed")).toMatchObject({ id: "confirmed", content: "confirmed body", authorName: "Current Author", authorAvatarVersion: 7 })
  })

  it("ignores non-finite seq params and projects the exact public value surface", () => {
    mocks.seq = "not-a-number"
    mocks.typingIds = ["u1", "u2"]
    mocks.typingNames = { u1: "Alice" }
    const resolveUserName = vi.fn((id: string) => `resolved:${id}`)
    const projectedFeed = { ...feed, pinned: [{ ...feed.messages[0], id: "p1" }] }
    act(() => {
      rtlRender(React.createElement(Probe, {
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
      "feed", "pinnedIds", "replyTo", "setReplyTo", "scrollTargetId", "setScrollTargetId", "consumeScrollTarget",
      "contextTarget", "setContextTarget", "openContextSeq", "onSheetReply", "jumpToSeq",
      "messageActions", "threadActions", "acceptMessage", "localSubmitVersion", "handleTyping", "typingUsers",
    ])
    const actionKeys = [
      "onToggleReaction", "onReact", "onReply", "onPin", "onMark", "onCreateThread",
      "onCopy", "onEdit", "onRetry", "onDismiss", "onPreviewImage",
      "onPreviewAttachment",
    ]
    expect(Object.keys(latest.messageActions)).toEqual(actionKeys)
    expect(Object.keys(latest.threadActions)).toEqual(actionKeys)
    expect(latest.threadActions.onCreateThread).toBeUndefined()
  })
})
