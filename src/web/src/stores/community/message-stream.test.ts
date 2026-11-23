
import { createMessageStreamStore } from "./message-stream"
const nativeStore = createMessageStreamStore()
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MessageScope } from "@/lib/community/message-stream"
import { emptyMessageOverlay } from "@/lib/community/message-stream"
const getMessageOverlay = (scope: MessageScope) => nativeStore.get().entries.get(`${scope.kind}:${scope.id}`)?.state ?? emptyMessageOverlay()

const channel = (id: string, serverId = "s1"): MessageScope => ({ kind: "channel", id, serverId })

function acceptedIntent(nonce: string, previewObjectUrl?: string) {
  return {
    nonce,
    tempId: `temp_${nonce}`,
    message: { type: "chat" as const, content: nonce },
    localUploads: previewObjectUrl
      ? [{ file: { name: `${nonce}.txt` } as File, previewObjectUrl }]
      : [],
  }
}

describe("message stream store", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", { revokeObjectURL: vi.fn() })
    nativeStore.actions.resetAll()
  })

  it("allocates ordinals atomically and rejects a duplicate nonce", () => {
    const store = nativeStore.get()
    expect(nativeStore.actions.accept(channel("c1"), acceptedIntent("n1"))).toBe(true)
    expect(nativeStore.actions.accept(channel("c1"), acceptedIntent("n1"))).toBe(false)
    expect(nativeStore.actions.accept(channel("c1"), acceptedIntent("n2"))).toBe(true)
    expect([...getMessageOverlay(channel("c1")).outboxByNonce.values()].map((intent) => intent.localOrdinal)).toEqual([1, 2])
  })

  it("cleans one scope, every server scope, and all scopes with one revoke per owned URL", () => {
    const store = nativeStore.get()
    nativeStore.actions.accept(channel("c1"), acceptedIntent("n1", "blob:1"))
    nativeStore.actions.accept(channel("c2"), acceptedIntent("n2", "blob:2"))
    nativeStore.actions.accept(channel("c3", "s2"), acceptedIntent("n3", "blob:3"))
    nativeStore.actions.removeScope(channel("c1"))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:1")
    expect(getMessageOverlay(channel("c2")).outboxByNonce.size).toBe(1)
    nativeStore.actions.removeServer("s1")
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:2")
    expect(getMessageOverlay(channel("c3", "s2")).outboxByNonce.size).toBe(1)
    nativeStore.actions.resetAll()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:3")
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3)
  })

  it("dismisses one failed attachment row by nonce and revokes its owned preview once", () => {
    const store = nativeStore.get()
    const messageScope = channel("c1")
    nativeStore.actions.accept(messageScope, acceptedIntent("failed", "blob:failed"))
    nativeStore.actions.dispatch(messageScope, {
      type: "postFail",
      nonce: "failed",
    })

    expect(getMessageOverlay(messageScope).outboxByNonce.has("failed")).toBe(true)
    nativeStore.actions.dispatch(messageScope, { type: "dismissFailed", nonce: "failed" })

    expect(getMessageOverlay(messageScope).outboxByNonce.has("failed")).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:failed")
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })

})
