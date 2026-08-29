import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const effects: Array<() => void | (() => void)> = []
const queryClient = {}
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
const refState = vi.hoisted(() => {
  let cursor = 0
  const slots: Array<{ current: unknown }> = []
  return {
    persistent: false,
    beginRender() {
      cursor = 0
    },
    next(initial: unknown) {
      const index = cursor++
      const existing = slots[index]
      if (existing) return existing
      const value = { current: initial }
      slots[index] = value
      return value
    },
    reset() {
      this.persistent = false
      cursor = 0
      slots.length = 0
    },
  }
})

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (initial: unknown) => {
    if (!refState.persistent) return { current: initial }
    return refState.next(initial)
  },
  useState: (initial: unknown) => initial === null
    ? [hookState.candidate, (next: unknown) => {
        hookState.candidate = typeof next === "function"
          ? (next as (value: typeof hookState.candidate) => typeof hookState.candidate)(hookState.candidate)
          : next as typeof hookState.candidate
      }]
    : [initial, vi.fn()],
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
  useLayoutEffect: (effect: () => void | (() => void)) => effects.push(effect),
}))

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => queryClient,
}))

vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "viewer-1", name: "Viewer", avatar: "V" }),
}))

vi.mock("./read-coordinator", () => ({
  registerReadSurface: (...args: unknown[]) => coordinator.register(...args),
  releaseReadSurface: (...args: unknown[]) => coordinator.release(...args),
  confirmReadSurface: (...args: unknown[]) => coordinator.confirm(...args),
  resumeReadCoordinator: (...args: unknown[]) => coordinator.resume(...args),
  submitReadIntentGeneration: (...args: unknown[]) => coordinator.submit(...args),
}))

vi.mock("./inbox-read-reservation", () => ({
  registerInboxReadReservationSurface: (...args: unknown[]) => reservation.register(...args),
  releaseInboxReadReservationSurface: (...args: unknown[]) => reservation.release(...args),
  promoteInboxReadReservation: (...args: unknown[]) => reservation.promote(...args),
  takeInboxReadReservationNegative: (...args: unknown[]) => reservation.negative(...args),
}))

vi.mock("./account-unread-projection", () => ({
  getAccountUnreadProjection: () => projection,
}))

import { useTimelineReadObserver } from "./use-read-observer"

type ObserverRecord = {
  callback: IntersectionObserverCallback
  observed: Set<Element>
  disconnected: boolean
}

let observers: ObserverRecord[]
let visibility: DocumentVisibilityState
let visibilityListeners: Set<() => void>
let pageShowListeners: Set<() => void>
let mutationCallback: MutationCallback | undefined

class FakeIntersectionObserver {
  private readonly record: ObserverRecord

  constructor(callback: IntersectionObserverCallback) {
    this.record = { callback, observed: new Set(), disconnected: false }
    observers.push(this.record)
  }

  observe(element: Element) {
    this.record.observed.add(element)
  }

  unobserve(element: Element) {
    this.record.observed.delete(element)
  }

  disconnect() {
    this.record.disconnected = true
    this.record.observed.clear()
  }
}

function makeRow(id: string) {
  return {
    nodeType: 1,
    dataset: { msgId: id },
    matches: (selector: string) => selector === "[data-msg-id]",
    querySelectorAll: () => [],
  } as unknown as HTMLElement
}

function makeRoot(rows: HTMLElement[]) {
  return {
    querySelectorAll: () => rows,
    contains: (node: Element) => rows.includes(node as HTMLElement),
  } as unknown as HTMLElement
}

function runEffects() {
  return effects.splice(0).map((effect) => effect()).filter(
    (cleanup): cleanup is () => void => typeof cleanup === "function",
  )
}

function trigger(record: ObserverRecord, target: Element, ratio = 1) {
  record.callback([{
    target,
    isIntersecting: true,
    intersectionRatio: ratio,
  } as IntersectionObserverEntry], {} as IntersectionObserver)
}

function useTestRender(options: Partial<Parameters<typeof useTimelineReadObserver>[0]> = {}) {
  if (refState.persistent) refState.beginRender()
  const row = makeRow("message-4")
  const root = makeRoot([row])
  useTimelineReadObserver({
    channelId: "channel-1",
    messages: [{ id: "message-4", seq: 4, authorId: "other-1", createdAt: "t4" }] as any,
    scrollRootEl: root,
    snapshotStatus: "ready",
    feedStatus: "ready",
    tailAttached: true,
    confirmedSeq: 2,
    catchUp: () => Promise.resolve(),
    ...options,
  })
  return { row, root }
}

describe("useTimelineReadObserver", () => {
  beforeEach(() => {
    effects.length = 0
    observers = []
    visibility = "visible"
    visibilityListeners = new Set()
    pageShowListeners = new Set()
    mutationCallback = undefined
    hookState.candidate = null
    refState.reset()
    vi.clearAllMocks()
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
    vi.stubGlobal("MutationObserver", class {
      constructor(callback: MutationCallback) {
        mutationCallback = callback
      }

      observe() {}
      disconnect() {}
    })
    vi.stubGlobal("document", {
      get visibilityState() {
        return visibility
      },
      addEventListener: (type: string, listener: () => void) => {
        if (type === "visibilitychange") visibilityListeners.add(listener)
      },
      removeEventListener: (_type: string, listener: () => void) => {
        visibilityListeners.delete(listener)
      },
    })
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: () => void) => {
        if (type === "pageshow") pageShowListeners.add(listener)
      },
      removeEventListener: (_type: string, listener: () => void) => {
        pageShowListeners.delete(listener)
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("accepts only after the snapshot-ready observer sees a visible foreign row", () => {
    useTestRender({ snapshotStatus: "pending" })
    runEffects()
    expect(coordinator.register).toHaveBeenCalled()
    trigger(observers[0]!, makeRow("message-4"))
    expect(coordinator.submit).not.toHaveBeenCalled()

    effects.length = 0
    vi.clearAllMocks()
    const { row } = useTestRender({ snapshotStatus: "ready" })
    runEffects()
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
    runEffects()

    trigger(observers[0]!, row)

    expect(projection.recordOptimisticRead).not.toHaveBeenCalled()
    expect(reservation.promote).not.toHaveBeenCalled()
  })

  it("keeps observing visible rows when MutationObserver is unavailable", () => {
    vi.stubGlobal("MutationObserver", undefined)
    const { row } = useTestRender()
    const cleanups = runEffects()

    expect(observers).toHaveLength(1)
    trigger(observers[0]!, row)
    expect(coordinator.submit).toHaveBeenCalledOnce()

    for (const cleanup of cleanups) cleanup()
    expect(observers[0]!.disconnected).toBe(true)
  })

  it("submits only the visible forum-card prefix candidate and preserves unseen newer siblings", () => {
    const rows = [makeRow("opener-a"), makeRow("opener-b"), makeRow("opener-c")]
    const root = makeRoot(rows)
    useTestRender({
      channelId: "forum-1",
      messages: [
        { id: "opener-a", seq: 1, authorId: "alice" },
        { id: "opener-b", seq: 2, authorId: "alice" },
        { id: "opener-c", seq: 3, authorId: "alice" },
      ],
      scrollRootEl: root,
      confirmedSeq: 0,
    })
    runEffects()

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
    runEffects()
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
    runEffects()
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
    runEffects()
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
    runEffects()
    expect(reservation.negative).not.toHaveBeenCalled()

    effects.length = 0
    vi.clearAllMocks()
    hookState.candidate = {
      channelId: "channel-1",
      lastMessageAt: "t4",
      fingerprint: "focused-t4",
      openerUnread: false,
    }
    useTestRender({ scrollRootEl: makeRoot([]) })
    runEffects()
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
    runEffects()
    expect(catchUp).toHaveBeenCalledOnce()
    expect(reservation.negative).not.toHaveBeenCalled()
    await catchUp.mock.results[0]!.value
    await Promise.resolve()

    effects.length = 0
    hookState.candidate = candidate
    useTestRender({ catchUp, messages })
    runEffects()
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
    runEffects()
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
    runEffects()
    trigger(observers[0]!, row, 0.1)
    expect(reservation.negative).toHaveBeenCalledWith({ lease: "reservation" })
    expect(coordinator.submit).not.toHaveBeenCalled()
  })

  it("fences a recycled node and a callback from a released route scope", () => {
    const { row } = useTestRender()
    const cleanups = runEffects()
    const record = observers[0]!

    row.dataset.msgId = "message-recycled"
    trigger(record, row)
    expect(coordinator.submit).not.toHaveBeenCalled()

    row.dataset.msgId = "message-4"
    for (const cleanup of cleanups) cleanup()
    trigger(record, row)
    expect(coordinator.submit).not.toHaveBeenCalled()
    expect(coordinator.release).toHaveBeenCalledWith({ lease: "timeline" })
  })

  it("binds direct and nested message rows added after the observer mounts", () => {
    useTestRender()
    runEffects()
    const direct = makeRow("message-4")
    const nested = makeRow("message-4")
    const wrapper = {
      nodeType: 1,
      matches: () => false,
      querySelectorAll: () => [nested],
    } as unknown as Element

    mutationCallback?.([
      { addedNodes: [direct as unknown as Node] } as unknown as MutationRecord,
      { addedNodes: [{ nodeType: 3 } as Node, wrapper as unknown as Node] } as unknown as MutationRecord,
    ], {} as MutationObserver)

    expect(observers[0]!.observed.has(direct)).toBe(true)
    expect(observers[0]!.observed.has(nested)).toBe(true)
  })
})
