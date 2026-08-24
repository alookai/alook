import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const effects: Array<() => void | (() => void)> = []
const queryClient = {}
const coordinator = vi.hoisted(() => ({
  register: vi.fn(() => ({ lease: "forum-opener" })),
  release: vi.fn(),
  resume: vi.fn(),
  submit: vi.fn(() => true),
}))

vi.mock("react", () => ({
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

import { useForumOpenerReadAnchor } from "./use-forum-opener-read-anchor"

type ObserverRecord = {
  callback: IntersectionObserverCallback
  observed: Set<Element>
  disconnected: boolean
  takeRecords: ReturnType<typeof vi.fn>
}

let observers: ObserverRecord[]
let visibility: DocumentVisibilityState
let visibilityListeners: Set<() => void>
let pageShowListeners: Set<() => void>

class FakeIntersectionObserver {
  private readonly record: ObserverRecord

  constructor(callback: IntersectionObserverCallback) {
    this.record = {
      callback,
      observed: new Set(),
      disconnected: false,
      takeRecords: vi.fn(() => []),
    }
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

  takeRecords() {
    return this.record.takeRecords()
  }
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

function useTestRender(options: Partial<Parameters<typeof useForumOpenerReadAnchor>[0]> = {}) {
  const element = { isConnected: true } as unknown as HTMLElement
  useForumOpenerReadAnchor({
    element,
    openerMessageId: "opener-3",
    parentChannelId: "forum-1",
    parentSeq: 3,
    snapshotReady: true,
    ...options,
  })
  return element
}

describe("useForumOpenerReadAnchor", () => {
  beforeEach(() => {
    effects.length = 0
    observers = []
    visibility = "visible"
    visibilityListeners = new Set()
    pageShowListeners = new Set()
    vi.clearAllMocks()
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
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

  afterEach(() => vi.unstubAllGlobals())

  it("waits for the account snapshot before registering a deep-link anchor", () => {
    useTestRender({ snapshotReady: false })
    runEffects()
    expect(observers).toHaveLength(0)
    expect(coordinator.register).not.toHaveBeenCalled()

    effects.length = 0
    const element = useTestRender()
    runEffects()
    trigger(observers[0]!, element)

    expect(coordinator.register).toHaveBeenCalledWith(
      queryClient,
      "viewer-1",
      {
        kind: "forum-opener",
        openerMessageId: "opener-3",
        parentChannelId: "forum-1",
        parentSeq: 3,
      },
    )
    expect(coordinator.submit).toHaveBeenCalledWith(
      { lease: "forum-opener" },
      {
        kind: "forum-opener",
        openerMessageId: "opener-3",
        parentChannelId: "forum-1",
        parentSeq: 3,
      },
    )
  })

  it("does not read while hidden and re-samples the anchor after foreground", () => {
    const element = useTestRender()
    runEffects()
    visibility = "hidden"
    trigger(observers[0]!, element)
    expect(coordinator.submit).not.toHaveBeenCalled()

    visibility = "visible"
    for (const listener of visibilityListeners) listener()
    expect(observers[0]!.takeRecords).toHaveBeenCalledOnce()
    expect(coordinator.resume).toHaveBeenCalledWith(queryClient)
    trigger(observers[0]!, element)
    expect(coordinator.submit).toHaveBeenCalledOnce()
  })

  it("fences a detached anchor and callbacks queued after route cleanup", () => {
    const element = useTestRender()
    const cleanups = runEffects()
    const record = observers[0]!

    ;(element as unknown as { isConnected: boolean }).isConnected = false
    trigger(record, element)
    expect(coordinator.submit).not.toHaveBeenCalled()

    ;(element as unknown as { isConnected: boolean }).isConnected = true
    for (const cleanup of cleanups) cleanup()
    trigger(record, element)
    expect(coordinator.submit).not.toHaveBeenCalled()
    expect(coordinator.release).toHaveBeenCalledWith({ lease: "forum-opener" })
  })
})
