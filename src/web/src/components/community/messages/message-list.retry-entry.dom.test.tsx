import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CommunityWsEventSchema } from "@alook/shared"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, dmConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { ConversationReadTimeoutError } from "@/lib/community/conversation-read"
import { useDmMessages, useMessages } from "@/hooks/community/use-messages"
import { installMessageScrollFixture, resize, restoreMessageScrollFixture, scrollFixture, runFrames, bodyTop } from "@/test/message-scroll-fixture"
import { MessageList } from "./message-list"
import { captureCommunityLiveSnapshotToken, ingestMessages, publishAccountAttentionSnapshot } from "@/lib/community-db/sync"
import { resourceBundleFixture } from "@/test/community-resource-fixtures"
import { dispatchCommunityWsEvent } from "@/hooks/community/community-ws/registry"

const load = vi.hoisted(() => vi.fn())
const rowBoundary = vi.hoisted(() => ({ real: false }))
beforeEach(() => { rowBoundary.real = false })
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => load(...args) }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("./message-row", async original => {
  const { MessageRow } = await original<typeof import("./message-row")>()
  return { MessageRow: (props: import("./message-row").MessageRowProps) => rowBoundary.real ? createElement(MessageRow, props) : createElement("div") }
})
vi.mock("@/components/ui/number-ticker", () => ({ NumberTicker: ({ value }: { value: number }) => createElement("span", null, value) }))

async function flushPeerUpdates() {
  for (let index = 0; index < 5; index++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    resize(5)
  }
}

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
    try {
      await flushPeerUpdates()
      const root = view.getByTestId("community-message-scroller")
      const entry = latest.positionEntry
      expect(latest.positionDataState).toBe("ready")
      fireEvent.wheel(root, { deltaY: -600 })
      act(() => root.scrollTo({ top: root.scrollHeight - root.clientHeight - 600 }))
      await flushPeerUpdates()
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
      await flushPeerUpdates()
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


describe("consecutive live peers preserve the reading body", () => {
  const unchangedCases = (["channel", "dm"] as const).flatMap(kind =>
    (["direct", "separate", "ws", "ws-turn"] as const).flatMap(publication =>
      [14, 150].flatMap(historyCount =>
        (publication.startsWith("ws") ? [false, true] : [false]).flatMap(realRows =>
          (publication === "ws-turn" && realRows && historyCount === 150 ? [false, true] : [false])
            .map(cold => ({ kind, publication, historyCount, realRows, cold, nonceTransition: "unchanged" as const })),
        ),
      ),
    ),
  )
  const cases = [...unchangedCases, ...(["channel", "dm"] as const).flatMap(kind =>
    (["remove", "add", "replace", "api-read"] as const).map(nonceTransition => ({
      kind, publication: "ws-turn" as const, historyCount: 150, realRows: true, cold: false, nonceTransition,
    })),
  )]
  it.each(cases)("retains the live $kind body with $publication publication and $historyCount history rows, real rows=$realRows, cold=$cold, nonce=$nonceTransition", async ({ kind, publication, historyCount, realRows, cold, nonceTransition }) => {
    rowBoundary.real = realRows
    const owner = cold ? (() => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
      const registry = createCommunityDbRegistry(client, "viewer")
      return { client, registry, runtime: registry.runtime }
    })() : await createCommunityQueryOwner()
    const packet = kind === "channel" ? conversationEntryFixture() : dmConversationEntryFixture()
    packet.messages = Array.from({ length: historyCount }, (_, index) => ({ ...packet.messages[0], id: `history${index}`, seq: index + 168 - historyCount }))
    packet.page = { ...packet.page, latestSeq: 167, hasMoreNewer: false, hasMoreOlder: false, olderCursor: null }
    packet.newBoundary = { afterSeq: 167, target: null }
    packet.readState = { ...packet.readState, lastReadMessageId: `history${historyCount - 1}`, lastReadSeq: 167 }
    await seedConversationEntry(owner.client, packet)
    load.mockReset().mockImplementation(() => new Promise(() => {}))
    installMessageScrollFixture()
    scrollFixture.height = 1161
    scrollFixture.width = 883
    scrollFixture.bodyHeights.set("live168", 2901.421875)
    scrollFixture.bodyHeights.set("peer169", 24)
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
    const scope = kind === "channel" ? { kind: "channel" as const, id: "c1", serverId: "s1" } : { kind: "dm" as const, id: "c1" }
    const publish = async (message: typeof packet.messages[number]) => {
      if (publication === "ws" || publication === "ws-turn") {
        owner.runtime.ui.actions.setCurrentServerId(kind === "channel" ? "s1" : null)
        const dispatch = () => dispatchCommunityWsEvent(CommunityWsEventSchema.parse({
          type: "community:message.create", channelId: "c1", ...(kind === "channel" ? { serverId: "s1" } : {}),
          message: { ...message, authorName: packet.profiles[0].name, authorAvatarVersion: packet.profiles[0].avatarVersion }, profiles: packet.profiles,
        }), { queryClient: owner.client, communityStore: owner.runtime.ui, wsStore: owner.runtime.ws,
          deliveryMode: "single", sub: kind === "channel" ? { channelId: "c1" } : { dmConversationId: "c1" },
          viewerUserIdRef: { current: "viewer" }, matchesFocus: () => true })
        if (publication === "ws-turn") {
          let pending: ReturnType<typeof dispatch>
          act(() => { pending = dispatch() })
          await act(async () => { await vi.advanceTimersByTimeAsync(1) })
          resize()
          await act(async () => { await pending })
        } else await act(async () => { await dispatch() })
      } else if (publication === "separate") {
        act(() => { ingestMessages(owner.registry, "c1", [message]) })
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })
        act(() => { owner.registry.runtime.messageStream.actions.dispatch(scope, { type: "wsMessage", message }) })
      } else await act(async () => {
        ingestMessages(owner.registry, "c1", [message])
        owner.registry.runtime.messageStream.actions.dispatch(scope, { type: "wsMessage", message })
      })
      await flushPeerUpdates()
    }
    try {
      await flushPeerUpdates()
      const root = view.getByTestId("community-message-scroller")
      const entry = latest.positionEntry
      expect(latest.positionDataState).toBe("ready")
      const tall = { ...packet.messages.at(-1)!, id: "live168", seq: 168,
        clientNonce: nonceTransition === "add" ? null : "00000000-0000-4000-8000-000000000168", createdAt: "2026-10-01T01:00:00.000Z" }
      await publish(tall)
      expect(latest.messages.at(-1)?.id).toBe("live168")
      expect(Math.abs(root.scrollHeight - root.clientHeight - root.scrollTop)).toBeLessThanOrEqual(1)
      const originalBody = root.querySelector('[data-msg-id="live168"]')!
      expect(originalBody).not.toBeNull()
      fireEvent.wheel(root, { deltaY: -600 })
      act(() => root.scrollTo({ top: root.scrollHeight - root.clientHeight - 600 }))
      await flushPeerUpdates()
      const before = root.scrollTop, body = bodyTop(root, "live168")
      await act(async () => { await vi.advanceTimersByTimeAsync(233013) })
      runFrames()
      expect(root.scrollTop).toBe(before)
      expect(bodyTop(root, "live168")).toBe(body)
      expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBe(600)
      expect(root.querySelector('[data-msg-id="live168"]')).toBe(originalBody)
      const peer = { ...tall, id: "peer169", seq: 169,
        clientNonce: "00000000-0000-4000-8000-000000000169", createdAt: "2026-10-01T01:03:53.013Z" }
      if (nonceTransition === "api-read") {
        await act(async () => publishAccountAttentionSnapshot(owner.client, {
          snapshot: {
            resources: resourceBundleFixture(),
            scopes: [{ scopeId: "c1", channelId: "c1", serverId: kind === "channel" ? "s1" : null, ordinaryUnread: true,
              lastUnreadSeq: 170, lastAttentionSeq: null, attentionCount: 0 }],
            items: [], limit: 100, truncated: false,
            included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
          },
          proof: { token: captureCommunityLiveSnapshotToken(owner.client), signal: undefined },
        }))
        load.mockResolvedValue({ ...packet,
          messages: [...packet.messages.slice(-48), { ...tall, clientNonce: null }, { ...peer, clientNonce: null }],
          page: { ...packet.page, latestSeq: 169, hasMoreOlder: true, olderCursor: `${packet.messages.at(-48)!.createdAt}|${packet.messages.at(-48)!.id}` },
          newBoundary: { afterSeq: 168, target: { id: "peer169", channelId: "c1", authorId: peer.authorId, seq: 169 } },
          readState: { ...packet.readState, lastReadMessageId: "live168", lastReadSeq: 168, lastReadAt: tall.createdAt }, readStateRevision: 5,
        })
      } else if (nonceTransition !== "unchanged") act(() => {
        ingestMessages(owner.registry, "c1", [{ ...tall,
          clientNonce: nonceTransition === "remove" ? null : "00000000-0000-4000-8000-000000000268" }])
      })
      await publish(peer)
      await flushPeerUpdates()
      expect(latest.messages.at(-1)?.id).toBe("peer169")
      if (nonceTransition === "api-read") {
        expect(load.mock.calls.some(([url]) => String(url).includes("newAfterSeq=168"))).toBe(true)
        expect(owner.client.getQueryCache().getAll().flatMap(query => query.state.error ? [String(query.state.error)] : [])).toEqual([])
        expect(owner.registry.collections.messages.get("live168")?.clientNonce).toBeNull()
      }
      expect(latest.positionEntry).toBe(entry)
      expect(view.getByTestId("community-message-scroller")).toBe(root)
      expect.soft(root.querySelector('[data-msg-id="live168"]')).toBe(originalBody)
      expect.soft(originalBody.isConnected).toBe(true)
      expect.soft(Math.abs(root.scrollTop - before)).toBeLessThanOrEqual(1)
      expect.soft(Math.abs(bodyTop(root, "live168") - body)).toBeLessThanOrEqual(1)
      expect(root.querySelector('[data-read-position-ready]')).toHaveAttribute("data-read-position-ready", "true")
    } finally {
      view.unmount()
      if (cold) {
        await act(async () => { await owner.registry.cleanup() })
        owner.client.clear()
      }
      restoreMessageScrollFixture()
    }
  })
})
