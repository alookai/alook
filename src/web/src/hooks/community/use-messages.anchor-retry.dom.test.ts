import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClientProvider, onlineManager } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, dmConversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { ApiError } from "@/lib/errors"
import { COMMUNITY_CONVERSATION_ANCHOR_MISSING } from "@alook/shared"
import { ConversationReadTimeoutError } from "@/lib/community/conversation-read"
import { useMessages, useDmMessages } from "./use-messages"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => load(...args) }))
beforeEach(() => { load.mockReset(); return () => { onlineManager.setOnline(true) } })
async function setup() {
  const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retryDelay: 0 } } })
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client }, createElement(CommunityDbProvider, { registry: owner.registry }, children))
  return { ...owner, wrapper }
}

describe("entry failure and explicit recovery", () => {
  it.each(["channel", "dm"] as const)("keeps a cold %s failure local through remount and recovers with Retry", async kind => {
    const { wrapper } = await setup()
    load.mockRejectedValue(new ApiError("temporary", 503))
    const useSurface = kind === "channel" ? () => useMessages("c1", { serverId: "s1" }) : () => useDmMessages("c1")
    const first = renderHook(useSurface, { wrapper })
    await waitFor(() => expect(first.result.current.initialLoadError).toBeTruthy())
    expect(first.result.current.readSnapshot).toBeNull()
    expect(load).toHaveBeenCalledTimes(kind === "dm" ? 1 : 2)
    first.unmount()
    const returned = renderHook(useSurface, { wrapper })
    expect(returned.result.current.initialLoadError).toBeTruthy()
    await act(async () => { onlineManager.setOnline(false); onlineManager.setOnline(true) })
    expect(load).toHaveBeenCalledTimes(kind === "dm" ? 1 : 2)
    load.mockResolvedValue(kind === "channel" ? conversationEntryFixture() : dmConversationEntryFixture())
    const failedAttempt = returned.result.current.positionEntry
    await act(async () => returned.result.current.retryInitialLoad())
    await waitFor(() => expect(returned.result.current.initialPositionKnown).toBe(true))
    expect(returned.result.current.messages.map(row => row.id)).toEqual(["m1"])
    expect(returned.result.current.readSnapshot?.lastReadMessageId).toBe("m1")
    expect(returned.result.current.positionEntry).not.toBe(failedAttempt)
    expect(returned.result.current.positionDataState).toBe("ready")
    expect(load).toHaveBeenCalledTimes(kind === "dm" ? 2 : 3)
    returned.unmount()
  })

  it.each([false, true])("keeps a confirmed window ready during a failed background read, empty=%s", async empty => {
    const { wrapper } = await setup()
    const packet = conversationEntryFixture()
    if (empty) { packet.messages = []; packet.selection = { reason: "tail", anchorMessageId: null }; packet.readState.lastReadMessageId = null; packet.page.hasMoreOlder = false }
    load.mockResolvedValue(packet)
    const hook = renderHook(() => useMessages("c1", { serverId: "s1" }), { wrapper })
    await waitFor(() => expect(hook.result.current.initialPositionKnown).toBe(true))
    const pointer = hook.result.current.readSnapshot
    const positionEntry = hook.result.current.positionEntry
    load.mockRejectedValue(new ConversationReadTimeoutError())
    await act(async () => { await hook.result.current.refetch() })
    expect(hook.result.current.isLoading).toBe(false)
    expect(hook.result.current.initialLoadError).toBeNull()
    expect(hook.result.current.initialPositionKnown).toBe(true)
    expect(hook.result.current.readSnapshot).toBe(pointer)
    expect(hook.result.current.positionEntry).toBe(positionEntry)
    expect(hook.result.current.positionDataState).toBe(empty ? "empty" : "ready")
    expect(hook.result.current.messages).toHaveLength(empty ? 0 : 1)
    hook.unmount()
  })

  it("binds an explicit Retry to its own result even when a prior valid window remains", async () => {
    const { wrapper } = await setup()
    load.mockResolvedValue(conversationEntryFixture())
    const hook = renderHook(() => useMessages("c1", { serverId: "s1" }), { wrapper })
    await waitFor(() => expect(hook.result.current.positionDataState).toBe("ready"))
    const first = hook.result.current.positionEntry
    let fail!: (error: Error) => void
    load.mockReturnValue(new Promise((_, reject) => { fail = reject }))
    await act(async () => hook.result.current.retryInitialLoad())
    const retry = hook.result.current.positionEntry
    expect(retry).not.toBe(first)
    expect(hook.result.current.positionDataState).toBe("pending")
    await act(async () => fail(new ConversationReadTimeoutError()))
    await waitFor(() => expect(hook.result.current.positionDataState).toBe("error"))
    expect(hook.result.current.messages.map(row => row.id)).toEqual(["m1"])
    expect(hook.result.current.positionEntry).toBe(retry)
    load.mockResolvedValue({ messages: conversationEntryFixture().messages, latestSeq: 1, hasMoreOlder: false, hasMoreNewer: false })
    await act(async () => hook.result.current.retryInitialLoad())
    await waitFor(() => expect(hook.result.current.positionDataState).toBe("ready"))
    expect(hook.result.current.positionEntry).not.toBe(retry)
    hook.unmount()
  })

  it("keeps a missing explicit message local while a fallback qualifies the channel", async () => {
    const { wrapper, registry } = await setup()
    load.mockRejectedValueOnce(new ApiError("missing anchor", 404, [COMMUNITY_CONVERSATION_ANCHOR_MISSING])).mockResolvedValue(conversationEntryFixture())
    const hook = renderHook(() => useMessages("c1", { serverId: "s1", anchorMessageId: "gone" }), { wrapper })
    await waitFor(() => expect(hook.result.current.entryCanRead).toBe(true))
    expect(hook.result.current.entryDenied).toBe(false)
    expect(hook.result.current.entryAnchorMissing).toBe(true)
    expect(hook.result.current.messages).toEqual([])
    expect(registry.collections.channels.has("c1")).toBe(true)
    expect(load.mock.calls.map(([url]) => url)).toEqual(["/api/community/channels/c1/messages?entry=1&anchor=gone", "/api/community/channels/c1/messages?entry=1"])
    hook.unmount()
  })
})
