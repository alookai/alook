import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createElement, type PropsWithChildren } from "react"
import { act, renderHook, type RenderHookResult } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { ingestMessages } from "@/lib/community-db/sync"

let owner: Awaited<ReturnType<typeof createCommunityQueryOwner>>
let queryClient: Awaited<ReturnType<typeof createCommunityQueryOwner>>["client"]
const unmounts: Array<() => void> = []
let activeView: RenderHookResult<void, Parameters<typeof useTimelineReadObserver>[0]> | undefined
const coordinator = vi.hoisted(() => ({
  register: vi.fn(() => ({ lease: "timeline" })),
  release: vi.fn(),
  confirm: vi.fn(),
  resume: vi.fn(),
  submit: vi.fn(() => 1),
}))
const reservation = vi.hoisted(() => ({
  register: vi.fn(() => ({ lease: "reservation" })),
  release: vi.fn(),
  promote: vi.fn(),
  negative: vi.fn(() => true),
}))
const projection = vi.hoisted(() => ({
  recordOptimisticRead: vi.fn(),
}))
const hookState = vi.hoisted(() => ({
  candidate: null as null | {
    channelId: string
    lastMessageAt: string
    fingerprint: string
    openerUnread: boolean
  },
}))
const refState = { persistent: false, reset() { this.persistent = false } }

vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "viewer-1", name: "Viewer", avatar: "V" }),
}))

vi.mock("./read-coordinator", async () => ({
  ...await vi.importActual<typeof import("./read-coordinator")>("./read-coordinator"),
  registerReadSurface: (...args: unknown[]) => coordinator.register(...args),
  releaseReadSurface: (...args: unknown[]) => coordinator.release(...args),
  confirmReadSurface: (...args: unknown[]) => coordinator.confirm(...args),
  resumeReadCoordinator: (...args: unknown[]) => coordinator.resume(...args),
  submitReadIntentGeneration: (...args: unknown[]) => coordinator.submit(...args),
}))

vi.mock("./inbox-read-reservation", async () => ({
  ...await vi.importActual<typeof import("./inbox-read-reservation")>("./inbox-read-reservation"),
  registerInboxReadReservationSurface: (...args: unknown[]) => reservation.register(...args),
  releaseInboxReadReservationSurface: (...args: unknown[]) => reservation.release(...args),
  promoteInboxReadReservation: (...args: unknown[]) => reservation.promote(...args),
  takeInboxReadReservationNegative: (...args: unknown[]) => reservation.negative(...args),
}))

vi.mock("./account-unread-projection", async () => ({
  ...await vi.importActual<typeof import("./account-unread-projection")>("./account-unread-projection"),
  getAccountUnreadProjection: () => projection,
}))

import { useTimelineReadObserver } from "./use-read-observer"

type ObserverRecord = {
  callback: IntersectionObserverCallback
  observed: Set<Element>
  queued: IntersectionObserverEntry[]
  actions: string[]
  disconnected: boolean
}

let observers: ObserverRecord[]
let visibility: DocumentVisibilityState
let visibilityListeners: Set<() => void>
let pageShowListeners: Set<() => void>
let mutationCallback: MutationCallback | undefined
let mutationObserveOptions: MutationObserverInit | undefined
let mutationObservedTarget: Node | undefined

class FakeIntersectionObserver {
  private readonly record: ObserverRecord

  constructor(callback: IntersectionObserverCallback) {
    this.record = {
      callback,
      observed: new Set(),
      queued: [],
      actions: [],
      disconnected: false,
    }
    observers.push(this.record)
  }

  observe(element: Element) {
    this.record.actions.push(`observe:${(element as HTMLElement).dataset.msgId ?? "unknown"}`)
    this.record.observed.add(element)
  }

  unobserve(element: Element) {
    this.record.actions.push(`unobserve:${(element as HTMLElement).dataset.msgId ?? "unknown"}`)
    this.record.observed.delete(element)
  }

  takeRecords() {
    this.record.actions.push("takeRecords")
    return this.record.queued.splice(0)
  }

  disconnect() {
    this.record.disconnected = true
    this.record.observed.clear()
  }
}

function makeRow(id: string) {
  const row = document.createElement("div")
  row.dataset.msgId = id
  return row
}

type ContentBoundary = HTMLElement & {
  setAriaHidden: (hidden: boolean) => void
  setInert: (inert: boolean) => void
  setReadable: (readable: boolean) => void
}
function makeContentBoundary(initiallyReadable = true): ContentBoundary {
  const boundary = document.createElement("div")
  boundary.setAttribute("data-message-list-content", "")
  const setAriaHidden = (hidden: boolean) => boundary.setAttribute("aria-hidden", String(hidden))
  const setInert = (inert: boolean) => boundary.toggleAttribute("inert", inert)
  const setReadable = (readable: boolean) => { setAriaHidden(!readable); setInert(!readable) }
  setReadable(initiallyReadable)
  return Object.assign(boundary, { setAriaHidden, setInert, setReadable })
}
function makeRoot(rows: HTMLElement[], boundary: ContentBoundary | null = makeContentBoundary()) {
  const root = document.createElement("div")
  if (boundary) { boundary.append(...rows); root.append(boundary) }
  else root.append(...rows)
  return root
}
function takeUnmounts() { return unmounts.splice(0) }

function trigger(record: ObserverRecord, target: Element, ratio = 1) {
  const entry = {
    target,
    time: performance.now(),
    isIntersecting: true,
    intersectionRatio: ratio,
  } as IntersectionObserverEntry
  act(() => record.callback([entry], {} as IntersectionObserver))
}

function queueEntry(record: ObserverRecord, target: Element, ratio = 1) {
  record.queued.push({
    target,
    time: performance.now(),
    isIntersecting: true,
    intersectionRatio: ratio,
  } as IntersectionObserverEntry)
}

function deliverQueued(record: ObserverRecord) {
  act(() => record.callback(record.queued.splice(0), {} as IntersectionObserver))
}

function presentationAttributeRecord(
  boundary: ContentBoundary,
  attributeName: "aria-hidden" | "inert" | "data-read-position-ready",
) {
  return {
    type: "attributes",
    target: boundary,
    attributeName,
    addedNodes: [] as unknown as NodeList,
  } as MutationRecord
}

function setPresentationAttributeReadable(
  boundary: ContentBoundary,
  attributeName: "aria-hidden" | "inert" | "data-read-position-ready",
) {
  if (attributeName === "aria-hidden") boundary.setAriaHidden(false)
  else boundary.setInert(false)
}

function useTestRender(options: Partial<Parameters<typeof useTimelineReadObserver>[0]> = {}) {
  const row = makeRow("message-4"), root = makeRoot([row])
  const props: Parameters<typeof useTimelineReadObserver>[0] = {
    channelId: "channel-1",
    messages: [{ id: "message-4", seq: 4, authorId: "other-1", createdAt: "t4" }],
    scrollRootEl: root, snapshotStatus: "ready", feedStatus: "ready", tailAttached: true,
    confirmedSeq: 2, catchUp: () => Promise.resolve(), ...options,
  }
  act(() => ingestMessages(owner.registry, props.channelId ?? "channel-1", props.messages.map((message) => ({ ...message, type: "chat" }))))
  if (refState.persistent && activeView) activeView.rerender(props)
  else {
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "viewer-1", retainOwner: true }, children)
    activeView = renderHook(useTimelineReadObserver, { wrapper, initialProps: props })
    unmounts.push(activeView.unmount)
  }
  return { row, root }
}

describe("useTimelineReadObserver", () => {
  beforeEach(async () => {
    owner = await createCommunityQueryOwner("viewer-1")
    queryClient = owner.client
    activeView = undefined
    unmounts.length = 0
    observers = []
    visibility = "visible"
    visibilityListeners = new Set()
    pageShowListeners = new Set()
    mutationCallback = undefined
    mutationObserveOptions = undefined
    mutationObservedTarget = undefined
    hookState.candidate = null
    refState.reset()
    vi.clearAllMocks()
    reservation.register.mockImplementation((_client, _channelId, setCandidate) => {
      if (hookState.candidate) setCandidate(hookState.candidate)
      return { lease: "reservation" }
    })
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
    vi.stubGlobal("MutationObserver", class {
      constructor(callback: MutationCallback) {
        mutationCallback = callback
      }

      observe(target: Node, options?: MutationObserverInit) {
        mutationObservedTarget = target
        mutationObserveOptions = options
      }
      disconnect() {}
    })
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility)
    const addDocument = document.addEventListener.bind(document), removeDocument = document.removeEventListener.bind(document)
    vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
      if (type === "visibilitychange") visibilityListeners.add(listener as () => void)
      addDocument(type, listener, options)
    })
    vi.spyOn(document, "removeEventListener").mockImplementation((type, listener, options) => {
      visibilityListeners.delete(listener as () => void); removeDocument(type, listener, options)
    })
    const addWindow = window.addEventListener.bind(window), removeWindow = window.removeEventListener.bind(window)
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
      if (type === "pageshow") pageShowListeners.add(listener as () => void)
      addWindow(type, listener, options)
    })
    vi.spyOn(window, "removeEventListener").mockImplementation((type, listener, options) => {
      pageShowListeners.delete(listener as () => void); removeWindow(type, listener, options)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("accepts only after the snapshot-ready observer sees a visible foreign row", () => {
    useTestRender({ snapshotStatus: "pending" })
    takeUnmounts()
    expect(coordinator.register).toHaveBeenCalled()
    trigger(observers[0]!, makeRow("message-4"))
    expect(coordinator.submit).not.toHaveBeenCalled()

    unmounts.length = 0
    vi.clearAllMocks()
    const { row } = useTestRender({ snapshotStatus: "ready" })
    takeUnmounts()
    expect(coordinator.register).toHaveBeenCalledWith(
      queryClient,
      "viewer-1",
      { kind: "timeline", channelId: "channel-1" },
    )
    expect(coordinator.confirm).toHaveBeenCalledWith({ lease: "timeline" }, 2)
    trigger(observers.at(-1)!, row)
    expect(coordinator.submit).toHaveBeenCalledWith({ lease: "timeline" }, {
      kind: "timeline",
      channelId: "channel-1",
      messageId: "message-4",
      seq: 4,
    })
    expect(projection.recordOptimisticRead).toHaveBeenCalledWith("channel-1", 4, 1)
  })

  it("does not clear projection or promote an Inbox lease when the coordinator rejects intent", () => {
    coordinator.submit.mockReturnValueOnce(null)
    const { row } = useTestRender()
    takeUnmounts()

    trigger(observers[0]!, row)

    expect(projection.recordOptimisticRead).not.toHaveBeenCalled()
    expect(reservation.promote).not.toHaveBeenCalled()
  })

  it("keeps observing visible rows when MutationObserver is unavailable", () => {
    vi.stubGlobal("MutationObserver", undefined)
    const { row } = useTestRender()
    const cleanups = takeUnmounts()

    expect(observers).toHaveLength(1)
    trigger(observers[0]!, row)
    expect(coordinator.submit).toHaveBeenCalledOnce()

    for (const unmount of cleanups) unmount()
    expect(observers[0]!.disconnected).toBe(true)
  })

  it("keeps a no-boundary forum surface readable for intent, negative classification, and resume", () => {
    hookState.candidate = {
      channelId: "forum-1",
      lastMessageAt: "t3",
      fingerprint: "forum-t3",
      openerUnread: true,
    }
    const rows = [makeRow("opener-a"), makeRow("opener-b"), makeRow("opener-c")]
    const root = makeRoot(rows, null)
    useTestRender({
      channelId: "forum-1",
      messages: [
        { id: "opener-a", seq: 1, authorId: "alice" },
        { id: "opener-b", seq: 2, authorId: "alice" },
        { id: "opener-c", seq: 3, authorId: "alice" },
      ],
      scrollRootEl: root,
      tailAttached: false,
      confirmedSeq: 0,
    })
    takeUnmounts()

    expect(root.querySelector("[data-message-list-content]")).toBeNull()
    expect(reservation.negative).toHaveBeenCalledWith({ lease: "reservation" })
    expect(coordinator.resume).toHaveBeenCalledWith(queryClient)
    trigger(observers[0]!, rows[0]!)

    expect(coordinator.submit).toHaveBeenCalledOnce()
    expect(coordinator.submit).toHaveBeenCalledWith({ lease: "timeline" }, {
      kind: "timeline",
      channelId: "forum-1",
      messageId: "opener-a",
      seq: 1,
    })
  })

  it("rejects hidden callbacks and re-samples the static row on foreground", () => {
    const { row } = useTestRender()
    takeUnmounts()
    visibility = "hidden"
    trigger(observers[0]!, row)
    expect(coordinator.submit).not.toHaveBeenCalled()
    expect(reservation.negative).toHaveBeenCalledWith({ lease: "reservation" })
    for (const listener of visibilityListeners) listener()

    visibility = "visible"
    for (const listener of visibilityListeners) listener()
    expect(coordinator.resume).toHaveBeenCalledWith(queryClient)
    trigger(observers[0]!, row)
    expect(coordinator.submit).toHaveBeenCalledOnce()
  })

  it("keeps all read side effects silent while presentation is hidden and inert", () => {
    hookState.candidate = {
      channelId: "channel-1",
      lastMessageAt: "t4",
      fingerprint: "focused-t4",
      openerUnread: false,
    }
    const row = makeRow("message-4")
    const boundary = makeContentBoundary(false)
    useTestRender({
      scrollRootEl: makeRoot([row], boundary),
      tailAttached: false,
    })
    takeUnmounts()

    trigger(observers[0]!, row)
    for (const listener of visibilityListeners) listener()
    for (const listener of pageShowListeners) listener()

    expect(coordinator.submit).not.toHaveBeenCalled()
    expect(projection.recordOptimisticRead).not.toHaveBeenCalled()
    expect(reservation.promote).not.toHaveBeenCalled()
    expect(reservation.negative).not.toHaveBeenCalled()
    expect(coordinator.resume).not.toHaveBeenCalled()
  })

  it("keeps revealed semantic-pending content silent, drains old records, and opens on fresh geometry", () => {
    hookState.candidate = { channelId: "channel-1", lastMessageAt: "t4", fingerprint: "semantic-t4", openerUnread: false }
    const row = makeRow("message-4")
    const boundary = makeContentBoundary(true)
    boundary.setAttribute("data-read-position-ready", "false")
    useTestRender({ scrollRootEl: makeRoot([row], boundary) })
    takeUnmounts()
    const record = observers[0]!
    trigger(record, row)
    queueEntry(record, row)
    const stale = record.queued[0]!
    expect(coordinator.submit).not.toHaveBeenCalled()
    expect(projection.recordOptimisticRead).not.toHaveBeenCalled()
    expect(reservation.promote).not.toHaveBeenCalled()
    boundary.setAttribute("data-read-position-ready", "true")
    act(() => mutationCallback!([presentationAttributeRecord(boundary, "data-read-position-ready")], {} as MutationObserver))
    expect(record.queued).toHaveLength(0)
    act(() => record.callback([stale], {} as IntersectionObserver))
    expect(coordinator.submit).not.toHaveBeenCalled()
    trigger(record, row)
    expect(coordinator.submit).toHaveBeenCalledOnce()
    expect(projection.recordOptimisticRead).toHaveBeenCalledOnce()
    expect(reservation.promote).toHaveBeenCalledOnce()
  })

  it.each([
    { snapshotStatus: "error" as const },
    { feedStatus: "error" as const },
    { tailAttached: false },
  ])("negatively classifies an unusable ready surface: $snapshotStatus$feedStatus$tailAttached", (options) => {
    hookState.candidate = {
      channelId: "channel-1",
      lastMessageAt: "t4",
      fingerprint: "focused-t4",
      openerUnread: false,
    }
    useTestRender(options)
    takeUnmounts()
    expect(reservation.negative).toHaveBeenCalledWith({ lease: "reservation" })
  })

  it("negatively classifies a hidden ready surface before correlating messages", () => {
    hookState.candidate = {
      channelId: "channel-1",
      lastMessageAt: "t4",
      fingerprint: "focused-t4",
      openerUnread: false,
    }
    visibility = "hidden"
    useTestRender()
    takeUnmounts()
    expect(reservation.negative).toHaveBeenCalledWith({ lease: "reservation" })
  })

  it("correlates duplicate timestamps to the highest sequence and requires its DOM node", () => {
    hookState.candidate = {
      channelId: "channel-1",
      lastMessageAt: "t4",
      fingerprint: "focused-t4",
      openerUnread: false,
    }
    const high = makeRow("message-high")
    useTestRender({
      messages: [
        { id: "message-low", seq: 2, authorId: "other-1", createdAt: "t4" },
        { id: "message-high", seq: 5, authorId: "other-1", createdAt: "t4" },
      ],
      scrollRootEl: makeRoot([high]),
    })
    takeUnmounts()
    expect(reservation.negative).not.toHaveBeenCalled()

    unmounts.length = 0
    vi.clearAllMocks()
    hookState.candidate = {
      channelId: "channel-1",
      lastMessageAt: "t4",
      fingerprint: "focused-t4",
      openerUnread: false,
    }
    useTestRender({ scrollRootEl: makeRoot([]) })
    takeUnmounts()
    expect(reservation.negative).toHaveBeenCalledWith({ lease: "reservation" })
  })

  it("starts one catch-up for an unordered behind tail, then settles that fingerprint", async () => {
    refState.persistent = true
    const candidate = {
      channelId: "channel-1",
      lastMessageAt: "t9",
      fingerprint: "focused-t9",
      openerUnread: false,
    }
    hookState.candidate = candidate
    const catchUp = vi.fn().mockResolvedValue(undefined)
    const messages = [
      { id: "message-8", seq: 8, authorId: "other-1", createdAt: "t8" },
      { id: "message-7", seq: 7, authorId: "other-1", createdAt: "t7" },
    ] as any[]
    useTestRender({ catchUp, messages })
    takeUnmounts()
    expect(catchUp).toHaveBeenCalledOnce()
    expect(reservation.negative).not.toHaveBeenCalled()
    await act(async () => { await catchUp.mock.results[0]!.value })
    expect(reservation.negative).toHaveBeenCalledOnce()
    reservation.negative.mockClear()

    unmounts.length = 0
    hookState.candidate = candidate
    useTestRender({ catchUp, messages })
    takeUnmounts()
    expect(catchUp).toHaveBeenCalledOnce()
    expect(reservation.negative).toHaveBeenCalledOnce()
    expect(reservation.negative).toHaveBeenCalledWith({ lease: "reservation" })
  })

  it.each([
    { messages: [] as any[] },
    { messages: [{ id: "message-10", seq: 10, authorId: "other-1", createdAt: "u10" }] as any[] },
  ])("negatively classifies a missing candidate after the loaded tail is authoritative", ({ messages }) => {
    hookState.candidate = {
      channelId: "channel-1",
      lastMessageAt: "t9",
      fingerprint: "focused-t9",
      openerUnread: false,
    }
    useTestRender({ messages })
    takeUnmounts()
    expect(reservation.negative).toHaveBeenCalledWith({ lease: "reservation" })
  })

  it("negatively classifies the correlated row below the visibility threshold", () => {
    hookState.candidate = {
      channelId: "channel-1",
      lastMessageAt: "t4",
      fingerprint: "focused-t4",
      openerUnread: false,
    }
    const { row } = useTestRender()
    takeUnmounts()
    trigger(observers[0]!, row, 0.1)
    expect(reservation.negative).toHaveBeenCalledWith({ lease: "reservation" })
    expect(coordinator.submit).not.toHaveBeenCalled()
  })

  it("fences a recycled node and a callback from a released route scope", () => {
    const { row } = useTestRender()
    const cleanups = takeUnmounts()
    const record = observers[0]!

    row.dataset.msgId = "message-recycled"
    trigger(record, row)
    expect(coordinator.submit).not.toHaveBeenCalled()

    row.dataset.msgId = "message-4"
    for (const unmount of cleanups) unmount()
    trigger(record, row)
    expect(coordinator.submit).not.toHaveBeenCalled()
    expect(coordinator.release).toHaveBeenCalledWith({ lease: "timeline" })
    expect(reservation.release.mock.invocationCallOrder[0]).toBeLessThan(
      coordinator.release.mock.invocationCallOrder[0]!,
    )
  })

  it("binds direct and nested message rows added after the observer mounts", () => {
    useTestRender()
    takeUnmounts()
    const direct = makeRow("message-4")
    const nested = makeRow("message-4")
    const wrapper = document.createElement("div")
    wrapper.append(nested)

    mutationCallback?.([
      { addedNodes: [direct as unknown as Node] } as unknown as MutationRecord,
      { addedNodes: [{ nodeType: 3 } as Node, wrapper as unknown as Node] } as unknown as MutationRecord,
    ], {} as MutationObserver)

    expect(observers[0]!.observed.has(direct)).toBe(true)
    expect(observers[0]!.observed.has(nested)).toBe(true)
  })

  it("drains a hidden queued entry before rebinding the same node for reveal", () => {
    const row = makeRow("message-4")
    const boundary = makeContentBoundary(false)
    const root = makeRoot([row], boundary)
    useTestRender({ scrollRootEl: root })
    takeUnmounts()
    const record = observers[0]!
    expect(mutationObservedTarget).toBe(root)
    expect(mutationObserveOptions).toEqual({
      attributes: true,
      attributeFilter: ["aria-hidden", "inert", "data-read-position-ready"],
      attributeOldValue: true,
      childList: true,
      subtree: true,
    })
    queueEntry(record, row)
    record.actions.length = 0

    boundary.setReadable(true)
    mutationCallback?.([{
      type: "attributes",
      target: boundary,
      attributeName: "aria-hidden",
      addedNodes: [] as unknown as NodeList,
    } as MutationRecord], {} as MutationObserver)

    const drainIndex = record.actions.indexOf("takeRecords")
    expect(drainIndex).toBeGreaterThan(record.actions.indexOf("unobserve:message-4"))
    expect(record.actions.findIndex((action, index) => (
      index > drainIndex && action === "observe:message-4"
    ))).toBeGreaterThan(drainIndex)

    deliverQueued(record)
    expect(coordinator.submit).not.toHaveBeenCalled()

    queueEntry(record, row)
    deliverQueued(record)
    expect(coordinator.submit).toHaveBeenCalledOnce()
  })

  it.each([
    {
      label: "aria-hidden then inert across two deliveries",
      first: "aria-hidden" as const,
      second: "inert" as const,
    },
    {
      label: "inert then aria-hidden across two deliveries",
      first: "inert" as const,
      second: "aria-hidden" as const,
    },
  ])("resamples once for $label", ({ first, second }) => {
    const row = makeRow("message-4")
    const boundary = makeContentBoundary(false)
    useTestRender({ scrollRootEl: makeRoot([row], boundary) })
    takeUnmounts()
    const record = observers[0]!
    record.actions.length = 0

    setPresentationAttributeReadable(boundary, first)
    mutationCallback?.([
      presentationAttributeRecord(boundary, first),
    ], {} as MutationObserver)
    expect(record.actions.filter((action) => action === "takeRecords")).toHaveLength(0)
    expect(coordinator.resume).not.toHaveBeenCalled()

    setPresentationAttributeReadable(boundary, second)
    mutationCallback?.([
      presentationAttributeRecord(boundary, second),
    ], {} as MutationObserver)
    expect(record.actions.filter((action) => action === "takeRecords")).toHaveLength(1)
    expect(coordinator.resume).toHaveBeenCalledOnce()

    mutationCallback?.([
      presentationAttributeRecord(boundary, second),
    ], {} as MutationObserver)
    expect(record.actions.filter((action) => action === "takeRecords")).toHaveLength(1)
    expect(coordinator.resume).toHaveBeenCalledOnce()
  })

  it("resamples once when both presentation attributes become readable in one delivery", () => {
    const row = makeRow("message-4")
    const boundary = makeContentBoundary(false)
    useTestRender({ scrollRootEl: makeRoot([row], boundary) })
    takeUnmounts()
    const record = observers[0]!
    record.actions.length = 0

    boundary.setAriaHidden(false)
    expect(record.actions.filter((action) => action === "takeRecords")).toHaveLength(0)
    expect(coordinator.resume).not.toHaveBeenCalled()

    boundary.setInert(false)
    mutationCallback?.([
      presentationAttributeRecord(boundary, "aria-hidden"),
      presentationAttributeRecord(boundary, "inert"),
    ], {} as MutationObserver)
    expect(record.actions.filter((action) => action === "takeRecords")).toHaveLength(1)
    expect(coordinator.resume).toHaveBeenCalledOnce()

    mutationCallback?.([
      presentationAttributeRecord(boundary, "aria-hidden"),
      presentationAttributeRecord(boundary, "inert"),
    ], {} as MutationObserver)
    expect(record.actions.filter((action) => action === "takeRecords")).toHaveLength(1)
    expect(coordinator.resume).toHaveBeenCalledOnce()
  })

  it("drains reveal entries but preserves the document-hidden negative return", () => {
    const row = makeRow("message-4")
    const boundary = makeContentBoundary(false)
    useTestRender({ scrollRootEl: makeRoot([row], boundary) })
    takeUnmounts()
    const record = observers[0]!
    queueEntry(record, row)
    record.actions.length = 0
    visibility = "hidden"

    boundary.setReadable(true)
    mutationCallback?.([{
      type: "attributes",
      target: boundary,
      attributeName: "aria-hidden",
      addedNodes: [] as unknown as NodeList,
    } as MutationRecord], {} as MutationObserver)

    expect(record.actions).toEqual(["unobserve:message-4", "takeRecords"])
    expect(record.queued).toHaveLength(0)
    expect(reservation.negative).toHaveBeenCalledOnce()
    expect(coordinator.resume).not.toHaveBeenCalled()

    visibility = "visible"
    for (const listener of visibilityListeners) listener()
    expect(record.actions.filter((action) => action === "takeRecords")).toHaveLength(1)
    expect(record.actions.at(-1)).toBe("observe:message-4")
    expect(coordinator.resume).toHaveBeenCalledOnce()
  })

  it("keeps ordinary visibility and pageshow samples independent and undrained", () => {
    const { row } = useTestRender()
    takeUnmounts()
    const record = observers[0]!
    coordinator.resume.mockClear()
    record.actions.length = 0

    for (const listener of visibilityListeners) listener()
    for (const listener of pageShowListeners) listener()

    expect(coordinator.resume).toHaveBeenCalledTimes(2)
    expect(record.actions.filter((action) => action === "takeRecords")).toHaveLength(0)
    expect(record.observed.has(row)).toBe(true)
  })
})
