import { createElement, type PropsWithChildren } from "react"
import { describe, expect, it, vi } from "vitest"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, dmConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { ConversationReadTimeoutError } from "@/lib/community/conversation-read"
import { useDmMessages, useMessages } from "@/hooks/community/use-messages"
import { installMessageScrollFixture, resize, restoreMessageScrollFixture, scrollFixture, runFrames, bodyTop } from "@/test/message-scroll-fixture"
import { MessageList } from "./message-list"
import { ingestMessages } from "@/lib/community-db/sync"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => load(...args) }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("./message-row", () => ({ MessageRow: () => createElement("div") }))
vi.mock("@/components/ui/number-ticker", () => ({ NumberTicker: ({ value }: { value: number }) => createElement("span", null, value) }))

describe("existing Retry button starts a bound positioning attempt", () => {
  it.each(["channel", "dm"] as const)("recovers a failed %s without remounting its scroller or replaying on background refetch", async kind => {
    const owner = await createCommunityQueryOwner()
    load.mockReset().mockRejectedValue(new ConversationReadTimeoutError())
    installMessageScrollFixture()
    let latest!: ReturnType<typeof useMessages>
    const useFeed = kind === "channel" ? () => useMessages("c1", { serverId: "s1" }) : () => useDmMessages("c1")
    function Surface() {
      const feed = useFeed()
      latest = feed
      return createElement(MessageList, {
        channel: "test", messages: feed.messages, loading: feed.isLoading, initialLoadError: feed.initialLoadError,
        onRetryInitialLoad: feed.retryInitialLoad, retryingInitialLoad: feed.retryingInitialLoad,
        positionEntry: feed.positionEntry, positionDataState: feed.positionDataState, messageWindow: feed.messageWindow,
        initialScrollReady: feed.initialPositionKnown, initialPositionMessageId: feed.initialPositionMessageId,
        onOpenThread: () => {},
      })
    }
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client }, createElement(CommunityDbProvider, { registry: owner.registry }, children))
    const view = render(createElement(Surface), { wrapper })
    const flush = async () => {
      for (let index = 0; index < 5; index++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(1) })
        resize()
      }
    }
    try {
      await flush()
      const root = view.getByTestId("community-message-scroller")
      expect(latest.positionDataState).toBe("error")
      const failed = latest.positionEntry
      const packet = kind === "channel" ? conversationEntryFixture() : dmConversationEntryFixture()
      packet.messages = Array.from({ length: 14 }, (_, index) => ({ ...packet.messages[0], id: `m${index + 1}`, seq: index + 1 }))
      packet.page = { ...packet.page, latestSeq: 14, hasMoreNewer: false }
      load.mockResolvedValue(packet)
      fireEvent.click(view.getByRole("button", { name: "Retry" }))
      await flush()
      expect(latest.positionEntry).not.toBe(failed)
      expect(latest.positionDataState).toBe("ready")
      expect(view.getByTestId("community-message-scroller")).toBe(root)
      expect(root.querySelector('[data-read-position-ready]')).toHaveAttribute("data-read-position-ready", "true")
      expect(root.scrollTop).toBe(root.scrollHeight - root.clientHeight)
      const attempt = latest.positionEntry
      const writes = scrollFixture.scrollCalls.length
      load.mockResolvedValue({ messages: packet.messages, latestSeq: 14, hasMoreOlder: false, hasMoreNewer: false })
      await act(async () => { await latest.refetch() })
      await flush()
      expect(latest.positionEntry).toBe(attempt)
      expect(scrollFixture.scrollCalls).toHaveLength(writes)
    } finally {
      view.unmount()
      restoreMessageScrollFixture()
    }
  })
})


describe("canonical peer arrival while reading a tall final body", () => {
  it.each(["channel", "dm"] as const)("preserves the real %s owner through upward idle and a live peer", async kind => {
    const owner = await createCommunityQueryOwner()
    const packet = kind === "channel" ? conversationEntryFixture() : dmConversationEntryFixture()
    packet.messages = Array.from({ length: 14 }, (_, index) => ({ ...packet.messages[0], id: `history${index}`, seq: index + 153 }))
    packet.page = { ...packet.page, latestSeq: 166, hasMoreNewer: false, hasMoreOlder: false, olderCursor: null }
    packet.newBoundary = { afterSeq: 166, target: null }
    packet.readState = { ...packet.readState, lastReadMessageId: "history13", lastReadSeq: 166 }
    await seedConversationEntry(owner.client, packet)
    load.mockReset().mockImplementation(() => new Promise(() => {}))
    installMessageScrollFixture()
    scrollFixture.height = 1161
    scrollFixture.width = 883
    scrollFixture.bodyHeights.set("history13", 2901)
    let latest!: ReturnType<typeof useMessages>
    const useFeed = kind === "channel" ? () => useMessages("c1", { serverId: "s1" }) : () => useDmMessages("c1")
    function Surface() {
      const feed = useFeed()
      latest = feed
      return createElement(MessageList, {
        channel: "test", viewerUserId: "viewer", messages: feed.messages, loading: feed.isLoading,
        initialLoadError: feed.initialLoadError, targetLoadError: feed.targetLoadError,
        positionEntry: feed.positionEntry, positionScope: feed.positionScope,
        positionDataState: feed.positionDataState, targetPositionDataState: feed.targetPositionDataState,
        messageWindow: feed.messageWindow, messageNeighborhood: feed.messageNeighborhood,
        onReadingMessage: feed.onReadingMessage, onUserTakeover: feed.onUserTakeover,
        initialScrollReady: feed.initialPositionKnown, initialPositionMessageId: feed.initialPositionMessageId,
        hasMore: feed.hasMore, historyStartKnown: feed.historyStartKnown, hasMoreNewer: feed.hasMoreNewer,
        isFetching: feed.isFetching, isFetchingOlder: feed.isFetchingOlder, isFetchingNewer: feed.isFetchingNewer,
        onLoadOlder: feed.fetchOlder, onLoadNewer: feed.fetchNewer,
        newBoundary: feed.newBoundary, latestSeq: feed.latestSeq, onReadNewBoundary: feed.readNewBoundary,
        presentVersion: feed.presentVersion, presentPending: feed.presentPending, presentRequest: feed.presentRequest,
        onJumpToPresent: feed.jumpToPresent, onOpenThread: () => {},
      })
    }
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: owner.client }, createElement(CommunityDbProvider, { registry: owner.registry }, children))
    const view = render(createElement(Surface), { wrapper })
    const flush = async () => {
      for (let index = 0; index < 5; index++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(1) })
        resize()
      }
    }
    try {
      await flush()
      const root = view.getByTestId("community-message-scroller")
      const entry = latest.positionEntry
      expect(latest.positionDataState).toBe("ready")
      fireEvent.wheel(root, { deltaY: -600 })
      act(() => root.scrollTo({ top: root.scrollHeight - root.clientHeight - 600 }))
      await flush()
      const before = root.scrollTop, body = bodyTop(root, "history13")
      await act(async () => { await vi.advanceTimersByTimeAsync(155470) })
      runFrames()
      expect(root.scrollTop).toBe(before)
      expect(bodyTop(root, "history13")).toBe(body)
      expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBe(600)
      const peer = { ...packet.messages.at(-1)!, id: "peer167", seq: 167 }
      await act(async () => {
        ingestMessages(owner.registry, "c1", [peer])
        owner.registry.runtime.messageStream.actions.dispatch(kind === "channel" ? { kind: "channel", id: "c1", serverId: "s1" } : { kind: "dm", id: "c1" }, { type: "wsMessage", message: peer })
      })
      await flush()
      expect(latest.messages.at(-1)?.id).toBe("peer167")
      expect(latest.positionEntry).toBe(entry)
      expect(view.getByTestId("community-message-scroller")).toBe(root)
      expect(Math.abs(root.scrollTop - before)).toBeLessThanOrEqual(1)
      expect(Math.abs(bodyTop(root, "history13") - body)).toBeLessThanOrEqual(1)
      expect(root.querySelector('[data-read-position-ready]')).toHaveAttribute("data-read-position-ready", "true")
    } finally {
      view.unmount()
      restoreMessageScrollFixture()
    }
  })
})
