import { createElement, type PropsWithChildren } from "react"
import { describe, expect, it, vi } from "vitest"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, dmConversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { ConversationReadTimeoutError } from "@/lib/community/conversation-read"
import { useDmMessages, useMessages } from "@/hooks/community/use-messages"
import { installMessageScrollFixture, resize, restoreMessageScrollFixture, scrollFixture } from "@/test/message-scroll-fixture"
import { MessageList } from "./message-list"

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
