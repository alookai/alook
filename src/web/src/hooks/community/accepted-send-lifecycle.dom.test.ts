import { createElement, type PropsWithChildren } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner, canonicalMessageReader, getMessageStreamState } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { useDmMessageSender, type DmSendReceipt } from "./use-dm-message-sender"
import { useCommunityViewSource } from "./use-community-view-source"
import { useSendMessage } from "./mutations/messages"
import { useUploadFile } from "./mutations/uploads"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import { runAcceptedMessageIntent } from "@/components/community/messages/message-channel-controller-send"
import { Message } from "@/components/community/messages/message"
import { materializeMessageStream } from "@/lib/community/message-stream"

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const author = { id: "u_me", name: "Me", avatar: "M" }
const posted = { message: { id: "confirmed", seq: 12, type: "chat", content: "hello", authorId: "u_me", authorName: "Me", createdAt: "2026-10-09T01:00:00Z", embeds: [] } }
afterEach(() => vi.unstubAllGlobals())

describe("accepted IO survives real view retirement", () => {
  it.each(["channel", "dm"] as const)("%s: original target completes through all four leave phases", async kind => {
    for (const phase of ["preparation", "upload", "post", "decode"] as const) {
      const owner = await createCommunityQueryOwner("u_me")
      owner.runtime.ws.actions.rememberChannelAccess(kind === "dm" ? null : "server", "scope", kind === "dm" ? null : "parent")
      const scope = kind === "dm" ? { kind, id: "scope" } : { kind, id: "scope", serverId: "server" }
      const gate = deferred<Response>(), decode = deferred<void>()
      const response = new Response(JSON.stringify(posted), { status: 201 })
      const json = vi.spyOn(response, "json").mockImplementation(async () => { await decode.promise; return posted })
      const fetchMock = vi.fn(async (path: string) => {
        if (path.endsWith("/attachments")) return gate.promise
        if (phase === "post") return gate.promise
        return response
      })
      vi.stubGlobal("fetch", fetchMock)
      const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "u_me", retainOwner: true }, children)
      const view = renderHook(() => ({ dm: useDmMessageSender(), source: useCommunityViewSource("channel-send"), send: useSendMessage(), upload: useUploadFile() }), { wrapper })
      let committed!: Promise<unknown>
      act(() => {
        const attachments = phase === "upload" ? [{ file: new File(["x"], "x.txt"), previewObjectUrl: "blob:x" }] : undefined
        if (kind === "dm") {
          const receipt: DmSendReceipt = view.result.current.dm.accept({ dmId: scope.id, author, content: "hello", nonce: "nonce", attachments })
          if (!receipt.accepted) throw new Error("Intent rejected")
          committed = receipt.committed
        } else {
          const assertActive = view.result.current.source.capture(), token = captureCommunityLiveSnapshotToken(owner.client, scope.id)
          const assertCommand = () => assertCommunityLiveSnapshotTokenCurrent(owner.client, token, undefined)
          assertActive(); assertCommand()
          owner.runtime.messageStream.actions.accept(scope, { nonce: "nonce", tempId: "temp", message: { type: "chat", content: "hello", authorId: author.id }, localUploads: attachments?.map(a => ({ ...a })) ?? [] })
          committed = runAcceptedMessageIntent({ runtime: owner.runtime, messageScope: { kind: "channel", id: "scope", serverId: "server" }, nonce: "nonce", assertActive, assertCommand, uploadFileAsync: view.result.current.upload.mutateAsync, sendMessageAsync: view.result.current.send.mutateAsync, channelId: "scope", serverId: "server", viewer: author })
        }
        if (phase === "preparation") view.unmount()
      })
      if (phase === "decode") await waitFor(() => expect(json).toHaveBeenCalledOnce())
      else if (phase !== "preparation") await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
      if (phase !== "preparation") view.unmount()
      owner.runtime.ws.actions.beginChannelMembershipChange("other-server", "other-channel")
      await act(async () => {
        gate.resolve(phase === "upload" ? new Response(JSON.stringify({ id: "attachment", filename: "x.txt", contentType: "text/plain", size: 1 }), { status: 201 }) : new Response(JSON.stringify(posted), { status: 201 }))
        decode.resolve()
        await committed
      })
      expect(owner.registry.collections.messages.get("confirmed")).toMatchObject({ channelId: "scope", authorId: "u_me", clientNonce: "nonce" })
      for (const [, options] of fetchMock.mock.calls as unknown as [string, RequestInit][]) expect(options.signal?.aborted).toBe(false)
      const base = [{ id: "confirmed", seq: 12, clientNonce: "nonce", authorId: "u_me", type: "chat" as const, content: "hello" }]
      owner.runtime.messageStream.actions.dispatch(scope, { type: "baseChanged", messages: base })
      const rows = materializeMessageStream(base, getMessageStreamState(owner.client, scope), canonicalMessageReader(owner.client))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ id: "confirmed" })
      expect(rows[0].failed).not.toBe(true)
      const returned = render(createElement(Message, { m: { ...rows[0], grouped: false }, onOpenThread: () => {}, onCopy: () => {} }), { wrapper })
      expect(returned.container.textContent).not.toContain("Message failed to send. Click to retry.")
      returned.unmount()
      await owner.registry.cleanup(); owner.client.clear()
    }
  })
  it.each(["owner", "permission"] as const)("DM upload cannot POST after original %s retires", async retirement => {
    const owner = await createCommunityQueryOwner("u_me"), upload = deferred<Response>()
    owner.runtime.ws.actions.rememberChannelAccess(null, "scope", null)
    const fetchMock = vi.fn(() => upload.promise)
    vi.stubGlobal("fetch", fetchMock)
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "u_me", retainOwner: true }, children)
    const view = renderHook(() => useDmMessageSender(), { wrapper })
    let receipt!: DmSendReceipt
    act(() => { receipt = view.result.current.accept({ dmId: "scope", author, content: "hello", attachments: [{ file: new File(["x"], "x.txt"), previewObjectUrl: "blob:x" }] }) })
    if (!receipt.accepted) throw new Error("Intent rejected")
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    act(() => {
      if (retirement === "owner") owner.runtime.lifecycle.setState(state => ({ ...state, active: false, generation: state.generation + 1 }))
      else owner.runtime.ws.actions.revokeChannelAccess(null, "scope")
    })
    await act(async () => { upload.resolve(new Response(JSON.stringify({ id: "attachment", filename: "x.txt", contentType: "text/plain", size: 1 }), { status: 201 })); if (receipt.accepted) await receipt.committed })
    expect(await receipt.committed).toMatchObject({ ok: false, error: expect.any(Error) })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(owner.registry.collections.messages.get("confirmed")).toBeUndefined()
    view.unmount()
  })
})
