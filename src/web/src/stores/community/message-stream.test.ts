import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MessageScope } from "@/lib/community/message-stream"
import { getMessageOverlay, useMessageStreamStore } from "./message-stream"

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
    useMessageStreamStore.getState().resetAll()
  })

  it("allocates ordinals atomically and rejects a duplicate nonce", () => {
    const store = useMessageStreamStore.getState()
    expect(store.accept(channel("c1"), acceptedIntent("n1"))).toBe(true)
    expect(useMessageStreamStore.getState().accept(channel("c1"), acceptedIntent("n1"))).toBe(false)
    expect(useMessageStreamStore.getState().accept(channel("c1"), acceptedIntent("n2"))).toBe(true)
    expect([...getMessageOverlay(channel("c1")).outboxByNonce.values()].map((intent) => intent.localOrdinal)).toEqual([1, 2])
  })

  it("cleans one scope, every server scope, and all scopes with one revoke per owned URL", () => {
    const store = useMessageStreamStore.getState()
    store.accept(channel("c1"), acceptedIntent("n1", "blob:1"))
    store.accept(channel("c2"), acceptedIntent("n2", "blob:2"))
    store.accept(channel("c3", "s2"), acceptedIntent("n3", "blob:3"))
    store.removeScope(channel("c1"))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:1")
    expect(getMessageOverlay(channel("c2")).outboxByNonce.size).toBe(1)
    useMessageStreamStore.getState().removeServer("s1")
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:2")
    expect(getMessageOverlay(channel("c3", "s2")).outboxByNonce.size).toBe(1)
    useMessageStreamStore.getState().resetAll()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:3")
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3)
  })

  it("dismisses one failed attachment row by nonce and revokes its owned preview once", () => {
    const store = useMessageStreamStore.getState()
    const messageScope = channel("c1")
    store.accept(messageScope, acceptedIntent("failed", "blob:failed"))
    store.dispatch(messageScope, {
      type: "postFail",
      nonce: "failed",
    })

    expect(getMessageOverlay(messageScope).outboxByNonce.has("failed")).toBe(true)
    store.dispatch(messageScope, { type: "dismissFailed", nonce: "failed" })

    expect(getMessageOverlay(messageScope).outboxByNonce.has("failed")).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:failed")
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it("projects a newer avatar across every active scope and ignores stale versions", () => {
    const store = useMessageStreamStore.getState()
    store.accept(channel("c1"), {
      ...acceptedIntent("n1"),
      message: {
        type: "chat" as const,
        content: "n1",
        authorId: "u1",
        authorAvatar: "/avatar?v=1",
        authorAvatarVersion: 1,
      },
    })
    store.accept(channel("c2"), {
      ...acceptedIntent("n2"),
      message: {
        type: "chat" as const,
        content: "n2",
        authorId: "u1",
        authorAvatar: "/avatar?v=1",
        authorAvatarVersion: 1,
      },
    })

    store.projectAvatarIdentity("u1", "/avatar?v=2", 2)

    expect(getMessageOverlay(channel("c1")).outboxByNonce.get("n1")?.message).toMatchObject({
      authorAvatar: "/avatar?v=2",
      authorAvatarVersion: 2,
    })
    expect(getMessageOverlay(channel("c2")).outboxByNonce.get("n2")?.message).toMatchObject({
      authorAvatar: "/avatar?v=2",
      authorAvatarVersion: 2,
    })
    const entries = useMessageStreamStore.getState().entries
    store.projectAvatarIdentity("u1", "/avatar?v=1", 1)
    expect(useMessageStreamStore.getState().entries).toBe(entries)
  })
})
