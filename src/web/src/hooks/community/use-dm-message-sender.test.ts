import { beforeEach, describe, expect, it, vi } from "vitest"
import { getMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"
import { materializeMessageStream } from "@/lib/community/message-stream"

vi.mock("react", () => ({
  useCallback: (fn: Function) => fn,
}))

const uploadMock = vi.fn()
const postMock = vi.fn()

vi.mock("@/hooks/community/mutations", () => ({
  sendNonce: () => "fresh_nonce",
  tempMessageId: () => "temp_fresh",
  toAttachmentVm: (channelId: string, attachment: { id: string; filename: string }) => ({
    kind: "file" as const,
    name: attachment.filename,
    url: `/api/community/channels/${channelId}/attachments/${attachment.id}`,
    size: "1 KB",
  }),
  zipUploadResultsWithDimensions: (results: unknown[]) => results.filter(Boolean),
  useUploadFile: () => ({ mutateAsync: uploadMock }),
  useSendDmMessage: () => ({ mutateAsync: postMock }),
}))

vi.mock("@/lib/api/client", () => ({
  toastApiError: vi.fn(),
}))

beforeEach(() => {
  uploadMock.mockReset()
  postMock.mockReset()
  useMessageStreamStore.getState().resetAll()
})

describe("useDmMessageSender", () => {
  it("stages a complete intent synchronously before a POST settles, without Query", async () => {
    let resolvePost!: (value: { message: { id: string; seq: number } }) => void
    postMock.mockReturnValueOnce(new Promise((resolve) => { resolvePost = resolve }))
    const { useDmMessageSender } = await import("./use-dm-message-sender")
    const sender = useDmMessageSender()

    const receipt = sender.accept({
      dmId: "dm_1",
      content: "hello",
      replyTo: { id: "prior", authorName: "Peer", text: "quoted" },
      author: { id: "u_me", name: "Me", avatar: "M" },
    })

    expect(receipt.accepted).toBe(true)
    const intent = getMessageOverlay({ kind: "dm", id: "dm_1" }).outboxByNonce.get("fresh_nonce")
    expect(intent?.message).toEqual(expect.objectContaining({
      authorId: "u_me",
      authorName: "Me",
      content: "hello",
      replyTo: { id: "prior", authorName: "Peer", text: "quoted" },
    }))
    expect(postMock).toHaveBeenCalledWith({
      dmId: "dm_1",
      content: "hello",
      replyToId: "prior",
      attachments: undefined,
      nonce: "fresh_nonce",
    })

    resolvePost({ message: { id: "server_1", seq: 7 } })
    if (!receipt.accepted) throw new Error("expected accepted receipt")
    await expect(receipt.committed).resolves.toEqual({
      ok: true,
      message: { id: "server_1", seq: 7 },
    })
  })

  it("normalizes upload failure, marks the intent failed, and never POSTs", async () => {
    uploadMock.mockRejectedValueOnce(new Error("upload failed"))
    const { useDmMessageSender } = await import("./use-dm-message-sender")
    const sender = useDmMessageSender()
    const file = new File(["x"], "x.txt", { type: "text/plain" })
    const receipt = sender.accept({
      dmId: "dm_1",
      content: "",
      attachments: [{ file, previewObjectUrl: "blob:x" }],
      author: { id: "u_me", name: "Me", avatar: "M" },
    })

    if (!receipt.accepted) throw new Error("expected accepted receipt")
    await expect(receipt.committed).resolves.toEqual({
      ok: false,
      error: expect.any(Error),
    })
    expect(postMock).not.toHaveBeenCalled()
    const intent = getMessageOverlay({ kind: "dm", id: "dm_1" }).outboxByNonce.get("fresh_nonce")
    expect(intent?.uploadStatus).toBe("failed")
    expect(intent?.status).toBe("failed")
  })

  it("retries the same nonce and reports network failure without emitting a terminal event itself", async () => {
    postMock.mockRejectedValueOnce(new Error("offline"))
    const { useDmMessageSender } = await import("./use-dm-message-sender")
    useMessageStreamStore.getState().accept(
      { kind: "dm", id: "dm_1" },
      {
        nonce: "retry_nonce",
        tempId: "temp_retry",
        message: { type: "chat", content: "again" },
        localUploads: [],
      },
    )
    useMessageStreamStore.getState().dispatch(
      { kind: "dm", id: "dm_1" },
      { type: "postFail", nonce: "retry_nonce" },
    )
    const dispatch = vi.spyOn(useMessageStreamStore.getState(), "dispatch")

    const result = await useDmMessageSender().retry("dm_1", "retry_nonce")

    expect(result).toEqual({ ok: false, error: expect.any(Error) })
    expect(postMock).toHaveBeenCalledWith(expect.objectContaining({ nonce: "retry_nonce" }))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(
      { kind: "dm", id: "dm_1" },
      { type: "retry", nonce: "retry_nonce" },
    )
  })

  it("reuses settled remote attachments on retry without uploading twice", async () => {
    uploadMock.mockResolvedValueOnce({
      id: "att_x",
      filename: "x.txt",
      contentType: "text/plain",
      size: 1,
    })
    postMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ message: { id: "server_file", seq: 9 } })
    const { useDmMessageSender } = await import("./use-dm-message-sender")
    const sender = useDmMessageSender()
    const file = new File(["x"], "x.txt", { type: "text/plain" })
    const receipt = sender.accept({
      dmId: "dm_1",
      content: "file",
      attachments: [{ file, previewObjectUrl: "blob:x" }],
      author: { id: "u_me", name: "Me", avatar: "M" },
    })

    if (!receipt.accepted) throw new Error("expected accepted receipt")
    await expect(receipt.committed).resolves.toEqual({ ok: false, error: expect.any(Error) })
    expect(getMessageOverlay({ kind: "dm", id: "dm_1" }).outboxByNonce.get("fresh_nonce")?.uploadStatus).toBe("settled")

    await expect(sender.retry("dm_1", "fresh_nonce")).resolves.toEqual({
      ok: true,
      message: { id: "server_file", seq: 9 },
    })
    expect(uploadMock).toHaveBeenCalledTimes(1)
    expect(postMock).toHaveBeenCalledTimes(2)
    expect(postMock).toHaveBeenNthCalledWith(2, {
      dmId: "dm_1",
      content: "file",
      replyToId: undefined,
      attachments: [{
        id: "att_x",
        filename: "x.txt",
        contentType: "text/plain",
        size: 1,
        width: undefined,
        height: undefined,
      }],
      nonce: "fresh_nonce",
    })
  })

  it("materializes one row after an out-of-view ack and later base arrival", async () => {
    const scope = { kind: "dm" as const, id: "dm_1" }
    postMock.mockImplementationOnce(async (args: { nonce: string }) => {
      useMessageStreamStore.getState().dispatch(scope, {
        type: "postAck",
        nonce: args.nonce,
        serverMessageId: "server_1",
        serverSeq: 11,
      })
      return { message: { id: "server_1", seq: 11 } }
    })
    const { useDmMessageSender } = await import("./use-dm-message-sender")
    const receipt = useDmMessageSender().accept({
      dmId: "dm_1",
      content: "out of view",
      author: { id: "u_me", name: "Me", avatar: "M" },
    })

    if (!receipt.accepted) throw new Error("expected accepted receipt")
    await expect(receipt.committed).resolves.toEqual({
      ok: true,
      message: { id: "server_1", seq: 11 },
    })
    expect(materializeMessageStream([], getMessageOverlay(scope)).map((message) => message.id)).toEqual(["server_1"])

    const base = [{
      id: "server_1",
      seq: 11,
      clientNonce: "fresh_nonce",
      type: "chat" as const,
      authorId: "u_me",
      authorName: "Me",
      content: "out of view",
    }]
    useMessageStreamStore.getState().dispatch(scope, { type: "baseChanged", messages: base })
    expect(materializeMessageStream(base, getMessageOverlay(scope)).map((message) => message.id)).toEqual(["server_1"])
  })
})
