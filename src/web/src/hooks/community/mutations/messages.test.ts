/**
 * Mutation-hook tests for message-scoped operations.
 *
 * The vitest environment is node (no jsdom / react rendering). We drive the
 * hook body by mocking `useMutation` + `useQueryClient` so we can capture
 * the config object and invoke `onMutate` → `mutationFn` → `onSuccess`/
 * `onError` manually. Same qc is used for cache assertions before/after each
 * step.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { Msg } from "@/lib/community/models/message"

// ── React shim (mirrors use-community-ws.test.ts) ────────────────────────
let refs: Map<string, { current: unknown }> = new Map()
let refCounter = 0
let callbackMemo: Map<string, { fn: Function; deps: unknown[] }> = new Map()
let callbackCounter = 0

vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const id = `ref-${refCounter++}`
    if (!refs.has(id)) refs.set(id, { current: initial })
    return refs.get(id)!
  },
  useCallback: (fn: Function, deps: unknown[]) => {
    const id = `cb-${callbackCounter++}`
    const existing = callbackMemo.get(id)
    if (existing && JSON.stringify(existing.deps) === JSON.stringify(deps)) {
      return existing.fn
    }
    callbackMemo.set(id, { fn, deps })
    return fn
  },
  useEffect: () => { },
  useState: (initial: unknown) => [initial, () => { }],
}))

const apiFetchMock = vi.fn()

// Sonner toast — we assert on the string arg for the blocked-DM test.
const toastMock = vi.fn()

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  // Mirrors the real `toastApiError` (ApiError/Error message, else fallback)
  // while routing through the same `toastMock` sonner assertions below use.
  toastApiError: (err: unknown, fallback: string) => {
    const msg = err instanceof Error && err.message ? err.message : fallback
    toastMock(msg)
  },
}))

vi.mock("sonner", () => ({
  toast: Object.assign((...args: unknown[]) => toastMock(...args), {
    error: (...args: unknown[]) => toastMock(...args),
    success: (...args: unknown[]) => toastMock(...args),
  }),
}))

// Captured mutation config the mocked `useMutation` returns.
type MutConfig<Args, Ctx> = {
  mutationFn?: (args: Args) => unknown
  onMutate?: (args: Args) => Promise<Ctx> | Ctx
  onSuccess?: (data: unknown, args: Args, ctx: Ctx) => unknown
  onError?: (err: unknown, args: Args, ctx: Ctx) => unknown
}
let capturedConfig: MutConfig<unknown, unknown> | null = null
let capturedQc: QueryClient
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => capturedQc,
    useMutation: (config: MutConfig<unknown, unknown>) => {
      capturedConfig = config
      return {}
    },
  }
})

async function runMutation<Args>(args: Args) {
  const cfg = capturedConfig as MutConfig<Args, unknown>
  const ctx = cfg.onMutate ? await cfg.onMutate(args) : undefined
  try {
    const data = cfg.mutationFn ? await cfg.mutationFn(args) : undefined
    await cfg.onSuccess?.(data, args, ctx)
    return { data, ctx }
  } catch (err) {
    cfg.onError?.(err, args, ctx)
    throw err
  }
}

async function loadMod() {
  vi.resetModules()
  return await import("./messages")
}

function makeCache(msgs: Array<{ id: string } & Record<string, unknown>> = []) {
  return {
    pages: [{ messages: msgs, hasMore: false }],
    pageParams: [null],
  }
}

function postedMessage(id: string, seq: number) {
  return {
    id,
    seq,
    createdAt: "2026-08-07T10:00:00.000Z",
    content: "canonical content",
    authorId: "u_me",
    authorName: "Canonical Name",
    authorImage: "https://avatar.test/me.png",
    type: "default",
    embeds: [{ title: "Canonical embed" }],
  }
}

function sidebarData(threadId = "post_1") {
  return {
    channels: [],
    included: { parentMessages: [] },
    serverNow: "2026-08-07T00:00:00.000Z",
    serverClockOffsetMs: 0,
    threads: [{
      id: threadId,
      parentChannelId: "forum_1",
      parentMessageId: "opener_1",
      title: "Old title",
      activityAt: "2026-08-06T00:00:00.000Z",
      expiresAt: "2026-08-09T00:00:00.000Z",
      unread: false,
    }],
  }
}

function seedParent(type: "forum" | "text", parentId = "forum_1") {
  capturedQc.setQueryData(communityKeys.server("s1"), {
    id: "s1",
    categories: [{ id: "cat_1", channels: [{ id: parentId, type }] }],
  })
}

beforeEach(() => {
  apiFetchMock.mockReset()
  toastMock.mockReset()
  capturedConfig = null
  capturedQc = new QueryClient()
  refs = new Map()
  refCounter = 0
  callbackMemo = new Map()
  callbackCounter = 0
})

describe("useEditMessage", () => {
  it("optimistically patches content and rolls back when PATCH fails", async () => {
    const key = communityKeys.channelMessages("ch_1")
    const messageKey = communityKeys.message("m1")
    capturedQc.setQueryData(key, makeCache([{ id: "m1", content: "old" }]))
    capturedQc.setQueryData(messageKey, { id: "m1", content: "old" })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    mod.useEditMessage()

    await runMutation({ serverId: "s1", channelId: "ch_1", messageId: "m1", content: "new" }).catch(() => {})

    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/messages/m1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "new" }),
    })
    const cache = capturedQc.getQueryData<{ pages: { messages: { content?: string }[] }[] }>(key)
    expect(cache?.pages[0].messages[0]?.content).toBe("old")
    expect(capturedQc.getQueryData<{ content: string }>(messageKey)?.content).toBe("old")
  }, 60_000)

  it("optimistically patches the single-message cache used by a post header", async () => {
    const messageKey = communityKeys.message("opener_1")
    capturedQc.setQueryData(messageKey, { id: "opener_1", content: "Old title" })
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await loadMod()
    mod.useEditMessage()

    await runMutation({
      serverId: "s1", channelId: "forum_1", messageId: "opener_1", content: "New title", forumChannelId: "forum_1",
    })

    expect(capturedQc.getQueryData<{ content: string }>(messageKey)?.content).toBe("New title")
  })

  it("invalidates only the exact Inbox and base threads reads after an opener edit", async () => {
    const threads = communityKeys.threads("forum_1")
    const feed = communityKeys.forumFeed("forum_1", "bug")
    const inbox = communityKeys.inboxUnreads()
    capturedQc.setQueryData(threads, { serverId: "s1", parentType: "forum", parentChannelId: "forum_1", threads: [] })
    capturedQc.setQueryData(feed, { pages: [], pageParams: [] })
    capturedQc.setQueryData(inbox, { servers: [], dms: [] })
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await loadMod()
    mod.useEditMessage()

    await runMutation({
      serverId: "s1", channelId: "forum_1", messageId: "opener_1", content: "new",
      forumChannelId: "forum_1", forumThreadId: "post_1",
    })

    expect(capturedQc.getQueryState(threads)?.isInvalidated).toBe(true)
    expect(capturedQc.getQueryState(inbox)?.isInvalidated).toBe(true)
    expect(capturedQc.getQueryState(feed)?.isInvalidated).toBe(false)
  })

  it("patches a loaded forum-sidebar title after the opener edit succeeds", async () => {
    seedParent("forum")
    const sidebarKey = communityKeys.forumSidebarThreads("s1")
    capturedQc.setQueryData(sidebarKey, sidebarData())
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await loadMod()
    mod.useEditMessage()

    await runMutation({
      serverId: "s1",
      channelId: "forum_1",
      messageId: "opener_1",
      content: "New title",
      forumChannelId: "forum_1",
      forumThreadId: "post_1",
    })

    expect(capturedQc.getQueryData<ReturnType<typeof sidebarData>>(sidebarKey)?.threads[0].title)
      .toBe("New title")
  })
})

// ── useSendMessage ────────────────────────────────────────────────────────

describe("useSendMessage — happy path", () => {
  it("keeps Query base-only and acknowledges the accepted overlay intent", async () => {
    capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), makeCache([]))
    apiFetchMock.mockResolvedValueOnce({ message: postedMessage("server_id_1", 9) })

    const mod = await loadMod()
    const stream = await import("@/stores/community/message-stream")
    stream.useMessageStreamStore.getState().accept(
      { kind: "channel", id: "ch_1", serverId: "s1" },
      { nonce: "n1", tempId: "temp_n1", message: { type: "chat", content: "hi" }, localUploads: [] },
    )
    mod.useSendMessage() // populate capturedConfig
    await runMutation({
      serverId: "s1",
      channelId: "ch_1",
      content: "hi",
      nonce: "n1",
      author: { id: "u_me", name: "me", avatar: "M" },
    })

    const cache = capturedQc.getQueryData<{ pages: { messages: Msg[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].messages).toEqual([])
    expect(stream.getMessageOverlay({ kind: "channel", id: "ch_1", serverId: "s1" }).outboxByNonce.get("n1")).toEqual(
      expect.objectContaining({
        status: "acked",
        serverMessageId: "server_id_1",
        serverSeq: 9,
        message: expect.objectContaining({
          authorName: "Canonical Name",
          content: "canonical content",
          embeds: [{ title: "Canonical embed" }],
        }),
      }),
    )
  })

  it("re-ranks a loaded participating forum thread from the canonical send timestamp", async () => {
    seedParent("forum")
    const sidebarKey = communityKeys.forumSidebarThreads("s1")
    capturedQc.setQueryData(sidebarKey, sidebarData())
    apiFetchMock.mockResolvedValueOnce({ message: postedMessage("server_id_1", 9) })
    const mod = await loadMod()
    mod.useSendMessage()

    await runMutation({
      serverId: "s1",
      channelId: "post_1",
      forumParentChannelId: "forum_1",
      content: "hi",
      author: { id: "u_me", name: "me", avatar: "M" },
    })

    expect(capturedQc.getQueryData<ReturnType<typeof sidebarData>>(sidebarKey)?.threads[0])
      .toMatchObject({
        activityAt: "2026-08-07T10:00:00.000Z",
        expiresAt: "2026-08-10T10:00:00.000Z",
      })
  })

  it("invalidates the sidebar collection when a just-enrolled thread is not loaded", async () => {
    seedParent("forum")
    const sidebarKey = communityKeys.forumSidebarThreads("s1")
    const empty = { ...sidebarData(), threads: [] }
    capturedQc.setQueryData(sidebarKey, empty)
    apiFetchMock.mockResolvedValueOnce({ message: postedMessage("server_id_1", 9) })
    const mod = await loadMod()
    mod.useSendMessage()

    await runMutation({
      serverId: "s1",
      channelId: "post_new",
      forumParentChannelId: "forum_1",
      content: "hi",
      author: { id: "u_me", name: "me", avatar: "M" },
    })

    await vi.waitFor(() => {
      expect(capturedQc.getQueryState(sidebarKey)?.isInvalidated).toBe(true)
    })
  })

  it("does not touch forum resources when sending in an ordinary text thread", async () => {
    seedParent("text", "text_parent")
    const baseKey = communityKeys.forumSidebarThreads("s1")
    const retainedKey = communityKeys.forumSidebarRetained("s1", "forum_post")
    const metaKey = communityKeys.channelMeta("s1", "text_thread")
    const hintKey = communityKeys.forumOpenerHint("s1", "forum_opener")
    capturedQc.setQueryData(baseKey, sidebarData())
    capturedQc.setQueryData(retainedKey, { id: "forum_post" })
    capturedQc.setQueryData(metaKey, { id: "text_thread", parentChannelId: "text_parent" })
    capturedQc.setQueryData(hintKey, { id: "forum_opener", content: "Forum title" })
    const before = [
      capturedQc.getQueryData(baseKey),
      capturedQc.getQueryData(retainedKey),
      capturedQc.getQueryData(metaKey),
      capturedQc.getQueryData(hintKey),
    ]
    apiFetchMock.mockResolvedValueOnce({ message: postedMessage("server_id_1", 9) })
    const mod = await loadMod()
    mod.useSendMessage()

    await runMutation({
      serverId: "s1",
      channelId: "text_thread",
      forumParentChannelId: "text_parent",
      content: "hi",
      author: { id: "u_me", name: "me", avatar: "M" },
    })

    expect(capturedQc.getQueryState(baseKey)?.isInvalidated).toBe(false)
    expect([
      capturedQc.getQueryData(baseKey),
      capturedQc.getQueryData(retainedKey),
      capturedQc.getQueryData(metaKey),
      capturedQc.getQueryData(hintKey),
    ]).toEqual(before)
  })
})

describe("useSendMessage — rollback", () => {
  it("marks the optimistic row as failed on server error", async () => {
    capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), makeCache([]))
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    const stream = await import("@/stores/community/message-stream")
    stream.useMessageStreamStore.getState().accept(
      { kind: "channel", id: "ch_1", serverId: "s1" },
      { nonce: "n1", tempId: "temp_n1", message: { type: "chat", content: "hi" }, localUploads: [] },
    )
    mod.useSendMessage()
    await runMutation({
      serverId: "s1",
      channelId: "ch_1",
      content: "hi",
      nonce: "n1",
      author: { id: "u_me", name: "me", avatar: "M" },
    }).catch(() => { })
    const cache = capturedQc.getQueryData<{ pages: { messages: { id: string; failed?: boolean }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].messages).toEqual([])
    expect(stream.getMessageOverlay({ kind: "channel", id: "ch_1", serverId: "s1" }).outboxByNonce.get("n1")?.status).toBe("failed")
  })
})

// Regression pin — the mount-time effect in <MessageList> gates self-send
// auto-scroll on `tail.authorId === viewerUserId`.
describe("useSendMessage — stamps authorId on optimistic row", () => {
  it("optimistic row carries the sender's authorId", async () => {
    capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), makeCache([]))
    const mod = await loadMod()
    const stream = await import("@/stores/community/message-stream")
    stream.useMessageStreamStore.getState().accept(
      { kind: "channel", id: "ch_1", serverId: "s1" },
      {
        nonce: "n1",
        tempId: "temp_n1",
        message: { type: "chat", content: "hi", authorId: "u_me" },
        localUploads: [],
      },
    )
    expect(stream.getMessageOverlay({ kind: "channel", id: "ch_1", serverId: "s1" }).outboxByNonce.get("n1")?.message.authorId).toBe("u_me")
    expect(mod.useSendMessage).toBeTypeOf("function")
  })
})

// ── useSendDmMessage ──────────────────────────────────────────────────────

async function acceptDmIntent(nonce = "n1") {
  const stream = await import("@/stores/community/message-stream")
  stream.useMessageStreamStore.getState().accept(
    { kind: "dm", id: "dm_1" },
    {
      nonce,
      tempId: `temp_${nonce}`,
      message: { type: "chat", content: "hi", authorId: "u_me" },
      localUploads: [],
    },
  )
  return stream
}

describe("useSendDmMessage — overlay terminal emitter", () => {
  it("keeps Query base-only and emits exactly one postAck", async () => {
    capturedQc.setQueryData(communityKeys.dmMessages("dm_1"), makeCache([]))
    apiFetchMock.mockResolvedValueOnce({ message: postedMessage("server_1", 8) })
    const mod = await loadMod()
    const stream = await acceptDmIntent()
    const dispatch = vi.spyOn(stream.useMessageStreamStore.getState(), "dispatch")
    mod.useSendDmMessage()
    await runMutation({ dmId: "dm_1", content: "hi", nonce: "n1" })

    expect(capturedQc.getQueryData(communityKeys.dmMessages("dm_1"))).toEqual(makeCache([]))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(
      { kind: "dm", id: "dm_1" },
      {
        type: "postAck",
        nonce: "n1",
        message: expect.objectContaining({
          id: "server_1",
          seq: 8,
          authorName: "Canonical Name",
          content: "canonical content",
          clientNonce: "n1",
        }),
      },
    )
  })

  it("emits postFail for a generic network failure and leaves Query untouched", async () => {
    capturedQc.setQueryData(communityKeys.dmMessages("dm_1"), makeCache([]))
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    const stream = await acceptDmIntent()
    const dispatch = vi.spyOn(stream.useMessageStreamStore.getState(), "dispatch")
    mod.useSendDmMessage()
    await runMutation({ dmId: "dm_1", content: "hi", nonce: "n1" }).catch(() => { })

    expect(capturedQc.getQueryData(communityKeys.dmMessages("dm_1"))).toEqual(makeCache([]))
    expect(stream.getMessageOverlay({ kind: "dm", id: "dm_1" }).outboxByNonce.get("n1")?.status).toBe("failed")
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(
      { kind: "dm", id: "dm_1" },
      { type: "postFail", nonce: "n1" },
    )
  })
})

describe("useSendDmMessage — 403 blocked special-case", () => {
  it("removes the temp row and fires the scoped toast, no failed:true state", async () => {
    capturedQc.setQueryData(communityKeys.dmMessages("dm_1"), makeCache([]))
    const mod = await loadMod()
    // Import ApiError AFTER loadMod so it resolves against the SAME module
    // instance the hook's `err instanceof ApiError` check will see.
    const { ApiError } = await import("@/lib/errors")
    apiFetchMock.mockRejectedValueOnce(new ApiError("blocked", 403))
    const stream = await acceptDmIntent()
    const dispatch = vi.spyOn(stream.useMessageStreamStore.getState(), "dispatch")
    mod.useSendDmMessage()
    await runMutation({
      dmId: "dm_1",
      content: "hi",
      nonce: "n1",
    }).catch(() => { })
    expect(stream.getMessageOverlay({ kind: "dm", id: "dm_1" }).outboxByNonce.size).toBe(0)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(
      { kind: "dm", id: "dm_1" },
      { type: "terminalReject", nonce: "n1" },
    )
    expect(capturedQc.getQueryData(communityKeys.dmMessages("dm_1"))).toEqual(makeCache([]))
    expect(toastMock).toHaveBeenCalledWith("You cannot send messages to this user")
  })

  it("regression: a generic 500 still marks the row failed and fires the generic send-failed toast (not the blocked toast)", async () => {
    capturedQc.setQueryData(communityKeys.dmMessages("dm_1"), makeCache([]))
    const mod = await loadMod()
    const { ApiError } = await import("@/lib/errors")
    apiFetchMock.mockRejectedValueOnce(new ApiError("boom", 500))
    const stream = await acceptDmIntent()
    mod.useSendDmMessage()
    await runMutation({
      dmId: "dm_1",
      content: "hi",
      nonce: "n1",
    }).catch(() => { })
    expect(stream.getMessageOverlay({ kind: "dm", id: "dm_1" }).outboxByNonce.get("n1")?.status).toBe("failed")
    expect(capturedQc.getQueryData(communityKeys.dmMessages("dm_1"))).toEqual(makeCache([]))
    // Not the blocked-specific copy — any other error falls through to the
    // generic send-failed toast (see `useSendDmMessage`'s `onError` fallback).
    expect(toastMock).not.toHaveBeenCalledWith("You cannot send messages to this user")
    expect(toastMock).toHaveBeenCalledWith("boom")
  })
})

// 429 rate-limit toasts on both channel and DM send paths — the pill stays
// as `failed: true` so the retry affordance is still visible, but a toast
// fires so the user knows why the send didn't go through.
describe("useSendMessage — 429 rate limit fires a toast + marks failed", () => {
  it("channel 429: toast fires and row is marked failed:true", async () => {
    capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), makeCache([]))
    const mod = await loadMod()
    const { ApiError } = await import("@/lib/errors")
    apiFetchMock.mockRejectedValueOnce(new ApiError("rate_limited", 429))
    mod.useSendMessage()
    const stream = await import("@/stores/community/message-stream")
    stream.useMessageStreamStore.getState().accept(
      { kind: "channel", id: "ch_1", serverId: "s1" },
      { nonce: "n1", tempId: "temp_n1", message: { type: "chat", content: "hi" }, localUploads: [] },
    )
    await runMutation({
      serverId: "s1",
      channelId: "ch_1",
      content: "hi",
      nonce: "n1",
      author: { id: "u_me", name: "me", avatar: "M" },
    }).catch(() => { })
    const cache = capturedQc.getQueryData<{ pages: { messages: { failed?: boolean }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].messages).toEqual([])
    expect(stream.getMessageOverlay({ kind: "channel", id: "ch_1", serverId: "s1" }).outboxByNonce.get("n1")?.status).toBe("failed")
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining("Rate limited"))
  })
})

describe("useSendDmMessage — 429 rate limit fires a toast + marks failed", () => {
  it("DM 429: toast fires and row is marked failed:true (not scrubbed like 403 blocked)", async () => {
    capturedQc.setQueryData(communityKeys.dmMessages("dm_1"), makeCache([]))
    const mod = await loadMod()
    const { ApiError } = await import("@/lib/errors")
    apiFetchMock.mockRejectedValueOnce(new ApiError("rate_limited", 429))
    const stream = await acceptDmIntent()
    mod.useSendDmMessage()
    await runMutation({
      dmId: "dm_1",
      content: "hi",
      nonce: "n1",
    }).catch(() => { })
    expect(stream.getMessageOverlay({ kind: "dm", id: "dm_1" }).outboxByNonce.get("n1")?.status).toBe("failed")
    expect(capturedQc.getQueryData(communityKeys.dmMessages("dm_1"))).toEqual(makeCache([]))
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining("Rate limited"))
  })
})

// Regression guard — channel path stays generic-error, never fires the DM's
// specific blocked toast even on 403 (that shouldn't happen on channels;
// ensure the hook doesn't accidentally add DM's onBlocked branch to
// `useSendMessage`). It still falls through to the generic send-failed
// toast, same as any other non-429 error.
describe("useSendMessage — no blocked branch on channel path", () => {
  it("403 blocked on channel POST still marks failed:true and skips the DM-specific toast", async () => {
    capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), makeCache([]))
    const mod = await loadMod()
    const { ApiError } = await import("@/lib/errors")
    apiFetchMock.mockRejectedValueOnce(new ApiError("blocked", 403))
    mod.useSendMessage()
    const stream = await import("@/stores/community/message-stream")
    stream.useMessageStreamStore.getState().accept(
      { kind: "channel", id: "ch_1", serverId: "s1" },
      { nonce: "n1", tempId: "temp_n1", message: { type: "chat", content: "hi" }, localUploads: [] },
    )
    await runMutation({
      serverId: "s1",
      channelId: "ch_1",
      content: "hi",
      nonce: "n1",
      author: { id: "u_me", name: "me", avatar: "M" },
    }).catch(() => { })
    const cache = capturedQc.getQueryData<{ pages: { messages: { failed?: boolean }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].messages).toEqual([])
    expect(stream.getMessageOverlay({ kind: "channel", id: "ch_1", serverId: "s1" }).outboxByNonce.get("n1")?.status).toBe("failed")
    expect(toastMock).not.toHaveBeenCalledWith("You cannot send messages to this user")
    expect(toastMock).toHaveBeenCalledWith("blocked")
  })
})

// ── useToggleReactionApi — the #9 300ms debounce ────────────────────────
//
// Old context (context.tsx:1061-1130) captured `originalMe` at first click,
// scheduled the API in a 300ms timer, and either replaced or cancelled the
// timer on subsequent clicks. Step 3's hook dropped the coalescing; this
// restores it via useCommunityStore.reactionTimers.
describe("useToggleReactionApi — 300ms debounce coalescing", () => {
  it("updates and rolls back a fallback-only channel row without creating a second row", async () => {
    vi.useFakeTimers()
    try {
      capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), makeCache([]))
      apiFetchMock.mockRejectedValueOnce(new Error("boom"))
      const mod = await loadMod()
      const stream = await import("@/stores/community/message-stream")
      const scope = { kind: "channel" as const, id: "ch_1", serverId: "s1" }
      stream.useMessageStreamStore.getState().dispatch(scope, {
        type: "wsMessage",
        message: {
          id: "m_1",
          seq: 1,
          type: "chat",
          authorId: "u_other",
          authorName: "Other",
          content: "hello",
          createdAt: "2026-08-06T00:00:00.000Z",
          reactions: [{ emoji: "👍", count: 1, me: true, userIds: ["u_me"] }],
        },
      })

      const toggle = mod.useToggleReactionApi()
      toggle({
        serverId: "s1",
        channelId: "ch_1",
        messageId: "m_1",
        emoji: "👍",
        userId: "u_me",
      })

      let overlay = stream.getMessageOverlay(scope)
      expect(overlay.liveById).toHaveLength(1)
      expect(overlay.liveById.get("m_1")?.reactions).toEqual([])

      await vi.advanceTimersByTimeAsync(300)
      await Promise.resolve()

      overlay = stream.getMessageOverlay(scope)
      expect(apiFetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/community/messages/m_1/reactions/"),
        { method: "DELETE" },
      )
      expect(overlay.liveById).toHaveLength(1)
      expect(overlay.liveById.get("m_1")?.reactions).toEqual([
        expect.objectContaining({ emoji: "👍", me: true, count: 1 }),
      ])
      expect(capturedQc.getQueryData<{ pages: { messages: unknown[] }[] }>(
        communityKeys.channelMessages("ch_1"),
      )?.pages[0].messages).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("updates and rolls back a fallback-only DM row, starting from me=true", async () => {
    vi.useFakeTimers()
    try {
      capturedQc.setQueryData(communityKeys.dmMessages("dm_1"), makeCache([]))
      apiFetchMock.mockRejectedValueOnce(new Error("boom"))
      const mod = await loadMod()
      const stream = await import("@/stores/community/message-stream")
      const scope = { kind: "dm" as const, id: "dm_1" }
      stream.useMessageStreamStore.getState().dispatch(scope, {
        type: "wsMessage",
        message: {
          id: "m_dm",
          seq: 2,
          type: "chat",
          content: "hello",
          reactions: [{ emoji: "👍", count: 1, me: true, userIds: ["u_me"] }],
        },
      })

      mod.useToggleReactionApi()({
        dmId: "dm_1",
        messageId: "m_dm",
        emoji: "👍",
        userId: "u_me",
      })
      expect(stream.getMessageOverlay(scope).liveById.get("m_dm")?.reactions).toEqual([])

      await vi.advanceTimersByTimeAsync(300)
      await Promise.resolve()

      expect(apiFetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/community/messages/m_dm/reactions/"),
        { method: "DELETE" },
      )
      expect(stream.getMessageOverlay(scope).liveById.get("m_dm")?.reactions).toEqual([
        expect.objectContaining({ emoji: "👍", me: true, count: 1 }),
      ])
      expect(capturedQc.getQueryData<{ pages: { messages: unknown[] }[] }>(
        communityKeys.dmMessages("dm_1"),
      )?.pages[0].messages).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not invent a DM fallback when the message exists in neither base nor overlay", async () => {
    vi.useFakeTimers()
    try {
      capturedQc.setQueryData(communityKeys.dmMessages("dm_1"), makeCache([]))
      apiFetchMock.mockRejectedValueOnce(new Error("boom"))
      const mod = await loadMod()
      const stream = await import("@/stores/community/message-stream")
      const scope = { kind: "dm" as const, id: "dm_1" }

      mod.useToggleReactionApi()({
        dmId: "dm_1",
        messageId: "missing",
        emoji: "👍",
        userId: "u_me",
      })
      await vi.advanceTimersByTimeAsync(300)
      await Promise.resolve()

      expect(stream.getMessageOverlay(scope).liveById.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("5 rapid clicks with alternating me→!me→me settle to a SINGLE API call at end of window", async () => {
    vi.useFakeTimers()
    try {
      // Baseline: server-side reactions=[], me=false.
      capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), {
        pages: [{ messages: [{ id: "m_1", reactions: [] }], hasMore: false }],
        pageParams: [null],
      })
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      mod._resetReactionTimers_forTesting()
      const toggle = mod.useToggleReactionApi()
      // 5 rapid taps — cache flips each call, but only the final settled
      // state is what should fire against the server.
      // originalMe (server) = false; after 5 flips me ends up true → PUT.
      for (let i = 0; i < 5; i++) {
        toggle({ channelId: "ch_1", messageId: "m_1", emoji: "👍", userId: "u_me" })
      }
      // Nothing yet — everything's debounced.
      expect(apiFetchMock).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(300)
      expect(apiFetchMock).toHaveBeenCalledTimes(1)
      expect(apiFetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/community/messages/m_1/reactions/"),
        { method: "PUT" },
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("flip-back (net-zero) cancels the timer — zero API calls fire", async () => {
    vi.useFakeTimers()
    try {
      capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), {
        pages: [{ messages: [{ id: "m_1", reactions: [] }], hasMore: false }],
        pageParams: [null],
      })
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      mod._resetReactionTimers_forTesting()
      const toggle = mod.useToggleReactionApi()
      // Toggle on → toggle off within 300ms. originalMe=false, terminal me=false.
      toggle({ channelId: "ch_1", messageId: "m_1", emoji: "👍", userId: "u_me" })
      toggle({ channelId: "ch_1", messageId: "m_1", emoji: "👍", userId: "u_me" })
      await vi.advanceTimersByTimeAsync(500)
      expect(apiFetchMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("triple-toggle net = one flip → exactly one API call at end of window", async () => {
    vi.useFakeTimers()
    try {
      capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), {
        pages: [{ messages: [{ id: "m_1", reactions: [] }], hasMore: false }],
        pageParams: [null],
      })
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      mod._resetReactionTimers_forTesting()
      const toggle = mod.useToggleReactionApi()
      // originalMe=false. Toggle-toggle-toggle → terminal me=true → PUT.
      toggle({ channelId: "ch_1", messageId: "m_1", emoji: "👍", userId: "u_me" })
      toggle({ channelId: "ch_1", messageId: "m_1", emoji: "👍", userId: "u_me" })
      toggle({ channelId: "ch_1", messageId: "m_1", emoji: "👍", userId: "u_me" })
      expect(apiFetchMock).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(300)
      expect(apiFetchMock).toHaveBeenCalledTimes(1)
      expect(apiFetchMock.mock.calls[0][1]).toEqual({ method: "PUT" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("useCommunityStore.reset() before the timer fires cancels the pending API call", async () => {
    vi.useFakeTimers()
    try {
      capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), {
        pages: [{ messages: [{ id: "m_1", reactions: [] }], hasMore: false }],
        pageParams: [null],
      })
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      const { useCommunityStore } = await import("@/stores/community")
      useCommunityStore.getState().reset()
      const toggle = mod.useToggleReactionApi()
      toggle({ channelId: "ch_1", messageId: "m_1", emoji: "👍", userId: "u_me" })
      // Simulate sign-out unmount — reset() clears timer maps.
      useCommunityStore.getState().reset()
      await vi.advanceTimersByTimeAsync(500)
      expect(apiFetchMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── usePinMessage ─────────────────────────────────────────────────────────

describe("usePinMessage — invalidates pins on success", () => {
  it("triggers invalidateQueries on pins(channelId)", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await loadMod()
    mod.usePinMessage()
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation({ channelId: "ch_1", messageId: "m_1" })
    expect(
      spy.mock.calls.some((c) => {
        const key = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(key) && key.includes("pins")
      }),
    ).toBe(true)
  })
})

// ── useUnpinMessage ───────────────────────────────────────────────────────

describe("useUnpinMessage — rollback", () => {
  it("removes optimistically and restores on failure", async () => {
    capturedQc.setQueryData(communityKeys.pins("ch_1"), { pins: [{ id: "m_1", content: "hi" }] })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    mod.useUnpinMessage()
    await runMutation({ channelId: "ch_1", messageId: "m_1" }).catch(() => { })
    const cache = capturedQc.getQueryData<{ pins: unknown[] }>(communityKeys.pins("ch_1"))
    expect(cache?.pins).toHaveLength(1)
  })
})

// ── useCreateThread ───────────────────────────────────────────────────────

describe("useCreateThread — patches parent message + invalidates threads", () => {
  it("adds thread indicator to the parent message with messageCount: 0", async () => {
    // Regression: previously patched messageCount=1 on the assumption that
    // the parent message was cloned into the thread. #6 removed the
    // parent-clone, so new threads start empty. `messageCount` MUST be 0
    // to avoid the UI showing "1 reply" on an empty thread.
    capturedQc.setQueryData(communityKeys.channelMessages("ch_parent"), {
      pages: [{ messages: [{ id: "m_p" }], hasMore: false }],
      pageParams: [null],
    })
    apiFetchMock.mockResolvedValueOnce({ id: "thr_1" })
    const mod = await loadMod()
    mod.useCreateThread()
    await runMutation({ channelId: "ch_parent", messageId: "m_p", name: "Discussion" })
    const cache = capturedQc.getQueryData<{
      pages: { messages: { id: string; thread?: { id: string; name: string; messageCount: number } }[] }[]
    }>(communityKeys.channelMessages("ch_parent"))
    expect(cache?.pages[0].messages[0].thread).toEqual({ id: "thr_1", name: "Discussion", messageCount: 0 })
  })
})

// ── useMarkAllInboxRead ───────────────────────────────────────────────────

describe("useMarkAllInboxRead", () => {
  it("fires exactly three POSTs — mentions + unreads + dms read-all", async () => {
    capturedQc.setQueryData(communityKeys.inboxUnreads(), { servers: [] })
    capturedQc.setQueryData(communityKeys.inboxMentions(), { mentions: [] })
    apiFetchMock.mockResolvedValue(undefined)
    const mod = await loadMod()
    mod.useMarkAllInboxRead()
    await runMutation<void>(undefined as unknown as void)
    const posts = apiFetchMock.mock.calls.filter(
      (c) => (c[1] as { method?: string })?.method === "POST",
    )
    expect(posts).toHaveLength(3)
    const paths = posts.map((c) => c[0] as string).sort()
    expect(paths).toEqual([
      "/api/community/users/me/inbox/dms/read-all",
      "/api/community/users/me/inbox/mentions/read-all",
      "/api/community/users/me/inbox/unreads/read-all",
    ])
  })

  it("clears both inbox caches optimistically", async () => {
    capturedQc.setQueryData(communityKeys.inboxUnreads(), {
      servers: [{ serverId: "s_1", serverName: "s", channels: [{ channelId: "ch_1" }] }],
    })
    capturedQc.setQueryData(communityKeys.inboxMentions(), {
      mentions: [{ id: "men_1" }],
    })
    apiFetchMock.mockResolvedValue(undefined)
    const mod = await loadMod()
    mod.useMarkAllInboxRead()
    await runMutation<void>(undefined as unknown as void)
    expect(capturedQc.getQueryData(communityKeys.inboxUnreads())).toEqual({ servers: [], dms: [] })
    expect(capturedQc.getQueryData(communityKeys.inboxMentions())).toEqual({ mentions: [] })
  })

  it("onSuccess invalidates communityKeys.servers() so every rail badge drops to 0", async () => {
    // Mark-all-read clears every unread mention row on the server — the rail
    // aggregate must refresh across all servers, not just the inbox feeds.
    apiFetchMock.mockResolvedValue(undefined)
    const mod = await loadMod()
    mod.useMarkAllInboxRead()
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation<void>(undefined as unknown as void)
    const serversInvalidates = spy.mock.calls.filter((c) => {
      const key = c[0]?.queryKey as unknown[] | undefined
      return Array.isArray(key) && key.length === 2 && key[0] === "community" && key[1] === "servers"
    })
    expect(serversInvalidates.length).toBeGreaterThanOrEqual(1)
  })

  it("toasts the failure reason when one of the three read-all POSTs fails", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    mod.useMarkAllInboxRead()
    await runMutation<void>(undefined as unknown as void).catch(() => { })
    expect(toastMock).toHaveBeenCalledWith("boom")
  })
})

// ── useDeleteMention — rollback ──────────────────────────────────────────

describe("useDeleteMention — rollback", () => {
  it("restores mention on failure", async () => {
    capturedQc.setQueryData(communityKeys.inboxMentions(), {
      mentions: [{ id: "men_1" }],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    mod.useDeleteMention()
    await runMutation({ mentionId: "men_1" }).catch(() => { })
    const cache = capturedQc.getQueryData<{ mentions: { id: string }[] }>(
      communityKeys.inboxMentions(),
    )
    expect(cache?.mentions).toHaveLength(1)
  })

  it("toasts the failure reason on delete failure", async () => {
    capturedQc.setQueryData(communityKeys.inboxMentions(), {
      mentions: [{ id: "men_1" }],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    mod.useDeleteMention()
    await runMutation({ mentionId: "men_1" }).catch(() => { })
    expect(toastMock).toHaveBeenCalledWith("boom")
  })

  it("invalidates communityKeys.servers() on success so the rail badge decrements", async () => {
    capturedQc.setQueryData(communityKeys.inboxMentions(), {
      mentions: [{ id: "men_1" }],
    })
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await loadMod()
    mod.useDeleteMention()
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation({ mentionId: "men_1" })
    const serversInvalidates = spy.mock.calls.filter((c) => {
      const key = c[0]?.queryKey as unknown[] | undefined
      return Array.isArray(key) && key.length === 2 && key[0] === "community" && key[1] === "servers"
    })
    expect(serversInvalidates).toHaveLength(1)
  })
})
