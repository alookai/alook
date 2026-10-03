import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import type { CommunityRuntime } from "@/stores/community/runtime"
import { acceptChannelMessage, runAcceptedMessageIntent } from "./message-channel-controller-send"

const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  getRetryPayload: vi.fn(),
  dispatch: vi.fn(),
  toastApiError: vi.fn(),
  endTyping: vi.fn(),
  zip: vi.fn(),
  toVm: vi.fn((channelId: string, attachment: { id: string }) => ({
    kind: "file", url: `/api/${channelId}/${attachment.id}`, name: attachment.id, size: 1,
  })),
}))

vi.mock("@/hooks/community/mutations", () => ({
  sendNonce: () => "nonce_1",
  tempMessageId: () => "temp_1",
  toAttachmentVm: mocks.toVm,
  zipUploadResultsWithDimensions: mocks.zip,
}))
vi.mock("@/hooks/community/use-community-ws", () => ({
  communityWsEndTyping: mocks.endTyping,
}))
vi.mock("@/lib/api/client", () => ({ toastApiError: mocks.toastApiError }))

let registry: CommunityDbRegistry, runtime: CommunityRuntime
const scope = { kind: "channel" as const, id: "channel_1", serverId: "server_1" }
const viewer = { id: "viewer_1", name: "Viewer", avatar: "V" }

describe("message channel send helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registry = createCommunityDbRegistry(new QueryClient(), "viewer_1")
    runtime = registry.runtime
    vi.spyOn(runtime.messageStream.actions, "accept").mockImplementation(mocks.accept)
    vi.spyOn(runtime.messageStream.actions, "getRetryPayload").mockImplementation(mocks.getRetryPayload)
    vi.spyOn(runtime.messageStream.actions, "dispatch").mockImplementation(mocks.dispatch)
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"))
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:new"),
      revokeObjectURL: vi.fn(),
    })
  })
  afterEach(async () => {
    await registry.cleanup(); registry.queryClient.clear()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("rejects empty input and revokes only URLs created by a rejected attempt", () => {
    const runner = vi.fn(async () => {})
    const clearReply = vi.fn()
    expect(acceptChannelMessage({
      runtime,
      markdown: "", messageScope: scope, viewer, replyTo: null,
      runAcceptedIntent: runner, channelId: "channel_1", clearReply,
    })).toBe(false)
    expect(mocks.accept).not.toHaveBeenCalled()

    mocks.accept.mockReturnValue(false)
    const created = new File(["a"], "a.txt", { type: "text/plain" })
    const supplied = new File(["b"], "b.txt", { type: "text/plain" })
    expect(acceptChannelMessage({
      runtime,
      markdown: "hello",
      attachments: [
        { file: created },
        { file: supplied, previewObjectUrl: "blob:supplied" },
      ],
      messageScope: scope,
      viewer,
      replyTo: null,
      runAcceptedIntent: runner,
      channelId: "channel_1",
      clearReply,
    })).toBe(false)
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:new")
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:supplied")
    expect(runner).not.toHaveBeenCalled()
    expect(mocks.endTyping).not.toHaveBeenCalled()
    expect(clearReply).not.toHaveBeenCalled()
  })

  it("accepts synchronously with exact optimistic payload before fire-and-forget/reset/clear", () => {
    const order: string[] = []
    const file = new File(["abc"], "a.png", { type: "image/png" })
    const thumbnailBlob = new Blob(["thumb"], { type: "image/jpeg" })
    mocks.accept.mockImplementation((acceptedScope, payload) => {
      order.push("accept")
      expect(acceptedScope).toEqual(scope)
      expect(payload).toEqual({
        nonce: "nonce_1",
        tempId: "temp_1",
        message: {
          type: "chat",
          authorId: "viewer_1",
          authorName: "Viewer",
          authorAvatar: "V",
          content: "@Alice\nhello",
          createdAt: "2026-01-02T03:04:05.000Z",
          replyTo: { id: "reply_1", authorName: "Alice", text: "prior" },
        },
        localUploads: [{
          file,
          thumbnailBlob,
          previewObjectUrl: "blob:new",
          width: 10,
          height: 20,
        }],
        mentionType: "user",
      })
      return true
    })
    const runner = vi.fn(async () => { order.push("run") })
    mocks.endTyping.mockImplementation(() => order.push("typing"))
    const clearReply = vi.fn(() => order.push("clear"))
    expect(acceptChannelMessage({
      runtime,
      markdown: "hello",
      attachments: [{ file, thumbnailBlob, width: 10, height: 20 }],
      mentionType: "user",
      messageScope: scope,
      viewer,
      replyTo: { id: "reply_1", authorName: "Alice", text: "prior" },
      runAcceptedIntent: runner,
      channelId: "channel_1",
      clearReply,
    })).toBe(true)
    expect(runner).toHaveBeenCalledWith("nonce_1")
    expect(mocks.endTyping).toHaveBeenCalledWith(runtime, { channelId: "channel_1" })
    expect(order).toEqual(["accept", "run", "typing", "clear"])
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it("accepts an attachment-only intent with an exact empty-content optimistic payload", () => {
    const file = new File(["abc"], "only.txt", { type: "text/plain" })
    const runner = vi.fn(async () => {})
    const clearReply = vi.fn()
    mocks.accept.mockReturnValue(true)

    expect(acceptChannelMessage({
      runtime,
      markdown: "",
      attachments: [{ file, previewObjectUrl: "blob:provided" }],
      messageScope: scope,
      viewer,
      replyTo: null,
      runAcceptedIntent: runner,
      channelId: "channel_1",
      clearReply,
    })).toBe(true)
    expect(mocks.accept).toHaveBeenCalledWith(scope, {
      nonce: "nonce_1",
      tempId: "temp_1",
      message: {
        type: "chat",
        authorId: "viewer_1",
        authorName: "Viewer",
        authorAvatar: "V",
        content: "",
        createdAt: "2026-01-02T03:04:05.000Z",
      },
      localUploads: [{
        file,
        thumbnailBlob: undefined,
        previewObjectUrl: "blob:provided",
        width: undefined,
        height: undefined,
      }],
      mentionType: undefined,
    })
    expect(runner).toHaveBeenCalledWith("nonce_1")
    expect(mocks.endTyping).toHaveBeenCalledWith(runtime, { channelId: "channel_1" })
    expect(clearReply).toHaveBeenCalledOnce()
  })

  it("stores the canonical author prefix for an attachment-only reply", () => {
    const file = new File(["abc"], "only.txt", { type: "text/plain" })
    mocks.accept.mockReturnValue(true)

    expect(acceptChannelMessage({
      runtime,
      markdown: "",
      attachments: [{ file, previewObjectUrl: "blob:provided" }],
      messageScope: scope,
      viewer,
      replyTo: { id: "reply_1", authorName: "Alice Smith", text: "prior" },
      runAcceptedIntent: vi.fn(async () => {}),
      channelId: "channel_1",
      clearReply: vi.fn(),
    })).toBe(true)

    expect(mocks.accept).toHaveBeenCalledWith(scope, expect.objectContaining({
      message: expect.objectContaining({
        content: "@Alice Smith\n",
        replyTo: { id: "reply_1", authorName: "Alice Smith", text: "prior" },
      }),
    }))
  })

  it("reuses settled projections and dispatches all-or-nothing upload failure without sending", async () => {
    const local = {
      file: new File(["abc"], "a.png", { type: "image/png" }),
      thumbnailBlob: new Blob(["thumb"], { type: "image/jpeg" }),
      previewObjectUrl: "blob:a",
      width: 10,
      height: 20,
    }
    const sendMessageAsync = vi.fn(async () => ({}))
    const uploadFileAsync = vi.fn(async () => ({
      id: "uploaded", filename: "a.png", contentType: "image/png", size: 3,
    }))
    mocks.getRetryPayload.mockReturnValueOnce({
      localUploads: [local],
      uploadStatus: "settled",
      message: {
        content: "hello",
        attachments: [{ kind: "image", url: "/att/existing", thumbnailUrl: "/thumb" }],
      },
      mentionType: "user",
    })
    await runAcceptedMessageIntent({
      runtime,
      messageScope: scope, nonce: "nonce_1", uploadFileAsync, sendMessageAsync,
      channelId: "channel_1", serverId: "server_1", viewer,
    })
    expect(uploadFileAsync).not.toHaveBeenCalled()
    expect(sendMessageAsync).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({
        id: "existing", filename: "a.png", hasThumbnail: true, width: 10, height: 20,
      })],
      nonce: "nonce_1",
    }))

    mocks.getRetryPayload.mockReturnValueOnce({
      localUploads: [local, { ...local, file: new File(["b"], "b.png", { type: "image/png" }) }],
      uploadStatus: "pending",
      message: { content: "again" },
    })
    uploadFileAsync.mockResolvedValueOnce({
      id: "ok", filename: "a.png", contentType: "image/png", size: 3,
    }).mockRejectedValueOnce(new Error("failed"))
    sendMessageAsync.mockClear()
    await runAcceptedMessageIntent({
      runtime,
      messageScope: scope, nonce: "nonce_2", uploadFileAsync, sendMessageAsync,
      channelId: "channel_1", serverId: "server_1", viewer,
    })
    expect(uploadFileAsync).toHaveBeenCalledTimes(2)
    expect(mocks.toastApiError).toHaveBeenCalledWith(expect.any(Error), "Failed to attach file", expect.any(Function))
    expect(mocks.dispatch).toHaveBeenCalledWith(scope, { type: "uploadFailed", nonce: "nonce_2" })
    expect(sendMessageAsync).not.toHaveBeenCalled()
  })

  it("uploads in parallel, zips dimensions, dispatches settled VMs, then sends the exact payload", async () => {
    const order: string[] = []
    const uploads = [
      {
        file: new File(["a"], "a.png", { type: "image/png" }),
        thumbnailBlob: new Blob(["ta"], { type: "image/jpeg" }),
        previewObjectUrl: "blob:a",
        width: 10,
        height: 20,
      },
      {
        file: new File(["bb"], "b.txt", { type: "text/plain" }),
        previewObjectUrl: "blob:b",
        width: undefined,
        height: undefined,
      },
    ]
    const uploaded = [
      { id: "a1", filename: "a.png", contentType: "image/png", size: 1 },
      { id: "a2", filename: "b.txt", contentType: "text/plain", size: 2 },
    ]
    mocks.getRetryPayload.mockReturnValue({
      localUploads: uploads,
      uploadStatus: "pending",
      message: {
        content: "hello",
        replyTo: { id: "reply_1", authorName: "Alice", text: "prior" },
      },
      mentionType: "user",
    })
    const uploadFileAsync = vi.fn(async ({ file }: { file: File }) => {
      order.push(`upload:${file.name}`)
      return file.name === "a.png" ? uploaded[0] : uploaded[1]
    })
    mocks.zip.mockImplementation((results, localUploads) => {
      order.push("zip")
      expect(results).toEqual(uploaded)
      expect(localUploads).toEqual(uploads)
      return uploaded
    })
    mocks.toVm.mockImplementation((channelId: string, attachment: { id: string }) => {
      order.push(`vm:${attachment.id}`)
      return { kind: "file", url: `/api/${channelId}/${attachment.id}`, name: attachment.id, size: 1 }
    })
    mocks.dispatch.mockImplementation(() => { order.push("dispatch") })
    const sendMessageAsync = vi.fn(async () => { order.push("send") })

    await runAcceptedMessageIntent({
      runtime,
      messageScope: scope,
      nonce: "nonce_upload",
      uploadFileAsync,
      sendMessageAsync,
      channelId: "channel_1",
      forumParentChannelId: "forum_1",
      serverId: "server_1",
      viewer,
    })

    expect(uploadFileAsync).toHaveBeenCalledTimes(2)
    expect(uploadFileAsync).toHaveBeenNthCalledWith(1, {
      assertActive: undefined,
      target: { channelId: "channel_1" },
      file: uploads[0].file,
      thumbnailBlob: uploads[0].thumbnailBlob,
      width: 10,
      height: 20,
    })
    expect(uploadFileAsync).toHaveBeenNthCalledWith(2, {
      assertActive: undefined,
      target: { channelId: "channel_1" },
      file: uploads[1].file,
      thumbnailBlob: undefined,
      width: undefined,
      height: undefined,
    })
    expect(mocks.dispatch).toHaveBeenCalledWith(scope, {
      type: "uploadSettled",
      nonce: "nonce_upload",
      attachments: [
        { kind: "file", url: "/api/channel_1/a1", name: "a1", size: 1 },
        { kind: "file", url: "/api/channel_1/a2", name: "a2", size: 1 },
      ],
    })
    expect(sendMessageAsync).toHaveBeenCalledWith({
      assertActive: undefined,
      serverId: "server_1",
      channelId: "channel_1",
      forumParentChannelId: "forum_1",
      content: "hello",
      replyToId: "reply_1",
      mentionType: "user",
      attachments: uploaded,
      nonce: "nonce_upload",
      author: viewer,
    })
    expect(order).toEqual([
      "upload:a.png", "upload:b.txt", "zip", "vm:a1", "vm:a2", "dispatch", "send",
    ])
  })

  it("no-ops without a retry payload and retains stream state when send rejects", async () => {
    const uploadFileAsync = vi.fn()
    const sendMessageAsync = vi.fn()
    mocks.getRetryPayload.mockReturnValueOnce(undefined)
    await runAcceptedMessageIntent({
      runtime,
      messageScope: scope, nonce: "missing", uploadFileAsync, sendMessageAsync,
      channelId: "channel_1", serverId: "server_1", viewer,
    })
    expect(uploadFileAsync).not.toHaveBeenCalled()
    expect(sendMessageAsync).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()

    const failure = new Error("send failed")
    mocks.getRetryPayload.mockReturnValueOnce({
      localUploads: [],
      uploadStatus: "settled",
      message: { content: "keep optimistic" },
    })
    sendMessageAsync.mockRejectedValueOnce(failure)
    await expect(runAcceptedMessageIntent({
      runtime,
      messageScope: scope, nonce: "nonce_failed", uploadFileAsync, sendMessageAsync,
      channelId: "channel_1", serverId: "server_1", viewer,
    })).resolves.toBeUndefined()
    expect(sendMessageAsync).toHaveBeenCalledWith(expect.objectContaining({
      content: "keep optimistic",
      nonce: "nonce_failed",
    }))
    expect(mocks.dispatch).toHaveBeenCalledWith(scope, { type: "postFail", nonce: "nonce_failed" })
    expect(mocks.toastApiError).not.toHaveBeenCalled()
  })

  it("sends the accepted canonical reply bytes unchanged on every retry", async () => {
    const canonicalContent = "@Alice Smith\n> quoted\n\nbody"
    mocks.getRetryPayload.mockReturnValue({
      localUploads: [],
      uploadStatus: "settled",
      message: {
        content: canonicalContent,
        replyTo: { id: "reply_1", authorName: "Alice Smith", text: "prior" },
      },
    })
    const sendMessageAsync = vi.fn(async () => ({}))
    const args = {
      runtime,
      messageScope: scope,
      nonce: "nonce_retry",
      uploadFileAsync: vi.fn(),
      sendMessageAsync,
      channelId: "channel_1",
      serverId: "server_1",
      viewer,
    }

    await runAcceptedMessageIntent(args)
    await runAcceptedMessageIntent(args)

    expect(sendMessageAsync).toHaveBeenCalledTimes(2)
    expect(sendMessageAsync).toHaveBeenNthCalledWith(1, expect.objectContaining({
      content: canonicalContent,
      replyToId: "reply_1",
    }))
    expect(sendMessageAsync).toHaveBeenNthCalledWith(2, expect.objectContaining({
      content: canonicalContent,
      replyToId: "reply_1",
    }))
  })
})
