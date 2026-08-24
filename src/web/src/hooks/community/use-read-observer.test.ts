import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const effects: Array<() => void | (() => void)> = []
const queryClient = {}
const coordinator = vi.hoisted(() => ({
  register: vi.fn(() => ({ lease: "timeline" })),
  release: vi.fn(),
  resume: vi.fn(),
  submit: vi.fn(() => true),
}))

vi.mock("react", () => ({
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
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
  resumeReadCoordinator: (...args: unknown[]) => coordinator.resume(...args),
  submitReadIntent: (...args: unknown[]) => coordinator.submit(...args),
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
  const row = makeRow("message-4")
  const root = makeRoot([row])
  useTimelineReadObserver({
    channelId: "channel-1",
    messages: [{ id: "message-4", seq: 4, authorId: "other-1" }] as any,
    scrollRootEl: root,
    snapshotReady: true,
    confirmedSeq: 2,
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
    useTestRender({ snapshotReady: false })
    runEffects()
    expect(observers).toHaveLength(0)
    expect(coordinator.register).not.toHaveBeenCalled()

    effects.length = 0
    const { row } = useTestRender({ snapshotReady: true })
    runEffects()
    expect(coordinator.register).toHaveBeenCalledWith(
      queryClient,
      "viewer-1",
      { kind: "timeline", channelId: "channel-1" },
      2,
    )
    trigger(observers[0]!, row)
    expect(coordinator.submit).toHaveBeenCalledWith({ lease: "timeline" }, {
      kind: "timeline",
      channelId: "channel-1",
      messageId: "message-4",
      seq: 4,
    })
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

    visibility = "visible"
    for (const listener of visibilityListeners) listener()
    expect(coordinator.resume).toHaveBeenCalledWith(queryClient)
    trigger(observers[0]!, row)
    expect(coordinator.submit).toHaveBeenCalledOnce()
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
