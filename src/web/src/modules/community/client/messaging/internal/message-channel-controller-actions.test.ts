import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMessageActions, type MessageActionContext } from "./message-channel-controller-actions"

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  toast: vi.fn(),
  toastApiError: vi.fn(),
  deriveThreadName: vi.fn(() => "derived thread"),
}))

vi.mock("@/stores/community/message-stream", () => ({
  useMessageStreamStore: { getState: () => ({ dispatch: mocks.dispatch }) },
}))
vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("@/lib/api/client", () => ({ toastApiError: mocks.toastApiError }))
vi.mock("@alook/shared", () => ({ deriveThreadName: mocks.deriveThreadName }))

function setup() {
  const setReplyTo = vi.fn()
  const toggleReactionApi = vi.fn()
  const unpinMessageMutate = vi.fn()
  const pinMessageMutate = vi.fn()
  const toggleMark = vi.fn()
  const createThreadAsync = vi.fn(async () => ({ id: "thread_1" }))
  const editMessage = vi.fn()
  const runAcceptedIntent = vi.fn(async () => {})
  const onOpenThread = vi.fn()
  const onOpenPinned = vi.fn()
  const previewImage = vi.fn()
  const previewAttachment = vi.fn()
  const actionContext = { current: {
    messages: [{
      id: "m1",
      seq: 4,
      type: "chat" as const,
      authorId: "viewer_1",
      authorName: "Viewer",
      content: "hello",
      createdAt: new Date(0).toISOString(),
      clientNonce: "nonce_1",
    }],
    pinnedIds: new Set<string>(),
    channelName: "general",
    uiHandlers: { previewImage, previewAttachment },
    onOpenThread,
    onOpenPinned,
  } } as { current: MessageActionContext }
  const actions = createMessageActions({
    actionContext,
    serverId: "server_1",
    channelId: "channel_1",
    viewerUserId: "viewer_1",
    setReplyTo,
    toggleReactionApi,
    unpinMessageMutate,
    pinMessageMutate,
    toggleMark,
    createThreadAsync,
    editMessage,
    messageScope: { kind: "channel", id: "channel_1", serverId: "server_1" },
    runAcceptedIntent,
  })
  return {
    actions,
    actionContext,
    setReplyTo,
    toggleReactionApi,
    unpinMessageMutate,
    pinMessageMutate,
    toggleMark,
    createThreadAsync,
    editMessage,
    runAcceptedIntent,
    onOpenThread,
    onOpenPinned,
    previewImage,
    previewAttachment,
  }
}

describe("createMessageActions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it("routes reply, reactions, marks, previews, retry, dismiss, and download exactly", async () => {
    const harness = setup()
    const link = { href: "", download: "", click: vi.fn() }
    vi.stubGlobal("document", { createElement: vi.fn(() => link) })
    harness.actions.onReply("m1")
    expect(harness.setReplyTo).toHaveBeenCalledWith({ id: "m1", authorName: "Viewer", text: "hello" })
    harness.actions.onReply("missing")
    harness.actionContext.current.messages = [{
      ...harness.actionContext.current.messages[0],
      authorName: undefined,
      content: undefined,
    }]
    harness.actions.onReply("m1")
    expect(harness.setReplyTo).toHaveBeenLastCalledWith({
      id: "m1",
      authorName: "",
      text: "",
    })
    harness.actions.onToggleReaction("m1", "👍")
    harness.actions.onReact("m1", "🔥")
    expect(harness.toggleReactionApi).toHaveBeenNthCalledWith(1, {
      serverId: "server_1", channelId: "channel_1", messageId: "m1", emoji: "👍", userId: "viewer_1",
    })
    expect(harness.toggleReactionApi).toHaveBeenNthCalledWith(2, {
      serverId: "server_1", channelId: "channel_1", messageId: "m1", emoji: "🔥", userId: "viewer_1",
    })
    harness.actions.onMark("m1")
    expect(harness.toggleMark).toHaveBeenCalledWith("channel_1", "m1")
    harness.actions.onPreviewImage({ url: "image" })
    harness.actions.onPreviewAttachment({ id: "a1" } as never)
    expect(harness.previewImage).toHaveBeenCalledWith({ url: "image" })
    expect(harness.previewAttachment).toHaveBeenCalledWith({ id: "a1" })
    harness.actions.onRetry("m1")
    expect(mocks.dispatch).toHaveBeenCalledWith(
      { kind: "channel", id: "channel_1", serverId: "server_1" },
      { type: "retry", nonce: "nonce_1" },
    )
    expect(harness.runAcceptedIntent).toHaveBeenCalledWith("nonce_1")
    harness.actions.onDismiss("m1")
    expect(mocks.dispatch).toHaveBeenCalledWith(
      { kind: "channel", id: "channel_1", serverId: "server_1" },
      { type: "dismissFailed", nonce: "nonce_1" },
    )
    const dispatchCount = mocks.dispatch.mock.calls.length
    harness.actions.onRetry("missing")
    harness.actions.onDismiss("missing")
    harness.actionContext.current.messages = [{
      ...harness.actionContext.current.messages[0],
      clientNonce: undefined,
    }]
    harness.actions.onRetry("m1")
    harness.actions.onDismiss("m1")
    expect(mocks.dispatch).toHaveBeenCalledTimes(dispatchCount)
    expect(harness.runAcceptedIntent).toHaveBeenCalledOnce()
    harness.actions.onDownloadFile("/file", "report.txt")
    expect(link).toEqual(expect.objectContaining({ href: "/file", download: "report.txt" }))
    expect(link.click).toHaveBeenCalledOnce()
  })

  it("preserves pin/unpin, thread, copy, and edit guards and callbacks", async () => {
    const harness = setup()
    harness.actions.onPin("m1")
    expect(harness.pinMessageMutate).toHaveBeenCalled()
    expect(harness.onOpenPinned).toHaveBeenCalledOnce()
    const pinOptions = harness.pinMessageMutate.mock.calls[0][1]
    pinOptions.onSuccess()
    expect(mocks.toast).toHaveBeenCalledWith("Message pinned")
    const pinFailure = new Error("pin failed")
    pinOptions.onError(pinFailure)
    expect(mocks.toastApiError).toHaveBeenCalledWith(pinFailure, "Failed to pin message")

    harness.actionContext.current.pinnedIds = new Set(["m1"])
    harness.actions.onPin("m1")
    expect(harness.unpinMessageMutate).toHaveBeenCalled()
    expect(harness.onOpenPinned).toHaveBeenCalledOnce()
    const unpinOptions = harness.unpinMessageMutate.mock.calls[0][1]
    unpinOptions.onSuccess()
    expect(mocks.toast).toHaveBeenCalledWith("Message unpinned")
    const unpinFailure = new Error("unpin failed")
    unpinOptions.onError(unpinFailure)
    expect(mocks.toastApiError).toHaveBeenCalledWith(unpinFailure, "Failed to unpin message")

    let resolveThread: (value: { id: string }) => void = () => {}
    harness.createThreadAsync.mockImplementationOnce(() => new Promise((resolve) => {
      resolveThread = resolve
    }))
    const pendingThread = harness.actions.onCreateThread("m1")
    expect(mocks.deriveThreadName).toHaveBeenCalledWith("hello", "general")
    expect(harness.createThreadAsync).toHaveBeenCalledWith({
      serverId: "server_1", channelId: "channel_1", messageId: "m1", name: "derived thread",
    })
    const latestOpenThread = vi.fn()
    harness.actionContext.current.onOpenThread = latestOpenThread
    resolveThread({ id: "thread_1" })
    await pendingThread
    expect(harness.onOpenThread).not.toHaveBeenCalled()
    expect(latestOpenThread).toHaveBeenCalledWith("thread_1")
    const threadFailure = new Error("thread failed")
    harness.createThreadAsync.mockRejectedValueOnce(threadFailure)
    await harness.actions.onCreateThread("m1")
    expect(mocks.toastApiError).toHaveBeenCalledWith(threadFailure, "Failed to create thread")
    expect(latestOpenThread).toHaveBeenCalledOnce()

    harness.actions.onCopy("m1")
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello")
    expect(mocks.toast).toHaveBeenCalledWith("Copied to clipboard")
    const copyCount = vi.mocked(navigator.clipboard.writeText).mock.calls.length
    harness.actions.onCopy("missing")
    harness.actionContext.current.messages = [{
      ...harness.actionContext.current.messages[0], content: "",
    }]
    harness.actions.onCopy("m1")
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(copyCount)

    harness.actionContext.current.messages = [{
      ...harness.actionContext.current.messages[0], content: "hello",
    }]

    vi.stubGlobal("window", { prompt: vi.fn(() => "edited") })
    harness.actions.onEdit("m1")
    expect(harness.editMessage).toHaveBeenCalledWith({
      serverId: "server_1", channelId: "channel_1", messageId: "m1", content: "edited",
    }, expect.objectContaining({ onError: expect.any(Function) }))
    const editOptions = harness.editMessage.mock.calls[0][1]
    const editFailure = new Error("edit failed")
    editOptions.onError(editFailure)
    expect(mocks.toastApiError).toHaveBeenCalledWith(editFailure, "Failed to edit message")

    const prompt = vi.mocked(window.prompt)
    prompt.mockReturnValueOnce(null)
    harness.actions.onEdit("m1")
    prompt.mockReturnValueOnce("")
    harness.actions.onEdit("m1")
    prompt.mockReturnValueOnce("hello")
    harness.actions.onEdit("m1")
    expect(harness.editMessage).toHaveBeenCalledOnce()

    harness.actions.onEdit("missing")
    harness.actionContext.current.messages = [{
      ...harness.actionContext.current.messages[0], authorId: "peer_1",
    }]
    harness.actions.onEdit("m1")
    harness.actionContext.current.messages = [{
      ...harness.actionContext.current.messages[0], authorId: "viewer_1", seq: undefined,
    }]
    harness.actions.onEdit("m1")
    harness.actionContext.current.messages = [{
      ...harness.actionContext.current.messages[0], seq: 4, content: "",
    }]
    harness.actions.onEdit("m1")
    expect(harness.editMessage).toHaveBeenCalledOnce()
  })

  it("reads latest context through one stable action object and has no delete action", () => {
    const harness = setup()
    const latestReply = vi.fn()
    harness.actionContext.current.messages = [{
      id: "m2",
      type: "chat",
      authorName: "Latest",
      content: "new",
      createdAt: new Date(1).toISOString(),
    }]
    harness.actionContext.current.onOpenThread = latestReply
    harness.actions.onReply("m2")
    expect(harness.setReplyTo).toHaveBeenCalledWith({ id: "m2", authorName: "Latest", text: "new" })
    expect("onDelete" in harness.actions).toBe(false)
  })
})
