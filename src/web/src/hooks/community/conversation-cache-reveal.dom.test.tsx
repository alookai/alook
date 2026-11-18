import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createElement, useCallback } from "react"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, dmConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { messageReadPageFixture, singleMessageReadFixture } from "@/test/community-resource-fixtures"
import { ingestReadStateSnapshot } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { MessageList } from "@/components/community/messages/message-list"
import { ConversationFooterShell, ConversationFooterSlotProvider } from "@/components/community/messages/conversation-footer-shell"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { dehydrate, hashKey } from "@tanstack/react-query"
import { PERSIST_BUSTER, readCommunityRestoredCollections } from "@/lib/query-persister"
import { restoreConversationDisplayWindows } from "@/lib/community/restored-conversation-window"
import { useDmMessages, useMessages } from "./use-messages"
import { messageQueryFn } from "./use-message"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize, resizeMeasureBeforeScroll, runFrames, scrollFixture } from "@/test/message-scroll-fixture"
import type { MessageWindowData } from "@/lib/community/message-window"

type ScrollResult = ReturnType<typeof import("./use-scroll-anchor").useScrollAnchor>
const preCommand = vi.hoisted(() => ({
  latest: null as unknown,
  finishes: [] as Array<{ kind: string; entry?: object | null; reason: string; source?: string }>,
}))
vi.mock("./use-scroll-anchor", async original => {
  const actual = await original<typeof import("./use-scroll-anchor")>()
  return { ...actual, useScrollAnchor: (...args: Parameters<typeof actual.useScrollAnchor>) => {
    const result = actual.useScrollAnchor(...args)
    preCommand.latest = result
    return result
  } }
})
vi.mock("@/lib/observability/position", async original => {
  const actual = await original<typeof import("@/lib/observability/position")>()
  return { ...actual, beginPositionObservation: (...args: Parameters<typeof actual.beginPositionObservation>) => {
    const finish = actual.beginPositionObservation(...args)
    let observed = false
    return (...end: Parameters<typeof finish>) => {
      if (!observed) preCommand.finishes.push({ kind: args[0], entry: args[2], reason: end[0], source: end[1]?.position_source })
      observed = true
      return finish(...end)
    }
  } }
})

const load = vi.hoisted(() => vi.fn())
const commitGate = vi.hoisted(() => ({ hold: false, publish: undefined as (() => void) | undefined }))
vi.mock("@/components/community/messages/virtual-cursor-list", async original => {
  const actual = await original<typeof import("@/components/community/messages/virtual-cursor-list")>()
  return { ...actual, VirtualRows: function HeldCommitRows(props: Parameters<typeof actual.VirtualRows>[0]) {
    const { onLayoutCommit } = props
    const commit = useCallback<NonNullable<typeof props.onLayoutCommit>>(layout => {
      if (commitGate.hold && layout) commitGate.publish = () => onLayoutCommit?.(layout)
      else onLayoutCommit?.(layout)
    }, [onLayoutCommit])
    return createElement(actual.VirtualRows, { ...props, onLayoutCommit: commit })
  } }
})
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: load }))
beforeEach(() => { installMessageScrollFixture(); load.mockReset(); preCommand.latest = null; preCommand.finishes = []; commitGate.hold = false; commitGate.publish = undefined })
afterEach(restoreMessageScrollFixture)
const kinds = ["text", "text-thread", "forum-post", "dm"] as const

it.each(["no-movement", "offset-before-event"] as const)("keeps far real DM movement beyond old committed rows before native scroll delivery with %s", async order => {
  scrollFixture.width = 390
  const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const base = dmConversationEntryFixture()
  const rows = Array.from({ length: 80 }, (_, index) => ({ ...base.messages[0], id: `r16-${index + 1}`, seq: index + 1,
    content: `reading ${index}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString() }))
  const cursor = `${rows[49].createdAt}|${rows[49].id}`
  const tail = { ...base, channel: { ...base.channel, messageCount: 80 }, messages: rows.slice(49),
    readState: { ...base.readState, lastReadMessageId: rows[79].id, lastReadSeq: 80, lastReadAt: rows[79].createdAt }, newBoundary: { afterSeq: 80, target: null },
    page: { olderCursor: cursor, newerCursor: null, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 80 } }
  await seedConversationEntry(owner.client, tail)
  const requests: string[] = []
  const ordering: Array<{ phase: string; type: string; offset: number; at: number }> = []
  let oldCommittedBodies: Array<{ id: string; start: number; end: number }> = []
  let currentBodyId: string | undefined
  let scrollRoot: HTMLElement | undefined
  const recordNativeScroll = () => ordering.push({ phase, type: "native-scroll", offset: scrollRoot!.scrollTop, at: performance.now() })
  const recordWheel = () => ordering.push({ phase, type: "wheel", offset: scrollRoot!.scrollTop, at: performance.now() })
  let updated = false
  load.mockImplementation((url: string) => {
    requests.push(url)
    if (url === `/api/community/messages/${rows[0].id}`) {
      updated = true
      return Promise.resolve(singleMessageReadFixture({ ...rows[0], content: "updated 0" }))
    }
    const search = new URL(url, "https://test.invalid").searchParams
    if (search.has("entry")) return Promise.resolve(tail)
    if (search.get("cursor") === cursor) return Promise.resolve(messageReadPageFixture({ messages: rows.slice(0, 49), hasMoreOlder: false, hasMoreNewer: true, newerCursor: `${rows[48].createdAt}|${rows[48].id}`, latestSeq: 80 }))
    throw new Error(`Unexpected consumed DM publication read: ${url}`)
  })
  const href = "/c/me/c1", intent = { href }
  const navigation = { entryIntent: intent, publishedHref: href, pendingHref: null, navigationPending: false }
  let feed!: ReturnType<typeof useDmMessages>
  let phase = "setup"
  const readings: Array<{ phase: string; id: string }> = []
  function Probe() {
    feed = useDmMessages("c1", { viewerUserId: "viewer" })
    return <ConversationFooterSlotProvider><div data-slot="community-conversation-surface"><MessageList channel="DM" variant="dm"
      messages={feed.messages} loading={feed.isLoading} initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
      initialScrollReady={feed.initialDisplayReady} preserveInitialPresentation={feed.preserveInitialPresentation}
      initialPositionMessageId={feed.initialPositionMessageId} positionScope={feed.positionScope} positionEntry={feed.positionEntry}
      positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
      messageNeighborhood={feed.messageNeighborhood} onReadingMessage={id => { readings.push({ phase, id }); feed.onReadingMessage(id) }}
      newDividerBefore={feed.newBoundary?.target?.id} newBoundary={feed.newBoundary} latestSeq={feed.latestSeq}
      retiredNewTargetId={feed.retiredNewTargetId} onLoadNewTarget={feed.loadNewTarget} onReadNewBoundary={feed.readNewBoundary}
      hasMore={feed.hasMoreOlder} hasMoreNewer={feed.hasMoreNewer} historyStartKnown={feed.historyStartKnown}
      isFetching={feed.isFetching} isFetchingOlder={feed.isFetchingOlder} isFetchingNewer={feed.isFetchingNewer}
      onLoadOlder={feed.fetchOlder} onLoadNewer={feed.fetchNewer} onUserTakeover={feed.onUserTakeover}
      active positioningActive onOpenThread={() => {}} />
      <ConversationFooterShell><textarea aria-label="Draft" /></ConversationFooterShell>
    </div></ConversationFooterSlotProvider>
  }
  const view = render(<CommunityTestProvider {...owner}><CommunityRouteContext value={{ breakpoint: "mobile", navigation } as never}><Probe /></CommunityRouteContext></CommunityTestProvider>)
  const settle = async () => { for (let frame = 0; frame < 6; frame++) { resize(); await act(async () => { await vi.advanceTimersByTimeAsync(0) }) } }
  const visibleBody = (root: HTMLElement) => {
    const viewport = root.getBoundingClientRect()
    return [...root.querySelectorAll<HTMLElement>("[data-msg-id]")].find(body => { const rect = body.getBoundingClientRect(); return Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top) > 1 })
  }
  const publishRows = () => {
    const publish = commitGate.publish
    expect(publish).toBeDefined()
    commitGate.hold = false
    act(() => publish?.())
  }
  try {
    await settle()
    const root = view.getByTestId("community-message-scroller")
    const entry = feed.positionEntry
    const query = owner.client.getQueryCache().find({ queryKey: communityKeys.channelMessages("c1"), exact: true })!
    expect(query).toBeDefined()
    if (feed.hasMoreOlder) {
      const older = feed.fetchOlder()
      expect(older.accepted).toBe(true)
      if (!older.accepted) throw new Error("The actual DM older controller must admit the setup read")
      await act(async () => { expect(await older.completed).toMatchObject({ status: "success" }); await vi.advanceTimersByTimeAsync(0) })
      await settle()
    }
    expect(feed.messages).toHaveLength(80)
    expect((query.state.data as MessageWindowData).pages).toHaveLength(2)
    phase = "first-manual"
    readings.length = 0
    commitGate.hold = true
    fireEvent.wheel(root, { deltaY: -root.scrollHeight })
    act(() => root.scrollTo({ top: 0 }))
    runFrames(1)
    runFrames(40)
    expect(readings).toHaveLength(0)
    phase = "first-commit"
    publishRows()
    runFrames(2)
    await settle()
    expect(readings).toEqual([{ phase: "first-commit", id: rows[0].id }])
    expect(feed.messageNeighborhood!.page).toMatchObject({ query, key: hashKey([(query.state.data as MessageWindowData).pageParams[1]]) })
    const before = { offset: root.scrollTop, height: root.scrollHeight, count: readings.length, messages: feed.messages, window: feed.messageWindow }
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "true")
    const oldViewport = root.getBoundingClientRect()
    oldCommittedBodies = [...root.querySelectorAll<HTMLElement>("[data-msg-id]")].map(body => {
      const rect = body.getBoundingClientRect()
      return { id: body.dataset.msgId!, start: rect.top - oldViewport.top + root.scrollTop, end: rect.bottom - oldViewport.top + root.scrollTop }
    })
    expect(oldCommittedBodies.length).toBeGreaterThan(0)
    expect(5000).toBeGreaterThan(Math.max(...oldCommittedBodies.map(body => body.end)))
    expect(root.scrollHeight - root.clientHeight - 5000).toBeGreaterThan(root.clientHeight)
    scrollRoot = root
    root.addEventListener("scroll", recordNativeScroll)
    root.addEventListener("wheel", recordWheel)
    phase = "second-http-publication"
    commitGate.hold = true
    await act(async () => { await owner.client.query({ queryKey: communityKeys.message(rows[0].id), queryFn: messageQueryFn(rows[0].id, owner.client, "c1"), staleTime: 0, select: undefined }); await vi.advanceTimersByTimeAsync(0) })
    expect(updated).toBe(true)
    expect(owner.registry.collections.messages.get(rows[0].id)?.content).toBe("updated 0")
    expect(feed.messages.find(message => message.id === rows[0].id)?.content).toBe("updated 0")
    expect(feed.messages).not.toBe(before.messages)
    expect(root.querySelector(`[data-msg-id="${rows[0].id}"]`)).toHaveTextContent("updated 0")
    expect(ordering).toEqual([])
    expect([...root.querySelectorAll<HTMLElement>("[data-msg-id]")].map(body => body.dataset.msgId)).toEqual(oldCommittedBodies.map(body => body.id))
    if (order === "offset-before-event") {
      phase = "physical-move-before-commit"
      act(() => root.scrollTo({ top: 5000 }))
      expect(root.scrollTop).toBe(5000)
      expect(visibleBody(root)).toBeUndefined()
      ordering.push({ phase, type: "physical-move", offset: root.scrollTop, at: performance.now() })
      expect(ordering.filter(event => event.type === "native-scroll" || event.type === "wheel")).toEqual([])
    }
    phase = "second-commit-before-native-scroll"
    publishRows()
    ordering.push({ phase, type: "real-commit-return", offset: root.scrollTop, at: performance.now() })
    expect(ordering.filter(event => event.type === "native-scroll" || event.type === "wheel")).toEqual([])
    if (order === "offset-before-event") expect(visibleBody(root)).toBeUndefined()
    expect(readings).toHaveLength(before.count)
    expect(root.scrollTop).toBe(order === "offset-before-event" ? 5000 : before.offset)
    expect(root.scrollHeight).toBe(before.height)
    expect(view.getByTestId("community-message-scroller")).toBe(root)
    expect(feed.positionEntry).toBe(entry)
    expect(owner.client.getQueryCache().find({ queryKey: query.queryKey, exact: true })).toBe(query)
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "true")
    phase = "native-event-delivery"
    await settle()
    if (order === "no-movement") {
      expect(ordering.map(event => event.type)).toEqual(["real-commit-return"])
      expect(readings).toHaveLength(before.count)
      phase = "fresh-gesture-after-still-control"
      fireEvent.wheel(root, { deltaY: 5000 })
      act(() => root.scrollTo({ top: 5000 }))
      await settle()
    } else {
      expect(ordering.map(event => event.type)).toEqual(["physical-move", "real-commit-return", "native-scroll"])
      expect(ordering.at(-1)).toMatchObject({ phase, offset: 5000 })
    }
    const body = visibleBody(root)
    expect(body).toBeDefined()
    currentBodyId = body!.dataset.msgId
    expect(currentBodyId).not.toBe(rows[0].id)
    expect(oldCommittedBodies.map(body => body.id)).not.toContain(currentBodyId)
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "true")
    expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeGreaterThan(root.clientHeight)
    expect(root.scrollTop).toBe(5000)
    expect(readings).toHaveLength(before.count + 1)
    expect(readings.at(-1)).toEqual({ phase, id: body!.dataset.msgId })
  } finally {
    console.info("dm-far-offset-commit-native-order", JSON.stringify({ order, updated, phase, readings, requests, ordering, oldCommittedBodies, currentBodyId }))
    scrollRoot?.removeEventListener("scroll", recordNativeScroll)
    scrollRoot?.removeEventListener("wheel", recordWheel)
    commitGate.hold = false
    view.unmount()
    owner.client.clear()
  }
})

it.each(["no-movement", "offset-before-event"] as const)("keeps real DM movement before the second producer commit and native scroll delivery with %s", async order => {
  scrollFixture.width = 390
  const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const base = dmConversationEntryFixture()
  const rows = Array.from({ length: 80 }, (_, index) => ({ ...base.messages[0], id: `r14-${index + 1}`, seq: index + 1,
    content: `reading ${index}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString() }))
  const cursor = `${rows[49].createdAt}|${rows[49].id}`
  const tail = { ...base, channel: { ...base.channel, messageCount: 80 }, messages: rows.slice(49),
    readState: { ...base.readState, lastReadMessageId: rows[79].id, lastReadSeq: 80, lastReadAt: rows[79].createdAt }, newBoundary: { afterSeq: 80, target: null },
    page: { olderCursor: cursor, newerCursor: null, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 80 } }
  await seedConversationEntry(owner.client, tail)
  const requests: string[] = []
  const ordering: Array<{ phase: string; type: string; offset: number; at: number }> = []
  let scrollRoot: HTMLElement | undefined
  const recordNativeScroll = () => ordering.push({ phase, type: "native-scroll", offset: scrollRoot!.scrollTop, at: performance.now() })
  const recordWheel = () => ordering.push({ phase, type: "wheel", offset: scrollRoot!.scrollTop, at: performance.now() })
  let updated = false
  load.mockImplementation((url: string) => {
    requests.push(url)
    if (url === `/api/community/messages/${rows[0].id}`) {
      updated = true
      return Promise.resolve(singleMessageReadFixture({ ...rows[0], content: "updated 0" }))
    }
    const search = new URL(url, "https://test.invalid").searchParams
    if (search.has("entry")) return Promise.resolve(tail)
    if (search.get("cursor") === cursor) return Promise.resolve(messageReadPageFixture({ messages: rows.slice(0, 49), hasMoreOlder: false, hasMoreNewer: true, newerCursor: `${rows[48].createdAt}|${rows[48].id}`, latestSeq: 80 }))
    throw new Error(`Unexpected consumed DM publication read: ${url}`)
  })
  const href = "/c/me/c1", intent = { href }
  const navigation = { entryIntent: intent, publishedHref: href, pendingHref: null, navigationPending: false }
  let feed!: ReturnType<typeof useDmMessages>
  let phase = "setup"
  const readings: Array<{ phase: string; id: string }> = []
  function Probe() {
    feed = useDmMessages("c1", { viewerUserId: "viewer" })
    return <ConversationFooterSlotProvider><div data-slot="community-conversation-surface"><MessageList channel="DM" variant="dm"
      messages={feed.messages} loading={feed.isLoading} initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
      initialScrollReady={feed.initialDisplayReady} preserveInitialPresentation={feed.preserveInitialPresentation}
      initialPositionMessageId={feed.initialPositionMessageId} positionScope={feed.positionScope} positionEntry={feed.positionEntry}
      positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
      messageNeighborhood={feed.messageNeighborhood} onReadingMessage={id => { readings.push({ phase, id }); feed.onReadingMessage(id) }}
      newDividerBefore={feed.newBoundary?.target?.id} newBoundary={feed.newBoundary} latestSeq={feed.latestSeq}
      retiredNewTargetId={feed.retiredNewTargetId} onLoadNewTarget={feed.loadNewTarget} onReadNewBoundary={feed.readNewBoundary}
      hasMore={feed.hasMoreOlder} hasMoreNewer={feed.hasMoreNewer} historyStartKnown={feed.historyStartKnown}
      isFetching={feed.isFetching} isFetchingOlder={feed.isFetchingOlder} isFetchingNewer={feed.isFetchingNewer}
      onLoadOlder={feed.fetchOlder} onLoadNewer={feed.fetchNewer} onUserTakeover={feed.onUserTakeover}
      active positioningActive onOpenThread={() => {}} />
      <ConversationFooterShell><textarea aria-label="Draft" /></ConversationFooterShell>
    </div></ConversationFooterSlotProvider>
  }
  const view = render(<CommunityTestProvider {...owner}><CommunityRouteContext value={{ breakpoint: "mobile", navigation } as never}><Probe /></CommunityRouteContext></CommunityTestProvider>)
  const settle = async () => { for (let frame = 0; frame < 6; frame++) { resize(); await act(async () => { await vi.advanceTimersByTimeAsync(0) }) } }
  const visibleBody = (root: HTMLElement) => {
    const viewport = root.getBoundingClientRect()
    return [...root.querySelectorAll<HTMLElement>("[data-msg-id]")].find(body => { const rect = body.getBoundingClientRect(); return Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top) > 1 })
  }
  const publishRows = () => {
    const publish = commitGate.publish
    expect(publish).toBeDefined()
    commitGate.hold = false
    act(() => publish?.())
  }
  try {
    await settle()
    const root = view.getByTestId("community-message-scroller")
    const entry = feed.positionEntry
    const query = owner.client.getQueryCache().find({ queryKey: communityKeys.channelMessages("c1"), exact: true })!
    expect(query).toBeDefined()
    if (feed.hasMoreOlder) {
      const older = feed.fetchOlder()
      expect(older.accepted).toBe(true)
      if (!older.accepted) throw new Error("The actual DM older controller must admit the setup read")
      await act(async () => { expect(await older.completed).toMatchObject({ status: "success" }); await vi.advanceTimersByTimeAsync(0) })
      await settle()
    }
    expect(feed.messages).toHaveLength(80)
    expect((query.state.data as MessageWindowData).pages).toHaveLength(2)
    phase = "first-manual"
    readings.length = 0
    commitGate.hold = true
    fireEvent.wheel(root, { deltaY: -root.scrollHeight })
    act(() => root.scrollTo({ top: 0 }))
    runFrames(1)
    runFrames(40)
    expect(readings).toHaveLength(0)
    phase = "first-commit"
    publishRows()
    runFrames(2)
    await settle()
    expect(readings).toEqual([{ phase: "first-commit", id: rows[0].id }])
    expect(feed.messageNeighborhood!.page).toMatchObject({ query, key: hashKey([(query.state.data as MessageWindowData).pageParams[1]]) })
    const before = { offset: root.scrollTop, height: root.scrollHeight, count: readings.length, messages: feed.messages, window: feed.messageWindow }
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "true")
    scrollRoot = root
    root.addEventListener("scroll", recordNativeScroll)
    root.addEventListener("wheel", recordWheel)
    phase = "second-http-publication"
    commitGate.hold = true
    await act(async () => { await owner.client.query({ queryKey: communityKeys.message(rows[0].id), queryFn: messageQueryFn(rows[0].id, owner.client, "c1"), staleTime: 0, select: undefined }); await vi.advanceTimersByTimeAsync(0) })
    expect(updated).toBe(true)
    expect(owner.registry.collections.messages.get(rows[0].id)?.content).toBe("updated 0")
    expect(feed.messages.find(message => message.id === rows[0].id)?.content).toBe("updated 0")
    expect(feed.messages).not.toBe(before.messages)
    expect(root.querySelector(`[data-msg-id="${rows[0].id}"]`)).toHaveTextContent("updated 0")
    expect(ordering).toEqual([])
    if (order === "offset-before-event") {
      phase = "physical-move-before-commit"
      act(() => root.scrollTo({ top: 500 }))
      expect(root.scrollTop).toBe(500)
      ordering.push({ phase, type: "physical-move", offset: root.scrollTop, at: performance.now() })
      expect(ordering.filter(event => event.type === "native-scroll" || event.type === "wheel")).toEqual([])
    }
    phase = "second-commit-before-native-scroll"
    publishRows()
    ordering.push({ phase, type: "real-commit-return", offset: root.scrollTop, at: performance.now() })
    expect(ordering.filter(event => event.type === "native-scroll" || event.type === "wheel")).toEqual([])
    expect(readings).toHaveLength(before.count)
    expect(root.scrollTop).toBe(order === "offset-before-event" ? 500 : before.offset)
    expect(root.scrollHeight).toBe(before.height)
    expect(view.getByTestId("community-message-scroller")).toBe(root)
    expect(feed.positionEntry).toBe(entry)
    expect(owner.client.getQueryCache().find({ queryKey: query.queryKey, exact: true })).toBe(query)
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "true")
    phase = "native-event-delivery"
    await settle()
    if (order === "no-movement") {
      expect(ordering.map(event => event.type)).toEqual(["real-commit-return"])
      expect(readings).toHaveLength(before.count)
      phase = "fresh-gesture-after-still-control"
      fireEvent.wheel(root, { deltaY: 500 })
      act(() => root.scrollTo({ top: 500 }))
      await settle()
    } else {
      expect(ordering.map(event => event.type)).toEqual(["physical-move", "real-commit-return", "native-scroll"])
      expect(ordering.at(-1)).toMatchObject({ phase, offset: 500 })
    }
    const body = visibleBody(root)
    expect(body).toBeDefined()
    expect(body!.dataset.msgId).not.toBe(rows[0].id)
    expect(root.scrollTop).toBe(500)
    expect(readings).toHaveLength(before.count + 1)
    expect(readings.at(-1)).toEqual({ phase, id: body!.dataset.msgId })
  } finally {
    console.info("dm-offset-commit-native-order", JSON.stringify({ order, updated, phase, readings, requests, ordering }))
    scrollRoot?.removeEventListener("scroll", recordNativeScroll)
    scrollRoot?.removeEventListener("wheel", recordWheel)
    commitGate.hold = false
    view.unmount()
    owner.client.clear()
  }
})

it.each(["no-movement", "same-gesture", "fresh-wheel"] as const)("continues an already-consumed DM reading after a second exact-message HTTP publication with %s", async order => {
  scrollFixture.width = 390
  const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const base = dmConversationEntryFixture()
  const rows = Array.from({ length: 80 }, (_, index) => ({ ...base.messages[0], id: `r12-${index + 1}`, seq: index + 1,
    content: `reading ${index}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString() }))
  const cursor = `${rows[49].createdAt}|${rows[49].id}`
  const tail = { ...base, channel: { ...base.channel, messageCount: 80 }, messages: rows.slice(49),
    readState: { ...base.readState, lastReadMessageId: rows[79].id, lastReadSeq: 80, lastReadAt: rows[79].createdAt }, newBoundary: { afterSeq: 80, target: null },
    page: { olderCursor: cursor, newerCursor: null, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 80 } }
  await seedConversationEntry(owner.client, tail)
  const requests: string[] = []
  let updated = false
  load.mockImplementation((url: string) => {
    requests.push(url)
    if (url === `/api/community/messages/${rows[0].id}`) {
      updated = true
      return Promise.resolve(singleMessageReadFixture({ ...rows[0], content: "updated 0" }))
    }
    const search = new URL(url, "https://test.invalid").searchParams
    if (search.has("entry")) return Promise.resolve(tail)
    if (search.get("cursor") === cursor) return Promise.resolve(messageReadPageFixture({ messages: rows.slice(0, 49), hasMoreOlder: false, hasMoreNewer: true, newerCursor: `${rows[48].createdAt}|${rows[48].id}`, latestSeq: 80 }))
    throw new Error(`Unexpected consumed DM publication read: ${url}`)
  })
  const href = "/c/me/c1", intent = { href }
  const navigation = { entryIntent: intent, publishedHref: href, pendingHref: null, navigationPending: false }
  let feed!: ReturnType<typeof useDmMessages>
  let phase = "setup"
  const readings: Array<{ phase: string; id: string }> = []
  function Probe() {
    feed = useDmMessages("c1", { viewerUserId: "viewer" })
    return <ConversationFooterSlotProvider><div data-slot="community-conversation-surface"><MessageList channel="DM" variant="dm"
      messages={feed.messages} loading={feed.isLoading} initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
      initialScrollReady={feed.initialDisplayReady} preserveInitialPresentation={feed.preserveInitialPresentation}
      initialPositionMessageId={feed.initialPositionMessageId} positionScope={feed.positionScope} positionEntry={feed.positionEntry}
      positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
      messageNeighborhood={feed.messageNeighborhood} onReadingMessage={id => { readings.push({ phase, id }); feed.onReadingMessage(id) }}
      newDividerBefore={feed.newBoundary?.target?.id} newBoundary={feed.newBoundary} latestSeq={feed.latestSeq}
      retiredNewTargetId={feed.retiredNewTargetId} onLoadNewTarget={feed.loadNewTarget} onReadNewBoundary={feed.readNewBoundary}
      hasMore={feed.hasMoreOlder} hasMoreNewer={feed.hasMoreNewer} historyStartKnown={feed.historyStartKnown}
      isFetching={feed.isFetching} isFetchingOlder={feed.isFetchingOlder} isFetchingNewer={feed.isFetchingNewer}
      onLoadOlder={feed.fetchOlder} onLoadNewer={feed.fetchNewer} onUserTakeover={feed.onUserTakeover}
      active positioningActive onOpenThread={() => {}} />
      <ConversationFooterShell><textarea aria-label="Draft" /></ConversationFooterShell>
    </div></ConversationFooterSlotProvider>
  }
  const view = render(<CommunityTestProvider {...owner}><CommunityRouteContext value={{ breakpoint: "mobile", navigation } as never}><Probe /></CommunityRouteContext></CommunityTestProvider>)
  const settle = async () => { for (let frame = 0; frame < 6; frame++) { resize(); await act(async () => { await vi.advanceTimersByTimeAsync(0) }) } }
  const visibleBody = (root: HTMLElement) => {
    const viewport = root.getBoundingClientRect()
    return [...root.querySelectorAll<HTMLElement>("[data-msg-id]")].find(body => { const rect = body.getBoundingClientRect(); return Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top) > 1 })
  }
  const publishRows = () => {
    const publish = commitGate.publish
    expect(publish).toBeDefined()
    commitGate.hold = false
    act(() => publish?.())
  }
  try {
    await settle()
    const root = view.getByTestId("community-message-scroller")
    const entry = feed.positionEntry
    const query = owner.client.getQueryCache().find({ queryKey: communityKeys.channelMessages("c1"), exact: true })!
    expect(query).toBeDefined()
    if (feed.hasMoreOlder) {
      const older = feed.fetchOlder()
      expect(older.accepted).toBe(true)
      if (!older.accepted) throw new Error("The actual DM older controller must admit the setup read")
      await act(async () => { expect(await older.completed).toMatchObject({ status: "success" }); await vi.advanceTimersByTimeAsync(0) })
      await settle()
    }
    expect(feed.messages).toHaveLength(80)
    expect((query.state.data as MessageWindowData).pages).toHaveLength(2)
    phase = "first-manual"
    readings.length = 0
    commitGate.hold = true
    fireEvent.wheel(root, { deltaY: -root.scrollHeight })
    act(() => root.scrollTo({ top: 0 }))
    runFrames(1)
    runFrames(40)
    expect(readings).toHaveLength(0)
    phase = "first-commit"
    publishRows()
    runFrames(2)
    await settle()
    expect(readings).toEqual([{ phase: "first-commit", id: rows[0].id }])
    expect(feed.messageNeighborhood!.page).toMatchObject({ query, key: hashKey([(query.state.data as MessageWindowData).pageParams[1]]) })
    const before = { offset: root.scrollTop, height: root.scrollHeight, count: readings.length, messages: feed.messages, window: feed.messageWindow }
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "true")
    phase = "second-http-publication"
    commitGate.hold = true
    await act(async () => { await owner.client.query({ queryKey: communityKeys.message(rows[0].id), queryFn: messageQueryFn(rows[0].id, owner.client, "c1"), staleTime: 0, select: undefined }); await vi.advanceTimersByTimeAsync(0) })
    expect(updated).toBe(true)
    expect(owner.registry.collections.messages.get(rows[0].id)?.content).toBe("updated 0")
    expect(feed.messages.find(message => message.id === rows[0].id)?.content).toBe("updated 0")
    expect(feed.messages).not.toBe(before.messages)
    expect(root.querySelector(`[data-msg-id="${rows[0].id}"]`)).toHaveTextContent("updated 0")
    phase = "second-commit"
    publishRows()
    await settle()
    expect(readings).toHaveLength(before.count)
    expect(root.scrollTop).toBe(before.offset)
    expect(root.scrollHeight).toBe(before.height)
    expect(view.getByTestId("community-message-scroller")).toBe(root)
    expect(feed.positionEntry).toBe(entry)
    expect(owner.client.getQueryCache().find({ queryKey: query.queryKey, exact: true })).toBe(query)
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "true")
    if (order === "no-movement") return
    phase = "next-real-displacement"
    if (order === "fresh-wheel") fireEvent.wheel(root, { deltaY: 500 })
    act(() => root.scrollTo({ top: 500 }))
    await settle()
    const body = visibleBody(root)
    expect(body).toBeDefined()
    expect(body!.dataset.msgId).not.toBe(rows[0].id)
    expect(root.scrollTop).toBe(500)
    expect(readings).toHaveLength(before.count + 1)
    expect(readings.at(-1)).toEqual({ phase, id: body!.dataset.msgId })
  } finally {
    console.info("dm-consumed-second-publication", JSON.stringify({ order, updated, phase, readings, requests }))
    commitGate.hold = false
    view.unmount()
    owner.client.clear()
  }
})

it.each(["wheel-first", "displacement-first", "publish-before-reading", "publish-before-move", "no-input", "retired", "measure-first", "measure-first-no-input", "measure-first-retired", "measure-first-new-displacement"] as const)("retains the actual DM New window through older return and held newer commit with %s", async order => {
  const measureFirst = order.startsWith("measure-first")
  const scenario = order === "measure-first-no-input" ? "no-input" : order === "measure-first-retired" ? "retired" : measureFirst ? "publish-before-reading" : order
  let measurementRound = 0
  const orderingEvents: Array<{ phase: string; round: number; type: string; pending?: number; before?: number; after?: number }> = []
  let scrollRoot: HTMLElement | undefined
  const recordScroll = () => { orderingEvents.push({ phase, round: measurementRound, type: "scroll" }) }
  scrollFixture.width = 390
  const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const base = dmConversationEntryFixture()
  const rows = Array.from({ length: 300 }, (_, index) => ({ ...base.messages[0], id: `m${index + 1}`, seq: index + 1,
    content: `reading ${index}\n\ncontext ${index}\n\nthird line`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString() }))
  const cursor = (seq: number) => `${rows[seq - 1].createdAt}|m${seq}`
  const page = (first: number, last: number) => messageReadPageFixture({ messages: rows.slice(first - 1, last),
    olderCursor: first > 1 ? cursor(first) : undefined, newerCursor: last < 300 ? cursor(last) : undefined,
    hasMoreOlder: first > 1, hasMoreNewer: last < 300, latestSeq: 300 })
  const tail = { ...base, channel: { ...base.channel, messageCount: 300 }, messages: rows.slice(274),
    readState: { ...base.readState, lastReadMessageId: "m150", lastReadSeq: 150, lastReadAt: rows[149].createdAt },
    newBoundary: { afterSeq: 150, target: { id: "m151", channelId: "c1", seq: 151, authorId: "peer" } },
    page: { olderCursor: cursor(275), newerCursor: null, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 300 } }
  await seedConversationEntry(owner.client, tail)
  const requests: string[] = []
  const delayed = !["wheel-first", "displacement-first"].includes(scenario)
  let releaseOlder!: (value: ReturnType<typeof page>) => void
  const heldOlder = new Promise<ReturnType<typeof page>>(resolve => { releaseOlder = resolve })
  let olderCompletion: Promise<unknown> | undefined
  const readings: string[] = []
  let phase = "setup"
  const events: Array<{ phase: string; type: "reading" | "newer"; id?: string; index?: number; accepted?: boolean; stack?: string }> = []
  load.mockImplementation((url: string) => {
    const search = new URL(url, "https://test.invalid").searchParams
    if (search.has("entry")) return Promise.resolve(tail)
    requests.push(search.toString())
    if (search.get("cursor") === cursor(275)) return Promise.resolve(page(225, 274))
    if (search.get("anchor") === "m151") return Promise.resolve(page(126, 176))
    if (search.get("cursor") === cursor(126)) return Promise.resolve(page(76, 125))
    if (search.get("cursor") === cursor(76)) return Promise.resolve(page(26, 75))
    if (search.get("cursor") === cursor(26)) return delayed ? heldOlder : Promise.resolve(page(1, 25))
    if (search.get("since") === cursor(176)) return Promise.resolve(page(177, 226))
    if (search.get("since") === cursor(226)) return Promise.resolve(page(227, 276))
    if (search.get("since") === cursor(276)) return Promise.resolve(page(277, 300))
    throw new Error(`Unexpected retained DM read: ${url}`)
  })
  const href = "/c/me/c1", intent = { href }
  const navigation = { entryIntent: intent, publishedHref: href, pendingHref: null, navigationPending: false }
  let feed!: ReturnType<typeof useDmMessages>, readingId: string | undefined
  function Probe() {
    feed = useDmMessages("c1", { viewerUserId: "viewer" })
    const newer = feed.fetchNewer
    return <ConversationFooterSlotProvider><div data-slot="community-conversation-surface"><MessageList channel="DM" variant="dm"
      messages={feed.messages} loading={feed.isLoading} initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
      initialScrollReady={feed.initialDisplayReady} preserveInitialPresentation={feed.preserveInitialPresentation}
      initialPositionMessageId={feed.initialPositionMessageId} positionScope={feed.positionScope} positionEntry={feed.positionEntry}
      positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
      messageNeighborhood={feed.messageNeighborhood} onReadingMessage={id => { events.push({ phase, type: "reading", id, stack: new Error("controlled reading callback").stack }); readings.push(id); readingId = id; feed.onReadingMessage(id) }}
      newDividerBefore={feed.newBoundary?.target?.id} newBoundary={feed.newBoundary} latestSeq={feed.latestSeq}
      retiredNewTargetId={feed.retiredNewTargetId} onLoadNewTarget={feed.loadNewTarget} onReadNewBoundary={feed.readNewBoundary}
      hasMore={feed.hasMoreOlder} hasMoreNewer={feed.hasMoreNewer} historyStartKnown={feed.historyStartKnown}
      isFetching={feed.isFetching} isFetchingOlder={feed.isFetchingOlder} isFetchingNewer={feed.isFetchingNewer}
      onLoadOlder={() => { const request = feed.fetchOlder(); if (request.accepted) olderCompletion = request.completed; return request }} onLoadNewer={() => { const index = feed.data?.pages.findIndex(page => page.messages.some(row => row.id === readingId));
        if (measureFirst && phase === "reading-commit-released") {
          const currentRoot = scrollRoot!
          const viewport = currentRoot.getBoundingClientRect()
          const body = [...currentRoot.querySelectorAll<HTMLElement>("[data-msg-id]")].find(node => {
            const rect = node.getBoundingClientRect()
            return Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top) > 1
          })
          expect(body).toBeDefined()
          expect(feed.data?.pages[0].messages.some(row => row.id === body!.dataset.msgId)).toBe(true)
          expect(owner.registry.collections.messages.get(body!.dataset.msgId!)?.channelId).toBe("c1")
          expect(currentRoot.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "true")
          expect(index).toBe(0)
        }
        const request = newer(); events.push({ phase, type: "newer", index, accepted: request.accepted }); return request }} onUserTakeover={feed.onUserTakeover}
      active positioningActive onOpenThread={() => {}} />
      <ConversationFooterShell><textarea aria-label="Draft" /></ConversationFooterShell>
    </div></ConversationFooterSlotProvider>
  }
  const view = render(<CommunityTestProvider {...owner}><CommunityRouteContext value={{ breakpoint: "mobile", navigation } as never}><Probe /></CommunityRouteContext></CommunityTestProvider>)
  const measureBeforeScroll = (count = 26) => {
    measurementRound++
    resizeMeasureBeforeScroll(count, pending => { orderingEvents.push({ phase, round: measurementRound, type: "ro-complete", pending }) })
  }
  const settle = async () => {
    for (let commit = 0; commit < 6; commit++) {
      if (measureFirst && phase !== "setup") measureBeforeScroll()
      else resize()
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    }
  }
  try {
    await settle()
    const root = view.getByTestId("community-message-scroller")
    scrollRoot = root
    root.addEventListener("scroll", recordScroll)
    const native = (preCommand.latest as ScrollResult).virtualizer
    const initialEntry = feed.positionEntry
    expect(initialEntry).toBe(intent)
    const beforeNew = requests.length
    const historyRequests = () => requests.slice(beforeNew)
    fireEvent.change(view.getByRole("textbox", { name: "Draft" }), { target: { value: "retained dm draft" } })
    fireEvent.click(view.getByTestId("community-scroll-to-new"))
    await settle()
    const key = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m151" })
    const query = owner.client.getQueryCache().find({ queryKey: key, exact: true })!
    expect(query).toBeDefined()
    expect(feed.messages.some(row => row.id === "m151")).toBe(true)
    expect(historyRequests().filter(q => new URLSearchParams(q).has("since"))).toHaveLength(1)
    const move = (top: number, delta: number) => {
      if (scenario !== "displacement-first") fireEvent.wheel(root, { deltaY: delta })
      act(() => root.scrollTo({ top }))
      if (scenario === "displacement-first") fireEvent.wheel(root, { deltaY: delta })
    }
    for (let step = 0; step < 2; step++) { move(0, -root.clientHeight * 3); await settle() }
    expect(historyRequests().filter(q => new URLSearchParams(q).has("cursor"))).toHaveLength(3)
    console.info("dm-owner-before-return", JSON.stringify({ order, nativeSame: (preCommand.latest as ScrollResult).virtualizer === native,
      rootSame: view.getByTestId("community-message-scroller") === root, entrySame: feed.positionEntry === initialEntry,
      originalKeys: native.measurementsCache.slice(0, 8).map(row => row.key),
      currentKeys: (preCommand.latest as ScrollResult).virtualizer.measurementsCache.slice(0, 8).map(row => row.key),
      members: feed.messages.length }))
    const target = native.measurementsCache.find(row => row.key === "msg:id:m151")!
    expect(target).toBeDefined()
    move(target.start - root.clientHeight * 0.25, root.clientHeight * 3)
    await settle()
    const index = () => (query.state.data as MessageWindowData).pages.findIndex(page => page.messages.some(row => row.id === readingId))
    expect(index()).toBe(1)
    expect(feed.messageNeighborhood!.newer).toBe(false)
    expect((query.state.data as MessageWindowData).pages[0].newerCursor).toBe(cursor(226))
    const middle = feed.messageNeighborhood!.page
    const publishOlder = async () => {
      expect(olderCompletion).toBeDefined()
      phase = "older-publishing"
      await act(async () => { releaseOlder(page(1, 25)); await olderCompletion; await vi.advanceTimersByTimeAsync(0) })
      phase = "older-published"
    }
    if (scenario === "no-input") {
      await publishOlder()
      await settle()
      expect(feed.messageNeighborhood!.page).toBe(middle)
      expect(historyRequests().filter(q => new URLSearchParams(q).has("since"))).toHaveLength(1)
      expect(view.getByTestId("community-message-scroller")).toBe(root)
      expect(feed.positionEntry).toBe(initialEntry)
      return
    }
    if (scenario === "publish-before-move") { await publishOlder(); await settle() }
    commitGate.hold = true
    move(root.scrollHeight - root.clientHeight, root.clientHeight * 3)
    runFrames(1)
    expect(commitGate.publish).toBeDefined()
    runFrames(40)
    expect(feed.messageNeighborhood!.page).toBe(middle)
    expect(historyRequests().filter(q => new URLSearchParams(q).has("since"))).toHaveLength(1)
    const position = root.scrollTop
    if (scenario === "retired") {
      const before = readings.length
      view.unmount()
      runFrames(2)
      await publishOlder()
      commitGate.hold = false
      act(() => commitGate.publish?.())
      if (measureFirst) measureBeforeScroll(40)
      else runFrames(40)
      expect(readings).toHaveLength(before)
      expect(historyRequests().filter(q => new URLSearchParams(q).has("since"))).toHaveLength(1)
      return
    }
    if (scenario === "publish-before-reading") {
      const oldWindow = feed.messageWindow
      expect(feed.isFetchingOlder).toBe(true)
      await publishOlder()
      expect(feed.messageWindow).not.toBe(oldWindow)
      expect((query.state.data as MessageWindowData).pages.at(-1)?.messages.map(row => row.id)).toEqual(rows.slice(0, 25).map(row => row.id))
      expect(feed.messages).toHaveLength(226)
      expect(feed.messageNeighborhood!.page).toBe(middle)
      expect(owner.client.getQueryCache().find({ queryKey: key, exact: true })).toBe(query)
      expect(view.getByTestId("community-message-scroller")).toBe(root)
      expect(feed.positionEntry).toBe(initialEntry)
      const viewport = root.getBoundingClientRect()
      const body = [...root.querySelectorAll<HTMLElement>("[data-msg-id]")].find(node => {
        const rect = node.getBoundingClientRect()
        return Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top) > 1
      })
      expect(body).toBeDefined()
      expect((query.state.data as MessageWindowData).pages[0].messages.some(row => row.id === body!.dataset.msgId)).toBe(true)
      expect(owner.registry.collections.messages.get(body!.dataset.msgId!)?.channelId).toBe("c1")
      console.info("dm-reading-publication-boundary", JSON.stringify({ visible: body!.dataset.msgId, readingId, index: index(),
        rootSame: view.getByTestId("community-message-scroller") === root, entrySame: feed.positionEntry === initialEntry,
        windowChanged: feed.messageWindow !== oldWindow, newerCount: historyRequests().filter(q => new URLSearchParams(q).has("since")).length }))
    }
    phase = "reading-commit-released"
    commitGate.hold = false
    act(() => commitGate.publish!())
    if (measureFirst) measureBeforeScroll(2)
    else runFrames(2)
    if (!delayed) expect(root.scrollTop).toBe(position)
    await settle()
    if (measureFirst && scenario === "publish-before-reading") {
      const viewport = root.getBoundingClientRect()
      const body = [...root.querySelectorAll<HTMLElement>("[data-msg-id]")].find(node => {
        const rect = node.getBoundingClientRect()
        return Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top) > 1
      })
      expect(body).toBeDefined()
      expect((query.state.data as MessageWindowData).pages.some(page => page.messages.some(row => row.id === body!.dataset.msgId))).toBe(true)
      expect(owner.registry.collections.messages.get(body!.dataset.msgId!)?.channelId).toBe("c1")
      expect(view.getByTestId("community-message-scroller")).toBe(root)
      expect(feed.positionEntry).toBe(initialEntry)
      expect(owner.client.getQueryCache().find({ queryKey: key, exact: true })).toBe(query)
      expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "true")
      console.info("dm-post-ro-qualification", JSON.stringify({ order, visible: body!.dataset.msgId, readingId, readingIndex: index(),
        nativeEvents: orderingEvents.filter(event => event.phase !== "setup"), positionState: feed.positionDataState,
        requestCount: historyRequests().filter(q => new URLSearchParams(q).has("since")).length }))
    }
    if (order === "measure-first-new-displacement") {
      const before = root.scrollTop
      move(Math.max(0, before - root.clientHeight * 0.25), -root.clientHeight * 0.25)
      await settle()
      orderingEvents.push({ phase, round: measurementRound, type: "real-displacement", before, after: root.scrollTop })
      expect(Math.abs(root.scrollTop - before)).toBeGreaterThan(1)
    }
    expect(historyRequests().filter(q => new URLSearchParams(q).has("since"))).toHaveLength(2)
    if (scenario === "publish-before-reading") {
      const reading = events.findIndex(event => event.phase === "reading-commit-released" && event.type === "reading")
      const fetch = events.findIndex(event => event.phase === "reading-commit-released" && event.type === "newer")
      expect(reading).toBeGreaterThanOrEqual(0)
      expect(fetch).toBeGreaterThan(reading)
      expect(events[fetch]).toMatchObject({ accepted: true, index: 0 })
      console.info("dm-post-publication-reading", JSON.stringify(events))
    }
    move(root.scrollHeight - root.clientHeight, root.clientHeight * 3)
    await settle()
    const newer = historyRequests().map(q => new URLSearchParams(q).get("since")).filter(Boolean)
    expect(newer).toEqual([cursor(176), cursor(226), cursor(276)])
    expect(view.getByTestId("community-message-scroller")).toBe(root)
    expect((preCommand.latest as ScrollResult).virtualizer).toBe(native)
    expect(feed.positionEntry).toBe(initialEntry)
    expect(owner.client.getQueryCache().find({ queryKey: key, exact: true })).toBe(query)
    expect(view.getByRole("textbox", { name: "Draft" })).toHaveValue("retained dm draft")
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "true")
  } finally { console.info("dm-reading-callback-stack", JSON.stringify({ order, events })); console.info("dm-measure-before-scroll", JSON.stringify({ order, scenario, orderingEvents, requests })); scrollRoot?.removeEventListener("scroll", recordScroll); commitGate.hold = false; view.unmount(); owner.client.clear() }
})

it.each(["text", "dm"] as const)("reveals the qualified $0 history cache while ordinary tail coverage is pending", async kind => {
  scrollFixture.width = 390
  const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const packet = kind === "dm" ? dmConversationEntryFixture() : conversationEntryFixture()
  const rows = Array.from({ length: 80 }, (_, index) => ({ ...packet.messages[0], id: `m${index + 1}`, seq: index + 1,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString() }))
  packet.messages = rows.slice(0, 35)
  packet.readState = { ...packet.readState, lastReadMessageId: "m35", lastReadSeq: 35, lastReadAt: rows[34].createdAt }
  packet.selection = { reason: "read_pointer", anchorMessageId: "m35" }
  packet.newBoundary = { afterSeq: 35, target: { id: "m36", channelId: "c1", seq: 36, authorId: "peer" } }
  packet.page = { olderCursor: null, newerCursor: `${rows[34].createdAt}|m35`, hasMoreOlder: false, hasMoreNewer: true, latestSeq: 80 }
  await seedConversationEntry(owner.client, packet, { channelId: "c1", serverId: packet.channel.serverId, preferTail: false })
  const read = { ...packet.readState, lastReadMessageId: "m80", lastReadSeq: 80, lastReadAt: rows[79].createdAt }
  ingestReadStateSnapshot(owner.registry, { revision: 5, readStates: [read] })
  owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
  let release!: (value: typeof packet) => void
  load.mockReturnValue(new Promise(resolve => { release = resolve }))
  let feed!: ReturnType<typeof useMessages>
  function Probe() {
    const channel = useMessages(kind === "dm" ? null : "c1", { serverId: "s1" })
    const dm = useDmMessages(kind === "dm" ? "c1" : null)
    feed = kind === "dm" ? dm : channel
    const newBoundary = feed.newBoundary
    return <ConversationFooterSlotProvider><div data-slot="community-conversation-surface"><MessageList channel="Channel" variant={kind === "dm" ? "dm" : "channel"} messages={feed.messages}
      loading={feed.isLoading} initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
      initialScrollReady={feed.initialDisplayReady} preserveInitialPresentation={feed.preserveInitialPresentation} positionScope={feed.positionScope} positionEntry={feed.positionEntry}
      positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
      messageNeighborhood={feed.messageNeighborhood} onReadingMessage={feed.onReadingMessage}
      newBoundary={newBoundary} latestSeq={feed.latestSeq} retiredNewTargetId={feed.retiredNewTargetId}
        onLoadNewTarget={feed.loadNewTarget} onReadNewBoundary={feed.readNewBoundary} hasMore={feed.hasMoreOlder} hasMoreNewer={feed.hasMoreNewer}
      onUserTakeover={feed.onUserTakeover} onRetryInitialLoad={feed.retryInitialLoad} retryingInitialLoad={feed.retryingInitialLoad} onOpenThread={() => {}} />
      <ConversationFooterShell><textarea aria-label="Draft" /></ConversationFooterShell>
    </div></ConversationFooterSlotProvider>
  }
  const view = render(<CommunityTestProvider {...owner}><Probe /></CommunityTestProvider>)
  const phases: unknown[] = []
  try {
    resize()
    let root = view.getByTestId("community-message-scroller")
    const capture = (phase: string) => phases.push({ phase, scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight,
      distanceToEnd: root.scrollHeight - root.clientHeight - root.scrollTop, first: feed.messages[0]?.id, last: feed.messages.at(-1)?.id,
      hasMoreNewer: feed.hasMoreNewer, positionDataState: feed.positionDataState, busy: root.getAttribute("aria-busy") })
    capture("cached-history-visible")
    expect(root).toHaveAttribute("aria-busy", "false")
    expect(root.querySelector("[data-message-list-content]")).toHaveAttribute("data-initial-position-phase", "revealed")
    expect(feed.messages.map(message => message.id)).toEqual(rows.slice(0, 35).map(message => message.id))
    expect(feed.readSnapshotFetching).toBe(true)
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
    expect(root).toHaveAttribute("data-pagination-enabled", "false")
    expect(view.getByRole("textbox", { name: "Draft" })).toBeVisible()
    expect(view.queryByTestId("community-scroll-to-present")).toBeNull()
    const fresh = { ...packet, messages: rows.slice(34), readState: read, readStateRevision: 5,
      selection: { reason: "tail" as const, anchorMessageId: null }, newBoundary: { afterSeq: 80, target: null },
      page: { olderCursor: `${rows[34].createdAt}|m35`, newerCursor: null, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 80 } }
    await act(async () => { release(fresh); await vi.advanceTimersByTimeAsync(0) })
    resize()
    capture("entry-refresh")
    root = view.getByTestId("community-message-scroller")
    expect(feed.messages.at(-1)?.id).toBe("m80")
    expect(root.querySelector("[data-new-divider]")).toBeNull()
    expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeLessThanOrEqual(1)
    expect(root.querySelector('[data-msg-id="m80"]')).not.toBeNull()
  } finally {
    console.info("ordinary-cache-tail-phases", JSON.stringify({ kind, phases }))
    view.unmount(); owner.client.clear()
  }
})

it.each((["text", "dm"] as const).flatMap(kind => (["unchanged", "new messages", "offline", "takeover"] as const)
  .map(result => ({ kind, result }))))("keeps the restored $kind tail separate from historical jump admission through $result", async ({ kind, result }) => {
  scrollFixture.width = 390
  const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const packet = kind === "dm" ? dmConversationEntryFixture() : conversationEntryFixture()
  const rows = Array.from({ length: 60 }, (_, index) => ({ ...packet.messages[0], id: `m${index + 1}`, seq: index + 1,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString() }))
  packet.messages = rows.slice(0, 40)
  packet.channel.messageCount = 40
  packet.readState = { ...packet.readState, lastReadMessageId: "m40", lastReadSeq: 40, lastReadAt: rows[39].createdAt }
  packet.selection = { reason: "tail", anchorMessageId: null }
  packet.newBoundary = { afterSeq: 40, target: null }
  packet.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 40 }
  await seedConversationEntry(owner.client, packet)
  const restored = readCommunityRestoredCollections({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(owner.client) }, "viewer")
  owner.client.removeQueries({ queryKey: communityKeys.channelMessages("c1") })
  owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
  restoreConversationDisplayWindows(owner.registry, restored)
  let resolve!: (value: typeof packet) => void, reject!: (error: Error) => void
  load.mockReturnValue(new Promise<typeof packet>((yes, no) => { resolve = yes; reject = no }))
  let feed!: ReturnType<typeof useMessages>
  function Probe() {
    const channel = useMessages(kind === "dm" ? null : "c1", { serverId: "s1" })
    const dm = useDmMessages(kind === "dm" ? "c1" : null)
    feed = kind === "dm" ? dm : channel
    return <ConversationFooterSlotProvider><div data-slot="community-conversation-surface"><MessageList channel="Channel" variant={kind === "dm" ? "dm" : "channel"}
      messages={feed.messages} loading={feed.isLoading} initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
      initialScrollReady={feed.initialDisplayReady} preserveInitialPresentation={feed.preserveInitialPresentation}
      positionScope={feed.positionScope} positionEntry={feed.positionEntry} positionDataState={feed.positionDataState}
      targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
      messageNeighborhood={feed.messageNeighborhood} onReadingMessage={feed.onReadingMessage}
      newBoundary={feed.newBoundary} latestSeq={feed.latestSeq} retiredNewTargetId={feed.retiredNewTargetId}
      onLoadNewTarget={feed.loadNewTarget} onReadNewBoundary={feed.readNewBoundary}
      hasMore={feed.hasMoreOlder} hasMoreNewer={feed.hasMoreNewer}
      isFetchingNewer={feed.isFetchingNewer}
      onJumpToPresent={feed.jumpToPresent} presentVersion={feed.presentVersion} presentRequest={feed.presentRequest}
      onUserTakeover={feed.onUserTakeover} onRetryInitialLoad={feed.retryInitialLoad} retryingInitialLoad={feed.retryingInitialLoad} onOpenThread={() => {}} />
      <ConversationFooterShell><textarea aria-label="Draft" /></ConversationFooterShell>
    </div></ConversationFooterSlotProvider>
  }
  const view = render(<CommunityTestProvider {...owner}><Probe /></CommunityTestProvider>)
  const tailPhases: Array<{ phase: string; clearance: number; trailingSize: number; footerHeight: number; paddingEnd: number; hasMoreNewer: boolean; positionDataState: string }> = []
  const tailWrites: unknown[] = []
  let tailPhase = "restored-pending"
  const captureTail = (phase: string) => {
    const root = view.getByTestId("community-message-scroller")
    const body = root.querySelector<HTMLElement>('[data-msg-id="m40"]')!
    const position = preCommand.latest as ScrollResult
    const trailing = root.querySelector<HTMLElement>('[data-message-row-key="rail:trailing"]')?.closest<HTMLElement>("[data-index]")
    const row = { phase, clearance: root.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom,
      trailingSize: trailing?.getBoundingClientRect().height ?? 0,
      footerHeight: view.container.querySelector<HTMLElement>('[data-slot="community-conversation-footer"]')?.getBoundingClientRect().height ?? 0,
      paddingEnd: position.virtualizer.options.paddingEnd ?? 0, hasMoreNewer: feed.hasMoreNewer, positionDataState: feed.positionDataState,
      hasMoreOlder: feed.hasMoreOlder, readReady: position.readPositionReady, positionOutcome: position.positionOutcome,
      scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight,
      nativeOffset: position.virtualizer.scrollOffset, total: position.virtualizer.getTotalSize(),
      leadingEstimate: position.virtualizer.options.estimateSize(0),
      leadingCachedSize: position.virtualizer.itemSizeCache.get(position.virtualizer.options.getItemKey(0)) ?? null,
      leadingMeasurement: { ...position.virtualizer.measurementsCache[0] } }
    tailPhases.push(row)
    return row
  }
  try {
    resize()
    const root = view.getByTestId("community-message-scroller")
    const draft = view.getByRole("textbox", { name: "Draft" })
    expect(root).toHaveAttribute("aria-busy", "false")
    expect(root.querySelector('[data-msg-id="m40"]')).not.toBeNull()
    expect(feed.hasMoreNewer).toBe(true)
    expect(feed.positionDataState).toBe("pending")
    expect(root).toHaveAttribute("data-pagination-enabled", "false")
    expect(view.queryByTestId("community-scroll-to-present")).toBeNull()
    const cachedTail = result === "unchanged" ? captureTail("restored-pending") : null
    if (cachedTail) {
      const originalScrollTo = HTMLElement.prototype.scrollTo
      vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function(this: HTMLElement, ...args: [options?: ScrollToOptions] | [x: number, y: number]) {
        const before = this.scrollTop
        Reflect.apply(originalScrollTo, this, args)
        if (this === root) tailWrites.push({ phase: tailPhase, before, requested: typeof args[0] === "number" ? args[1] : args[0]?.top, after: this.scrollTop,
          nativeStack: new Error().stack?.split("\n").filter(line => /resizeItem|applyScrollAdjustment|_scrollToOffset|setOptions/.test(line)) })
      })
    }
    fireEvent.change(draft, { target: { value: "Local draft" } })
    expect(draft).toHaveValue("Local draft")
    let readerId: string | undefined, readerOffset = 0
    if (result === "takeover") {
      fireEvent.wheel(root, { deltaY: -1500 })
      act(() => root.scrollTo({ top: 1500 }))
      resize()
      const reader = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]")).find(row => row.getBoundingClientRect().bottom > root.getBoundingClientRect().top + 1)!
      readerId = reader.dataset.msgId
      readerOffset = reader.getBoundingClientRect().top - root.getBoundingClientRect().top
      expect(view.getByRole("button", { name: "Jump to present" })).toBeVisible()
      expect(root).toHaveAttribute("data-pagination-enabled", "false")
    }
    if (result === "offline") {
      await act(async () => { reject(new Error("offline")); await vi.advanceTimersByTimeAsync(2000) })
      resize()
      expect(root).toHaveAttribute("aria-busy", "false")
      expect(root.querySelector('[data-msg-id="m40"]')).not.toBeNull()
      expect(feed.hasMoreNewer).toBe(true)
      expect(root.querySelector('[data-read-position-ready="true"]')).toBeNull()
      expect(view.queryByTestId("community-scroll-to-present")).toBeNull()
    } else {
      const freshRows = result === "unchanged" ? rows.slice(0, 40) : rows
      const fresh = { ...packet, channel: { ...packet.channel, messageCount: freshRows.length }, messages: freshRows,
        newBoundary: { afterSeq: 40, target: result === "unchanged" ? null : { id: "m41", channelId: "c1", seq: 41, authorId: "peer" } },
        page: { ...packet.page, latestSeq: freshRows.length } }
      tailPhase = "entry-confirmation"
      await act(async () => { resolve(fresh); await vi.advanceTimersByTimeAsync(0) })
      tailPhase = "confirmation-resize-and-frames"
      resize()
      const confirmedTail = cachedTail ? captureTail("confirmed-unchanged") : null
      expect(view.getByTestId("community-message-scroller")).toBe(root)
      if (result === "takeover") {
        const reader = root.querySelector<HTMLElement>(`[data-msg-id="${readerId}"]`)!
        expect(reader).not.toBeNull()
        expect(Math.abs(reader.getBoundingClientRect().top - root.getBoundingClientRect().top - readerOffset)).toBeLessThanOrEqual(1)
        expect(view.getByTestId("community-scroll-to-present")).toBeVisible()
      } else {
        expect(feed.hasMoreNewer).toBe(false)
        expect(feed.messages.at(-1)?.id).toBe(result === "unchanged" ? "m40" : "m60")
        expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeLessThanOrEqual(1)
        expect(view.queryByTestId("community-scroll-to-present")).toBeNull()
        if (cachedTail && confirmedTail) {
          expect(confirmedTail.clearance).toBeCloseTo(40, 0)
          expect(cachedTail.clearance).toBeCloseTo(confirmedTail.clearance, 0)
        }
      }
    }
    expect(draft).toHaveValue("Local draft")
  } finally {
    if (tailPhases.length) console.info("tail-gap327", JSON.stringify({ kind, result, phases: tailPhases, writes: tailWrites }))
    view.unmount(); owner.client.clear()
  }
})

it.each(["text", "dm"] as const)("shows the $0 newer loading row through a real cursor request while retaining its boundary", async kind => {
  scrollFixture.width = 390
  const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const packet = kind === "dm" ? dmConversationEntryFixture() : conversationEntryFixture()
  const rows = Array.from({ length: 80 }, (_, index) => ({ ...packet.messages[0], id: `m${index + 1}`, seq: index + 1,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString() }))
  packet.messages = rows.slice(0, 40)
  packet.channel.messageCount = 80
  packet.readState = { ...packet.readState, lastReadMessageId: "m20", lastReadSeq: 20, lastReadAt: rows[19].createdAt }
  packet.selection = { reason: "explicit_anchor", anchorMessageId: "m20" }
  packet.newBoundary = { afterSeq: 20, target: { id: "m21", channelId: "c1", seq: 21, authorId: "peer" } }
  const cursor = `${rows[39].createdAt}|m40`
  packet.page = { olderCursor: null, newerCursor: cursor, hasMoreOlder: false, hasMoreNewer: true, latestSeq: 80 }
  await seedConversationEntry(owner.client, packet, { channelId: "c1", serverId: packet.channel.serverId, anchorMessageId: "m20", newAfterSeq: 20 })
  let release!: (value: ReturnType<typeof messageReadPageFixture>) => void
  const newer = new Promise<ReturnType<typeof messageReadPageFixture>>(resolve => { release = resolve })
  load.mockImplementation((url: string) => {
    const search = new URL(url, "https://example.test").searchParams
    if (search.has("entry")) return Promise.resolve(packet)
    if (search.get("since") === cursor) return newer
    throw new Error(`Unexpected message request ${url}`)
  })
  let feed!: ReturnType<typeof useMessages>
  function Probe() {
    const channel = useMessages(kind === "dm" ? null : "c1", { serverId: "s1", anchorMessageId: "m20" })
    const dm = useDmMessages(kind === "dm" ? "c1" : null, { anchorMessageId: "m20" })
    feed = kind === "dm" ? dm : channel
    return <ConversationFooterSlotProvider><div data-slot="community-conversation-surface"><MessageList channel="Channel" variant={kind === "dm" ? "dm" : "channel"}
      messages={feed.messages} loading={feed.isLoading} initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
      initialScrollReady={feed.initialDisplayReady} positionScope={feed.positionScope} positionEntry={feed.positionEntry}
      positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
      messageNeighborhood={feed.messageNeighborhood} onReadingMessage={feed.onReadingMessage}
      scrollToMessageId="m20" hasMore={feed.hasMoreOlder} hasMoreNewer={feed.hasMoreNewer}
      isFetching={feed.isFetching} isFetchingNewer={feed.isFetchingNewer} onLoadNewer={feed.fetchNewer}
      onUserTakeover={feed.onUserTakeover} onOpenThread={() => {}} />
      <ConversationFooterShell><textarea aria-label="Draft" /></ConversationFooterShell>
    </div></ConversationFooterSlotProvider>
  }
  const view = render(<CommunityTestProvider {...owner}><Probe /></CommunityTestProvider>)
  const lastKey = () => {
    const native = (preCommand.latest as ScrollResult).virtualizer
    return native.options.getItemKey(native.options.count - 1)
  }
  try {
    expect(feed.isFetchingNewer).toBe(false)
    expect(lastKey()).not.toBe("rail:trailing")
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    resize()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    resize()
    const root = view.getByTestId("community-message-scroller")
    expect(feed.positionDataState).toBe("ready")
    expect(feed.hasMoreNewer).toBe(true)
    expect(feed.isFetchingNewer).toBe(true)
    expect(lastKey()).toBe("rail:trailing")
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "true")
    expect(load.mock.calls.filter(([url]) => new URL(url, "https://example.test").searchParams.get("since") === cursor)).toHaveLength(1)
    const readingPage = feed.messageNeighborhood!.page
    fireEvent.wheel(root, { deltaY: root.scrollHeight })
    act(() => root.scrollTo({ top: root.scrollHeight - root.clientHeight }))
    resize()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    resize()
    expect(load.mock.calls.filter(([url]) => new URL(url, "https://example.test").searchParams.get("since") === cursor)).toHaveLength(1)
    expect(feed.isFetchingNewer).toBe(true)
    expect(feed.hasMoreNewer).toBe(true)
    expect(lastKey()).toBe("rail:trailing")
    expect(view.getByText("Loading newer messages…")).toBeVisible()
    await act(async () => {
      release(messageReadPageFixture({ messages: rows.slice(40, 60), profiles: packet.profiles, latestSeq: 80,
        hasMoreOlder: true, hasMoreNewer: true, olderCursor: `${rows[40].createdAt}|m41`, newerCursor: `${rows[59].createdAt}|m60` }))
      await vi.advanceTimersByTimeAsync(0)
    })
    resize()
    expect(feed.isFetchingNewer).toBe(false)
    expect(feed.hasMoreNewer).toBe(true)
    expect(feed.messages.at(-1)?.id).toBe("m60")
    expect(feed.messageWindow?.pageParams).toEqual([{ mode: "newer", cursor }, { mode: "anchor", anchor: "m20" }])
    expect(lastKey()).not.toBe("rail:trailing")
    expect(view.queryByText("Loading newer messages…")).toBeNull()
    expect(feed.messageNeighborhood!.page).toBe(readingPage)
    expect(load.mock.calls.filter(([url]) => new URL(url, "https://example.test").searchParams.get("since") === cursor)).toHaveLength(1)
  } finally { view.unmount(); owner.client.clear() }
})

it.each(kinds.flatMap(kind => [
  { takeover: true, repairFailure: false }, { takeover: false, repairFailure: false }, { takeover: true, repairFailure: true },
].map(mode => ({ kind, ...mode }))))(
  "preserves the actual $kind reader through Retry recovery with takeover=$takeover, repairFailure=$repairFailure",
  async ({ kind, takeover, repairFailure }) => {
    scrollFixture.width = 1280
    const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const packet = kind === "dm" ? dmConversationEntryFixture() : conversationEntryFixture()
    if (kind === "text-thread" || kind === "forum-post") {
      packet.channel = { ...packet.channel, type: "thread", parentChannelId: "parent", parentMessageId: "opener" }
      packet.parent = { ...packet.channel, id: "parent", type: kind === "forum-post" ? "forum" : "text", parentChannelId: null, parentMessageId: null }
      packet.surfaceReceipt = { channelId: "c1", surfaceKind: "thread" }
    }
    const rows = Array.from({ length: 80 }, (_, index) => ({ ...packet.messages[0], id: `m${index + 1}`, seq: index + 1,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString() }))
    packet.messages = rows.slice(0, 35)
    packet.readState = { ...packet.readState, lastReadMessageId: "m10", lastReadSeq: 10 }
    packet.selection = { reason: "tail", anchorMessageId: null }
    packet.newBoundary = { afterSeq: 10, target: { id: "m11", channelId: "c1", seq: 11, authorId: "peer" } }
    packet.channel.messageCount = 35
    packet.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 35 }
    await seedConversationEntry(owner.client, packet)
    const read = { ...packet.readState, lastReadMessageId: "m60", lastReadSeq: 60, lastReadAt: rows[59].createdAt }
    ingestReadStateSnapshot(owner.registry, { revision: 5, readStates: [read] })
    owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
    let reject!: (reason: Error) => void
    load.mockReturnValue(new Promise((_, no) => { reject = no }))
    let feed!: ReturnType<typeof useMessages>
    function Probe() {
      const channel = useMessages(kind === "dm" ? null : "c1", { serverId: "s1" })
      const dm = useDmMessages(kind === "dm" ? "c1" : null)
      feed = kind === "dm" ? dm : channel
      const newBoundary = feed.newBoundary
      return <ConversationFooterSlotProvider><div data-slot="community-conversation-surface"><MessageList channel="Channel" variant={kind === "dm" ? "dm" : "channel"} messages={feed.messages}
        loading={feed.isLoading} initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
        initialScrollReady={feed.initialDisplayReady} preserveInitialPresentation={feed.preserveInitialPresentation} positionScope={feed.positionScope} positionEntry={feed.positionEntry}
        positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
      messageNeighborhood={feed.messageNeighborhood} onReadingMessage={feed.onReadingMessage}
        newBoundary={newBoundary} latestSeq={feed.latestSeq} retiredNewTargetId={feed.retiredNewTargetId}
        onLoadNewTarget={feed.loadNewTarget} onReadNewBoundary={feed.readNewBoundary} hasMore={feed.hasMoreOlder} hasMoreNewer={feed.hasMoreNewer}
        onUserTakeover={feed.onUserTakeover} onRetryInitialLoad={feed.retryInitialLoad} retryingInitialLoad={feed.retryingInitialLoad} onOpenThread={() => {}} />
        <ConversationFooterShell><div>composer</div></ConversationFooterShell>
      </div></ConversationFooterSlotProvider>
    }
    const view = render(<CommunityTestProvider {...owner}><Probe /></CommunityTestProvider>)
    try {
      resize()
      let root = view.getByTestId("community-message-scroller")
      expect(root).toHaveAttribute("aria-busy", "false")
      expect(root.querySelector("[data-message-list-content]")).toHaveAttribute("data-initial-position-phase", "revealed")
      const cachedTail = root.querySelector<HTMLElement>('[data-msg-id="m35"]')!
      expect(cachedTail).not.toBeNull()
      const cachedTailOffset = cachedTail.getBoundingClientRect().top - root.getBoundingClientRect().top
      expect(root.querySelector('[data-read-position-ready="true"]')).toBeNull()
      expect(root).toHaveAttribute("data-pagination-enabled", "false")
      await act(async () => { reject(new Error("held entry failed")); await vi.advanceTimersByTimeAsync(2000) })
      resize()
      root = view.getByTestId("community-message-scroller")
      expect(root.querySelector('[data-msg-id="m35"]')).toBe(cachedTail)
      expect(Math.abs(cachedTail.getBoundingClientRect().top - root.getBoundingClientRect().top - cachedTailOffset)).toBeLessThanOrEqual(1)
      let release!: (value: typeof packet) => void
      const retry = new Promise<typeof packet>(resolve => { release = resolve })
      const repairPage = { ...packet.page, latestSeq: 80, profiles: packet.profiles, messages: rows.slice(35) }
      let failRepair = repairFailure
      load.mockImplementation((url: string) => url.includes("entry=1") ? retry
        : failRepair ? Promise.reject(new Error("owned window repair failed")) : Promise.resolve(repairPage))
      fireEvent.click(view.getByRole("button", { name: "Retry" }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      resize()
      expect(root).toHaveAttribute("aria-busy", "false")
      expect(root).toHaveAttribute("data-pagination-enabled", "false")
      if (takeover) {
        fireEvent.wheel(root, { deltaY: 1000 })
        act(() => root.scrollTo({ top: 1000 }))
        resize()
      }
      expect(root).toHaveAttribute("aria-busy", "false")
      const viewport = root.getBoundingClientRect()
      const reader = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]")).find(row => row.getBoundingClientRect().bottom > viewport.top + 1)!
      const readerId = reader.dataset.msgId!
      const offset = reader.getBoundingClientRect().top - viewport.top
      expect(Number(readerId.slice(1))).toBeLessThan(35)
      const fresh = { ...packet, channel: { ...packet.channel, messageCount: 80 }, messages: rows.slice(59), readState: read, readStateRevision: 5,
        selection: { reason: "tail" as const, anchorMessageId: null }, newBoundary: { afterSeq: 60, target: { id: "m61", channelId: "c1", seq: 61, authorId: "peer" } },
        page: { olderCursor: `${rows[59].createdAt}|m60`, newerCursor: null, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 80 } }
      await act(async () => { release(fresh); await vi.advanceTimersByTimeAsync(0) })
      resize()
      expect(view.getByTestId("community-message-scroller")).toBe(root)
      expect(root).toHaveAttribute("aria-busy", "false")
      if (repairFailure) expect(view.getByRole("alert")).toHaveTextContent("Couldn’t load the requested messages")
      else expect(view.queryByRole("alert")).toBeNull()
      if (takeover) {
        expect(feed.messages.map(row => row.id)).toContain(readerId)
        expect(root.querySelector(`[data-msg-id="${readerId}"]`)).toBe(reader)
        expect(Math.abs(reader.getBoundingClientRect().top - root.getBoundingClientRect().top - offset)).toBeLessThanOrEqual(1)
      } else {
        expect(feed.messages.map(row => row.id)).toEqual(rows.map(row => row.id))
        expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeLessThanOrEqual(1)
        expect(feed.newBoundary?.target?.id).toBe("m61")
        expect(view.getByRole("button", { name: "Jump to New" })).toBeVisible()
      }
      if (repairFailure) {
        expect(root).toHaveAttribute("data-pagination-enabled", "false")
        expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
        fireEvent.click(view.getByRole("button", { name: "Retry" }))
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })
        resize()
        expect(view.getByRole("alert")).toHaveTextContent("Couldn’t load the requested messages")
        expect(root).toHaveAttribute("aria-busy", "false")
        expect(feed.messages.map(row => row.id)).toContain(readerId)
        failRepair = false
        fireEvent.click(view.getByRole("button", { name: "Retry" }))
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })
        resize()
        expect(view.queryByRole("alert")).toBeNull()
        expect(view.getByTestId("community-message-scroller")).toBe(root)
        expect(root).toHaveAttribute("aria-busy", "false")
        expect(feed.messages.map(row => row.id)).toEqual(rows.map(row => row.id))
      }
      expect(feed.readSnapshotFetching).toBe(false)
      expect(feed.readSnapshot?.lastReadSeq).toBe(60)
      expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "true")
      expect(root).toHaveAttribute("data-pagination-enabled", "true")
    } finally { view.unmount(); owner.client.clear() }
  },
)

it.each(kinds.flatMap(kind => (["success", "offline", "timeout"] as const).map(result => ({ kind, result }))))(
  "reveals complete $kind cache through the real list during missing target work and $result",
  async ({ kind, result }) => {
    const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const packet = kind === "dm" ? dmConversationEntryFixture() : conversationEntryFixture()
    if (kind === "text-thread" || kind === "forum-post") {
      packet.channel = { ...packet.channel, type: "thread", parentChannelId: "parent", parentMessageId: "opener" }
      packet.parent = { ...packet.channel, id: "parent", type: kind === "forum-post" ? "forum" : "text", parentChannelId: null, parentMessageId: null }
      packet.surfaceReceipt = { channelId: "c1", surfaceKind: "thread" }
    }
    packet.messages = Array.from({ length: 42 }, (_, index) => ({ ...packet.messages[0], id: `m${index + 1}`, seq: index + 1 }))
    packet.readState = { ...packet.readState, lastReadMessageId: "m30", lastReadSeq: 30 }
    packet.selection = { reason: "tail", anchorMessageId: null }
    packet.newBoundary = { afterSeq: 30, target: { id: "m31", channelId: "c1", seq: 31, authorId: "peer" } }
    packet.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 42 }
    await seedConversationEntry(owner.client, packet)
    owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
    let resolve!: (value: typeof packet) => void, reject!: (error: Error) => void
    load.mockReturnValue(new Promise<typeof packet>((yes, no) => { resolve = yes; reject = no }))
    let feed!: ReturnType<typeof useMessages>
    function Probe() {
      const channel = useMessages(kind === "dm" ? null : "c1", { serverId: "s1", anchorMessageId: "m60" })
      const dm = useDmMessages(kind === "dm" ? "c1" : null, { anchorMessageId: "m60" })
      feed = kind === "dm" ? dm : channel
      const newBoundary = feed.newBoundary
      return <MessageList channel="Channel" variant={kind === "dm" ? "dm" : "channel"} messages={feed.messages}
        loading={feed.isLoading} initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
        initialScrollReady={feed.initialDisplayReady} preserveInitialPresentation={feed.preserveInitialPresentation} positionScope={feed.positionScope} positionEntry={feed.positionEntry}
        positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
      messageNeighborhood={feed.messageNeighborhood} onReadingMessage={feed.onReadingMessage}
        newBoundary={newBoundary} latestSeq={feed.latestSeq} retiredNewTargetId={feed.retiredNewTargetId}
        onLoadNewTarget={feed.loadNewTarget} onReadNewBoundary={feed.readNewBoundary} scrollToMessageId="m60" hasMoreNewer={feed.hasMoreNewer}
        onRetryInitialLoad={feed.retryInitialLoad} retryingInitialLoad={feed.retryingInitialLoad} onOpenThread={() => {}} />
    }
    const view = render(<CommunityTestProvider {...owner}><Probe /></CommunityTestProvider>)
    try {
      resize()
      const root = view.getByTestId("community-message-scroller")
      expect(feed.initialDisplayReady).toBe(true)
      expect(feed.initialPositionKnown).toBe(false)
      expect(feed.readSnapshotFetching).toBe(true)
      expect(feed.targetPositionDataState).toBe("pending")
      expect(feed.positionDataState).toBe("pending")
      expect(root).toHaveAttribute("aria-busy", "false")
      expect(root.querySelector("[data-message-list-content]")).toHaveAttribute("aria-hidden", "false")
      expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
      expect(root).toHaveAttribute("data-pagination-enabled", "false")
      expect(root.querySelectorAll("[data-msg-id]").length).toBeGreaterThan(0)
      expect(load.mock.calls.some(([path]) => new URL(path, "https://test.invalid").searchParams.get("anchor") === "m60")).toBe(true)
      expect(load.mock.calls.some(([path]) => path.endsWith("/read"))).toBe(false)
      const fresh = { ...packet, selection: { reason: "explicit_anchor" as const, anchorMessageId: "m60" },
        messages: Array.from({ length: 22 }, (_, index) => ({ ...packet.messages[0], id: `m${index + 59}`, seq: index + 59 })),
        page: { ...packet.page, latestSeq: 80, hasMoreOlder: true, hasMoreNewer: false, newerCursor: null } }
      await act(async () => {
        if (result === "success") resolve(fresh)
        else if (result === "offline") reject(new Error("offline"))
        await vi.advanceTimersByTimeAsync(result === "timeout" ? 15000 : result === "offline" ? 2000 : 0)
      })
      resize()
      expect(view.getByTestId("community-message-scroller")).toBe(root)
      expect(root).toHaveAttribute("aria-busy", "false")
      expect(root.querySelector("[data-message-list-content]")).toHaveAttribute("aria-hidden", "false")
      if (result === "success") {
        expect(feed.initialPositionKnown).toBe(true)
        expect(feed.messages.some(message => message.id === "m60")).toBe(true)
      } else {
        expect(feed.messages).toHaveLength(42)
        expect(feed.targetPositionDataState).toBe("error")
        expect(view.getByRole("alert")).toHaveTextContent("Couldn’t load the requested messages")
        let resume!: (value: typeof fresh) => void
        load.mockReturnValue(new Promise(yes => { resume = yes }))
        fireEvent.click(view.getByRole("button", { name: "Retry" }))
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })
        resize()
        expect(view.getByTestId("community-message-scroller")).toBe(root)
        expect(root).toHaveAttribute("aria-busy", "false")
        expect(root.querySelector("[data-message-list-content]")).toHaveAttribute("aria-hidden", "false")
        await act(async () => { resume(fresh); await vi.advanceTimersByTimeAsync(0) })
        resize()
        expect(feed.initialPositionKnown).toBe(true)
        expect(view.queryByRole("alert")).toBeNull()
      }
    } finally { view.unmount(); owner.client.clear() }
  },
)

it.each(kinds)("keeps $0 display qualification separate from an unavailable canonical read snapshot", async kind => {
  const owner = await createCommunityQueryOwner()
  const packet = kind === "dm" ? dmConversationEntryFixture() : conversationEntryFixture()
  if (kind === "text-thread" || kind === "forum-post") {
    packet.channel = { ...packet.channel, type: "thread", parentChannelId: "parent", parentMessageId: "opener" }
    packet.parent = { ...packet.channel, id: "parent", type: kind === "forum-post" ? "forum" : "text", parentChannelId: null, parentMessageId: null }
    packet.surfaceReceipt = { channelId: "c1", surfaceKind: "thread" }
  }
  await seedConversationEntry(owner.client, packet)
  owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
  owner.registry.collections.readStates.utils.writeDelete("c1")
  if (owner.registry.collections.readStateClock.has("account")) owner.registry.collections.readStateClock.utils.writeDelete("account")
  load.mockReturnValue(new Promise(() => {}))
  const { useChannelMetadata } = await import("./use-channel-metadata")
  let latest!: { metadata: ReturnType<typeof useChannelMetadata>; feed: ReturnType<typeof useMessages> }
  function Probe() {
    const metadata = useChannelMetadata(packet.channel.serverId, "c1")
    const channel = useMessages(kind === "dm" ? null : "c1", { serverId: "s1" })
    const dm = useDmMessages(kind === "dm" ? "c1" : null)
    const feed = kind === "dm" ? dm : channel
    latest = { metadata, feed }
    return <MessageList channel="Conversation" variant={kind === "dm" ? "dm" : "channel"} messages={feed.messages}
      loading={feed.isLoading} initialLoadError={feed.initialLoadError} initialScrollReady={feed.initialDisplayReady}
      positionScope={feed.positionScope} positionEntry={feed.positionEntry} positionDataState={feed.positionDataState}
      targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
      messageNeighborhood={feed.messageNeighborhood} onReadingMessage={feed.onReadingMessage} onOpenThread={() => {}} />
  }
  const view = render(<CommunityTestProvider {...owner}><Probe /></CommunityTestProvider>)
  try {
    resize()
    expect(latest.metadata.status).toBe("readable")
    expect(latest.metadata.windowReady).toBe(false)
    expect(latest.feed.initialDisplayReady).toBe(true)
    expect(latest.feed.readSnapshot).toBeNull()
    expect(latest.feed.initialPositionKnown).toBe(false)
    expect(latest.feed.readSnapshotFetching).toBe(true)
    expect(latest.feed.positionDataState).toBe("pending")
    expect(latest.feed.navigationBlocked).toBe(true)
    const root = view.getByTestId("community-message-scroller")
    expect(root).toHaveAttribute("aria-busy", "false")
    expect(root.querySelector("[data-message-list-content]")).toHaveAttribute("data-initial-position-phase", "revealed")
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
    expect(root).toHaveAttribute("data-pagination-enabled", "false")
    expect(view.getByText("Body")).toBeVisible()
  } finally { view.unmount(); owner.client.clear() }
})


it.each([
  { name: "keeps ordinary cached tail ownership through its own pre-command row measurement", external: false },
  { name: "keeps unlabelled takeover through following native row compensation", external: true },
])("$name", async ({ external }) => {
  scrollFixture.width = 390
  const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const packet = dmConversationEntryFixture()
  const rows = Array.from({ length: 60 }, (_, index) => ({ ...packet.messages[0], id: "ro" + (index + 1), seq: index + 1,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString() }))
  packet.messages = rows
  packet.channel.messageCount = 60
  packet.readState = { ...packet.readState, lastReadMessageId: "ro60", lastReadSeq: 60, lastReadAt: rows[59].createdAt }
  packet.selection = { reason: "tail", anchorMessageId: null }
  packet.newBoundary = { afterSeq: 60, target: null }
  packet.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 60 }
  await seedConversationEntry(owner.client, packet)
  load.mockResolvedValue(packet)
  const href = "/c/me/c1"
  let navigation = { entryIntent: { href }, publishedHref: href, pendingHref: null, navigationPending: false }
  let nextIntent: { href: string } | null = null
  let feed!: ReturnType<typeof useDmMessages>
  let newDivider: string | undefined
  const handovers = vi.fn(() => feed.onUserTakeover())
  function Probe() {
    feed = useDmMessages("c1")
    const newBoundary = feed.newBoundary
    newDivider = newBoundary?.target?.id
    return <MessageList channel="DM" variant="dm" messages={feed.messages} loading={feed.isLoading}
      initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
      initialScrollReady={feed.initialDisplayReady} preserveInitialPresentation={feed.preserveInitialPresentation}
      positionScope={feed.positionScope} positionEntry={feed.positionEntry}
      positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
      messageNeighborhood={feed.messageNeighborhood} onReadingMessage={feed.onReadingMessage}
      initialPositionMessageId={feed.initialPositionMessageId} newDividerBefore={newDivider}
      hasMore={feed.hasMoreOlder} hasMoreNewer={feed.hasMoreNewer}
      isFetching={feed.isFetching} isFetchingOlder={feed.isFetchingOlder} isFetchingNewer={feed.isFetchingNewer}
      onUserTakeover={handovers} onRetryInitialLoad={feed.retryInitialLoad} retryingInitialLoad={feed.retryingInitialLoad} onOpenThread={() => {}} />
  }
  function Page() {
    return <CommunityTestProvider {...owner}>
      <CommunityRouteContext value={{ breakpoint: "mobile", frame: { revision: nextIntent ? 2 : 1 }, navigation } as never}>
        <Probe />
      </CommunityRouteContext>
    </CommunityTestProvider>
  }
  const view = render(<Page />)
  const phases: unknown[] = []
  const writes: unknown[] = []
  let phase = "warm"
  let inputs = 0
  const input = () => { inputs++ }
  const current = () => preCommand.latest as ScrollResult
  const geometry = () => {
    const root = view.getByTestId("community-message-scroller")
    return { at: performance.now(), scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight,
      distanceToEnd: root.scrollHeight - root.clientHeight - root.scrollTop, outcome: current().positionOutcome,
      readReady: current().readPositionReady, inputCount: inputs, first: feed.messages[0]?.id, last: feed.messages.at(-1)?.id }
  }
  try {
    resize()
    const root = view.getByTestId("community-message-scroller")
    const native = current().virtualizer
    expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeLessThanOrEqual(1)
    for (const kind of ["wheel", "keydown", "pointerdown", "touchstart"]) root.addEventListener(kind, input)
    phase = "old-user-setup"
    fireEvent.wheel(root, { deltaY: -2000 })
    act(() => root.scrollTo({ top: 2000 }))
    resize()
    expect(root.scrollTop).toBeGreaterThan(0)
    expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeGreaterThan(500)
    expect(native.isScrolling).toBe(false)
    const selected = native.getVirtualItems().findLast(row => String(row.key).startsWith("msg:") && row.end <= root.scrollTop)
    expect(selected, "Preparation invalid: no mounted above-fold row").toBeDefined()
    const wrapper = root.querySelector<HTMLElement>("[data-index='" + selected!.index + "']")
    expect(wrapper, "Preparation invalid: native row wrapper is not mounted").not.toBeNull()
    expect(wrapper!.querySelector<HTMLElement>("[data-message-row-key]")?.dataset.messageRowKey).toBe(String(selected!.key))
    const body = wrapper!.querySelector<HTMLElement>("[data-msg-id]")
    expect(body, "Preparation invalid: mounted row has no message body").not.toBeNull()
    const id = body!.dataset.msgId!
    expect(id).toBeTruthy()
    const bodyHeight = body!.getBoundingClientRect().height
    const originalScrollTo = HTMLElement.prototype.scrollTo
    vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function(this: HTMLElement, ...args: [options?: ScrollToOptions] | [x: number, y: number]) {
      const before = this.scrollTop
      Reflect.apply(originalScrollTo, this, args)
      writes.push({ phase, before, requested: typeof args[0] === "number" ? args[1] : args[0]?.top, after: this.scrollTop, inputCount: inputs,
        nativeResizeStack: new Error().stack?.split("\n").filter(line => /resizeItem|applyScrollAdjustment|_scrollToOffset/.test(line)) })
    })
    const end = vi.spyOn(native, "scrollToEnd")
    const measure = vi.spyOn(native, "resizeItem")
    const inputBaseline = inputs
    handovers.mockClear()
    nextIntent = { href }
    navigation = { ...navigation, entryIntent: nextIntent }
    phase = "new-entry-before-first-frame"
    view.rerender(<Page />)
    expect(view.getByTestId("community-message-scroller")).toBe(root)
    expect(current().virtualizer).toBe(native)
    expect(native.scrollElement).toBe(root)
    expect(feed.positionEntry).toBe(nextIntent)
    expect(feed.readSnapshot?.lastReadMessageId).toBe("ro60")
    expect(feed.readSnapshot?.lastReadSeq).toBe(60)
    expect(feed.initialPositionMessageId).toBeNull()
    expect(newDivider).toBeUndefined()
    expect(feed.positionDataState).toBe("ready")
    expect(native.options.anchorTo).toBe("start")
    expect(end).not.toHaveBeenCalled()
    const origin = root.scrollTop
    phases.push({ phase, ...geometry(), pointer: feed.readSnapshot?.lastReadSeq, initialTarget: feed.initialPositionMessageId, newDivider })
    if (external) {
      phase = "external-unlabelled-negative-control"
      act(() => root.scrollTo({ top: origin + 100 }))
      phases.push({ phase, ...geometry() })
    }
    const beforeNative = root.scrollTop
    phase = "one-row-native-ro"
    scrollFixture.bodyHeights.set(id, bodyHeight + 40)
    resize(0)
    phases.push({ phase, ...geometry(), row: id, nativeResizeCalls: measure.mock.calls.map(([index, size]) => ({ index, size })),
      firstEndCalls: end.mock.calls.length, nativeOffset: native.scrollOffset })
    expect(measure.mock.calls.some(([index]) => index === selected!.index), "Preparation invalid: selected row was not measured through RO").toBe(true)
    expect(Math.abs(root.scrollTop - beforeNative), "Preparation invalid: no automatic native offset change").toBeGreaterThan(1)
    expect(inputs).toBe(inputBaseline)
    expect(end).not.toHaveBeenCalled()
    phase = "new-entry-first-frames"
    runFrames()
    phases.push({ phase, ...geometry(), firstEndCalls: end.mock.calls.length, newHandovers: handovers.mock.calls.length })
    const decisions = preCommand.finishes.filter(event => event.entry === nextIntent)
    expect(decisions.some(event => event.source === "tail"), "Preparation invalid: no actual tail decision").toBe(true)
    expect(inputs).toBe(inputBaseline)
    if (external) {
      expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeGreaterThan(500)
      expect(decisions.some(event => event.reason === "origin_changed")).toBe(true)
      expect(handovers).toHaveBeenCalledOnce()
      expect(end).not.toHaveBeenCalled()
    } else {
      expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeLessThanOrEqual(1)
      expect(decisions.some(event => event.reason === "origin_changed")).toBe(false)
      expect(handovers).not.toHaveBeenCalled()
      expect(end).toHaveBeenCalledOnce()
    }
  } finally {
    console.info("pre-command-row-measurement-facts", JSON.stringify({ phases, writes, decisions: preCommand.finishes.map(({ kind, entry, reason, source }) => ({ kind, entry: entry === nextIntent ? "new" : "old", reason, source })) }))
    view.unmount()
    owner.client.clear()
  }
})
