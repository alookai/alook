import { canonicalMessageReader } from "@/test/community-query-owner"
import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { getMessageStreamState } from "@/test/community-query-owner"
import { materializeMessageStream } from "@/lib/community/message-stream"
import { ingestMessages } from "@/lib/community-db/sync"
import { ApiError } from "@/lib/errors"
import { MESSAGE_PREVIEW_LENGTH } from "@alook/shared"
import { useDmMessageSender, type AcceptDmMessageArgs, type DmSendReceipt } from "./use-dm-message-sender"

const mocks = vi.hoisted(() => ({ api: vi.fn(), upload: vi.fn(), post: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.api, toastApiError: vi.fn() }))
beforeEach(() => {
  mocks.api.mockReset(); mocks.upload.mockReset(); mocks.post.mockReset()
  mocks.api.mockImplementation((path: string, options: { body: string | FormData }) => {
    if (path.endsWith("/attachments")) return mocks.upload(options.body)
    if (path.endsWith("/messages")) return mocks.post(JSON.parse(options.body as string))
    throw new Error(`Unexpected DM IO: ${path}`)
  })
})

const scope = { kind: "dm" as const, id: "dm_1" }
const author = { id: "u_me", name: "Me", avatar: "M" }
function posted(id = "server_1", seq = 7, content = "hello") {
  return { message: { id, seq, content, type: "chat", createdAt: "2026-08-07T10:00:00.000Z", authorId: author.id, authorName: author.name, authorImage: null, authorAvatarVersion: 0, embeds: [] } }
}
async function setup() {
  const owner = await createCommunityQueryOwner("u_me")
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "u_me", retainOwner: true }, children)
  const view = renderHook(() => useDmMessageSender(), { wrapper })
  const accept = (input: Omit<AcceptDmMessageArgs, "dmId" | "author">) => {
    let receipt!: DmSendReceipt
    act(() => { receipt = view.result.current.accept({ dmId: scope.id, author, nonce: "fresh_nonce", ...input }) })
    if (!receipt.accepted) throw new Error("Expected accepted DM intent")
    return receipt
  }
  const retry = async (nonce = "fresh_nonce") => {
    let result!: Awaited<ReturnType<typeof view.result.current.retry>>
    await act(async () => { result = await view.result.current.retry(scope.id, nonce) })
    return result
  }
  const settle = async (receipt: ReturnType<typeof accept>) => {
    let result!: Awaited<typeof receipt.committed>
    await act(async () => { result = await receipt.committed })
    return result
  }
  const overlay = () => getMessageStreamState(owner.client, scope)
  return { ...owner, view, accept, retry, settle, overlay }
}

describe("Native DM sender", () => {
  it("stages the complete intent synchronously before Native POST settles", async () => {
    let resolve!: (value: ReturnType<typeof posted>) => void
    mocks.post.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const owner = await setup()
    const receipt = owner.accept({ content: "@Peer\nhello", replyTo: { id: "prior", authorName: "Peer", text: "quoted" } })
    expect(owner.overlay().outboxByNonce.get("fresh_nonce")?.message).toMatchObject({ authorId: "u_me", authorName: "Me", content: "@Peer\nhello", replyTo: { id: "prior", authorName: "Peer", text: "quoted" } })
    await waitFor(() => expect(mocks.post).toHaveBeenCalledExactlyOnceWith({ content: "@Peer\nhello", replyToId: "prior", nonce: "fresh_nonce" }))
    resolve(posted())
    expect(await owner.settle(receipt)).toMatchObject({ ok: true, message: { id: "server_1", seq: 7 } })
  })

  it("normalizes upload failure, marks the intent failed and never POSTs", async () => {
    mocks.upload.mockRejectedValueOnce(new Error("upload failed"))
    const owner = await setup(), file = new File(["x"], "x.txt", { type: "text/plain" })
    const receipt = owner.accept({ content: "", attachments: [{ file, previewObjectUrl: "blob:x" }] })
    expect(await owner.settle(receipt)).toEqual({ ok: false, error: expect.any(Error) })
    expect(mocks.post).not.toHaveBeenCalled()
    expect(owner.overlay().outboxByNonce.get("fresh_nonce")).toMatchObject({ uploadStatus: "failed", status: "failed" })
  })

  it("retains the identical thumbnail Blob for both Native multipart attempts", async () => {
    const thumbnailBlob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" })
    mocks.upload.mockRejectedValueOnce(new Error("upload failed")).mockResolvedValueOnce({ id: "att_thumb", filename: "photo.png", contentType: "image/png", size: 8, hasThumbnail: true })
    mocks.post.mockResolvedValueOnce(posted("server_thumb", 10, "photo"))
    const owner = await setup(), file = new File(["original"], "photo.png", { type: "image/png" })
    const receipt = owner.accept({ content: "photo", attachments: [{ file, thumbnailBlob, previewObjectUrl: "blob:thumbnail", width: 640, height: 480 }] })
    expect(await owner.settle(receipt)).toEqual({ ok: false, error: expect.any(Error) })
    expect(owner.overlay().outboxByNonce.get("fresh_nonce")?.localUploads[0].thumbnailBlob).toBe(thumbnailBlob)
    expect(await owner.retry()).toMatchObject({ ok: true, message: { id: "server_thumb", seq: 10 } })
    expect(mocks.upload).toHaveBeenCalledTimes(2)
    for (const [body] of mocks.upload.mock.calls) {
      expect(body).toBeInstanceOf(FormData)
      expect(body.get("thumbnail")).toMatchObject({ size: 4, type: "image/jpeg" })
      expect(body.get("width")).toBe("640"); expect(body.get("height")).toBe("480")
    }
  })

  it("retries the same nonce with exactly one terminal failure from the Native mutation", async () => {
    mocks.post.mockRejectedValueOnce(new Error("offline"))
    const owner = await setup()
    act(() => {
      owner.runtime.messageStream.actions.accept(scope, { nonce: "retry_nonce", tempId: "temp_retry", message: { type: "chat", content: "again" }, localUploads: [] })
      owner.runtime.messageStream.actions.dispatch(scope, { type: "postFail", nonce: "retry_nonce" })
    })
    const dispatch = vi.spyOn(owner.runtime.messageStream.actions, "dispatch")
    expect(await owner.retry("retry_nonce")).toEqual({ ok: false, error: expect.any(Error) })
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith({ content: "again", nonce: "retry_nonce" })
    expect(dispatch.mock.calls).toEqual([[scope, { type: "retry", nonce: "retry_nonce" }], [scope, { type: "postFail", nonce: "retry_nonce" }]])
  })

  it("bounds the optimistic reply and preserves its exact preview through retry", async () => {
    mocks.post.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("still offline"))
    const owner = await setup()
    const receipt = owner.accept({ content: "replying", replyTo: { id: "prior", authorName: "Peer", text: "x".repeat(MESSAGE_PREVIEW_LENGTH + 1) } })
    expect(await owner.settle(receipt)).toEqual({ ok: false, error: expect.any(Error) })
    const expected = `${"x".repeat(MESSAGE_PREVIEW_LENGTH - 1)}…`
    expect(owner.overlay().outboxByNonce.get("fresh_nonce")?.message).toMatchObject({ content: "@Peer\nreplying", replyTo: { text: expected } })
    expect(await owner.retry()).toEqual({ ok: false, error: expect.any(Error) })
    expect(owner.overlay().outboxByNonce.get("fresh_nonce")?.message.replyTo?.text).toBe(expected)
    expect(mocks.post.mock.calls.map(([body]) => body)).toEqual(Array(2).fill({ content: "@Peer\nreplying", replyToId: "prior", nonce: "fresh_nonce" }))
  })

  it("sends a canonical prefix for an attachment-only DM reply", async () => {
    mocks.upload.mockResolvedValueOnce({ id: "att_x", filename: "x.txt", contentType: "text/plain", size: 1 })
    mocks.post.mockResolvedValueOnce(posted("server_file", 9, "@Peer Name\n"))
    const owner = await setup(), file = new File(["x"], "x.txt", { type: "text/plain" })
    const receipt = owner.accept({ content: "", replyTo: { id: "prior", authorName: "Peer Name", text: "quoted" }, attachments: [{ file, previewObjectUrl: "blob:x" }] })
    expect(await owner.settle(receipt)).toMatchObject({ ok: true, message: { id: "server_file", seq: 9 } })
    expect(materializeMessageStream([], owner.overlay(), canonicalMessageReader(owner.client)).find(({ id }) => id === "server_file")?.content).toBe("@Peer Name\n")
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith({ content: "@Peer Name\n", replyToId: "prior", attachments: ["att_x"], nonce: "fresh_nonce" })
  })

  it("reuses settled remote attachments on retry without a second upload", async () => {
    mocks.upload.mockResolvedValueOnce({ id: "att_x", filename: "x.txt", contentType: "text/plain", size: 1 })
    mocks.post.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(posted("server_file", 9, "file"))
    const owner = await setup(), file = new File(["x"], "x.txt", { type: "text/plain" })
    const receipt = owner.accept({ content: "file", attachments: [{ file, previewObjectUrl: "blob:x" }] })
    expect(await owner.settle(receipt)).toEqual({ ok: false, error: expect.any(Error) })
    expect(owner.overlay().outboxByNonce.get("fresh_nonce")?.uploadStatus).toBe("settled")
    expect(await owner.retry()).toMatchObject({ ok: true, message: { id: "server_file", seq: 9 } })
    expect(mocks.upload).toHaveBeenCalledOnce()
    expect(mocks.post.mock.calls.map(([body]) => body)).toEqual(Array(2).fill({ content: "file", attachments: ["att_x"], nonce: "fresh_nonce" }))
  })

  it("materializes one row after an out-of-view ACK and later base arrival", async () => {
    mocks.post.mockResolvedValueOnce(posted("server_1", 11, "out of view"))
    const owner = await setup()
    act(() => owner.runtime.ui.actions.setCurrentChannelId("other_dm"))
    const receipt = owner.accept({ content: "out of view" })
    expect(await owner.settle(receipt)).toMatchObject({ ok: true, message: { id: "server_1", seq: 11 } })
    expect(materializeMessageStream([], owner.overlay(), canonicalMessageReader(owner.client)).map(({ id }) => id)).toEqual(["server_1"])
    const base = [{ id: "server_1", seq: 11, clientNonce: "fresh_nonce", type: "chat" as const, authorId: "u_me", authorName: "Me", content: "out of view" }]
    act(() => owner.runtime.messageStream.actions.dispatch(scope, { type: "baseChanged", messages: base }))
    expect(materializeMessageStream(base, owner.overlay(), canonicalMessageReader(owner.client)).map(({ id }) => id)).toEqual(["server_1"])
  })
})


describe("confirmed native DM receipt", () => {
  const confirmed = { id: "server_confirmed", seq: 17, type: "chat" as const, content: "hello", authorId: "u_me", clientNonce: "fresh_nonce" }
  it.each(["ordinary", 0, 500, 503])("returns the canonical receipt after a late %s while Native POST stays rejected", async (status) => {
    const owner = await setup()
    mocks.post.mockImplementationOnce(async () => { ingestMessages(owner.registry, scope.id, [confirmed]); throw status === "ordinary" ? new Error("late failure") : new ApiError("late failure", Number(status)) })
    const receipt = owner.accept({ content: "hello" })
    expect(await owner.settle(receipt)).toEqual({ ok: true, message: { id: "server_confirmed", seq: 17 } })
    expect(owner.overlay().outboxByNonce.size).toBe(0)
    const { awaitCommittedInvite } = await import("@/components/community/social/invite-dialog")
    const onCommitted = vi.fn()
    await awaitCommittedInvite(receipt, onCommitted)
    expect(onCommitted).toHaveBeenCalledOnce()
  })
  it.each([403, 429])("keeps explicit %s as a failed receipt with a matching canonical row", async (status) => {
    const owner = await setup()
    ingestMessages(owner.registry, scope.id, [confirmed])
    mocks.post.mockRejectedValueOnce(new ApiError("rejected", status))
    expect(await owner.settle(owner.accept({ content: "hello" }))).toMatchObject({ ok: false, error: expect.any(Error) })
  })
  it.each(["abort", "view", "owner"])("keeps the DM receipt failed after %s with matching confirmation", async (mode) => {
    const owner = await setup()
    let current = true
    const assertActive = Object.assign(() => { if (!current) throw new DOMException("retired view", "AbortError") }, { signal: new AbortController().signal })
    mocks.post.mockImplementationOnce(async () => {
      ingestMessages(owner.registry, scope.id, [confirmed])
      if (mode === "view") current = false
      if (mode === "owner") owner.runtime.lifecycle.setState(state => ({ ...state, active: false, generation: state.generation + 1 }))
      throw mode === "abort" ? new DOMException("cancelled", "AbortError") : new Error("late failure")
    })
    expect(await owner.settle(owner.accept({ content: "hello", assertActive }))).toMatchObject(mode === "view" ? { ok: true, message: { id: "server_confirmed", seq: 17 } } : { ok: false, error: expect.any(Error) })
  })
  it("does not recover an upload failure from a matching canonical row", async () => {
    const owner = await setup()
    ingestMessages(owner.registry, scope.id, [confirmed])
    mocks.upload.mockRejectedValueOnce(new ApiError("upload 503", 503))
    const receipt = owner.accept({ content: "hello", attachments: [{ file: new File(["x"], "x.txt"), previewObjectUrl: "blob:x" }] })
    expect(await owner.settle(receipt)).toMatchObject({ ok: false, error: expect.any(Error) })
    expect(mocks.post).not.toHaveBeenCalled()
  })
})
