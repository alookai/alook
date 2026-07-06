/**
 * `useChannelWatermark` — IntersectionObserver-driven read pointer advance.
 *
 * The vitest env is node (no jsdom, no IntersectionObserver). We install a
 * lightweight IO polyfill on `globalThis` that records the callback and
 * exposes a `trigger()` helper so tests can simulate intersections.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// ── React shim ────────────────────────────────────────────────────────────
let refs: Map<string, { current: unknown }> = new Map()
let refCounter = 0
let pendingEffects: Array<{ fn: () => void | (() => void); deps: unknown[] }> = []
let effectCleanups: Array<() => void> = []

vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const id = `ref-${refCounter++}`
    if (!refs.has(id)) refs.set(id, { current: initial })
    return refs.get(id)!
  },
  useEffect: (fn: () => void | (() => void), deps: unknown[]) => {
    pendingEffects.push({ fn, deps })
  },
}))

function flushEffects() {
  const effects = pendingEffects
  pendingEffects = []
  for (const e of effects) {
    const cleanup = e.fn()
    if (typeof cleanup === "function") effectCleanups.push(cleanup)
  }
}

function runCleanups() {
  const c = effectCleanups
  effectCleanups = []
  for (const fn of c) fn()
}

// ── IntersectionObserver polyfill ────────────────────────────────────────
type ObserverInstance = {
  callback: IntersectionObserverCallback
  root: Element | null
  threshold: number
  observed: Set<Element>
  disconnected: boolean
}
let observers: ObserverInstance[] = []

class MockIntersectionObserver {
  private inst: ObserverInstance
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.inst = {
      callback,
      root: (options?.root as Element | null | undefined) ?? null,
      threshold: Array.isArray(options?.threshold)
        ? options!.threshold[0]!
        : options?.threshold ?? 0,
      observed: new Set(),
      disconnected: false,
    }
    observers.push(this.inst)
  }
  observe(el: Element) {
    this.inst.observed.add(el)
  }
  unobserve(el: Element) {
    this.inst.observed.delete(el)
  }
  disconnect() {
    this.inst.disconnected = true
    this.inst.observed.clear()
  }
}

function fireIntersections(
  entries: Array<{ target: Element; isIntersecting: boolean; intersectionRatio: number }>,
) {
  // Broadcast to every active observer (matches real IO semantics — the
  // caller decides which observer receives which entries via observe()).
  for (const obs of observers) {
    if (obs.disconnected) continue
    const scoped = entries.filter((e) => obs.observed.has(e.target))
    if (scoped.length === 0) continue
    obs.callback(
      scoped.map((e) => ({
        ...e,
        rootBounds: null,
        boundingClientRect: {} as DOMRectReadOnly,
        intersectionRect: {} as DOMRectReadOnly,
        time: 0,
      })) as unknown as IntersectionObserverEntry[],
      undefined as unknown as IntersectionObserver,
    )
  }
}

// ── Mocks for the hook's imports ─────────────────────────────────────────
const advanceSpy = vi.fn()
const flushSpy = vi.fn()

vi.mock("@/hooks/community/mutations/messages", () => ({
  useAdvanceChannelWatermark: () => advanceSpy,
  flushPendingReads: () => flushSpy(),
}))

vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "u_viewer", name: "viewer", avatar: "V" }),
}))

function resetHarness() {
  refs = new Map()
  refCounter = 0
  pendingEffects = []
  effectCleanups = []
  observers = []
  advanceSpy.mockClear()
  flushSpy.mockClear()
}

async function loadHook() {
  const mod = await import("./use-channel-watermark")
  return mod.useChannelWatermark
}

// Fabricate a scroll-root element the observer can key `root` off. jsdom
// isn't available, so we lie about the type — the polyfill above doesn't
// actually look at the root's DOM behaviour beyond identity.
function makeRoot(): HTMLElement {
  return { __kind: "root" } as unknown as HTMLElement
}

// Fabricate a message-row element. `dataset.msgId` mirrors the DOM API the
// hook reads at intersection time.
function makeRow(id: string): Element {
  return { dataset: { msgId: id } } as unknown as Element
}

// The hook queries `root.querySelectorAll("[data-msg-id]")` to seed the
// observer with the currently-rendered rows. We synthesize that here.
function attachRows(root: HTMLElement, rows: Element[]) {
  ;(root as unknown as { querySelectorAll: (sel: string) => Iterable<Element> }).querySelectorAll =
    () => rows
}

beforeEach(() => {
  resetHarness()
  // Install IO polyfill on globalThis so `typeof IntersectionObserver` is
  // "function" inside the hook.
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    MockIntersectionObserver
})

describe("useChannelWatermark — visibility gate", () => {
  it("advances the watermark when a row hits >=0.75 visibility", async () => {
    const useHook = await loadHook()
    const root = makeRoot()
    const row = makeRow("m_1")
    attachRows(root, [row])
    useHook({
      channelId: "ch_1",
      messages: [
        { id: "m_1", createdAt: "2026-07-01T00:00:00.000Z", authorId: "u_other" },
      ],
      scrollRootEl: root,
    })
    flushEffects()
    fireIntersections([{ target: row, isIntersecting: true, intersectionRatio: 0.9 }])
    expect(advanceSpy).toHaveBeenCalledWith("ch_1", "m_1")
  })

  it("does NOT advance when ratio is below 0.75", async () => {
    const useHook = await loadHook()
    const root = makeRoot()
    const row = makeRow("m_1")
    attachRows(root, [row])
    useHook({
      channelId: "ch_1",
      messages: [
        { id: "m_1", createdAt: "2026-07-01T00:00:00.000Z", authorId: "u_other" },
      ],
      scrollRootEl: root,
    })
    flushEffects()
    fireIntersections([{ target: row, isIntersecting: true, intersectionRatio: 0.5 }])
    expect(advanceSpy).not.toHaveBeenCalled()
  })

  it("does NOT advance when isIntersecting is false, even at high ratio", async () => {
    const useHook = await loadHook()
    const root = makeRoot()
    const row = makeRow("m_1")
    attachRows(root, [row])
    useHook({
      channelId: "ch_1",
      messages: [
        { id: "m_1", createdAt: "2026-07-01T00:00:00.000Z", authorId: "u_other" },
      ],
      scrollRootEl: root,
    })
    flushEffects()
    fireIntersections([{ target: row, isIntersecting: false, intersectionRatio: 0.9 }])
    expect(advanceSpy).not.toHaveBeenCalled()
  })
})

describe("useChannelWatermark — monotone forward", () => {
  it("advances forward across two newer intersections", async () => {
    const useHook = await loadHook()
    const root = makeRoot()
    const row1 = makeRow("m_1")
    const row2 = makeRow("m_2")
    attachRows(root, [row1, row2])
    useHook({
      channelId: "ch_1",
      messages: [
        { id: "m_1", createdAt: "2026-07-01T00:00:00.000Z", authorId: "u_other" },
        { id: "m_2", createdAt: "2026-07-01T00:00:01.000Z", authorId: "u_other" },
      ],
      scrollRootEl: root,
    })
    flushEffects()
    fireIntersections([{ target: row1, isIntersecting: true, intersectionRatio: 0.9 }])
    fireIntersections([{ target: row2, isIntersecting: true, intersectionRatio: 0.9 }])
    expect(advanceSpy.mock.calls.map((c) => c[1])).toEqual(["m_1", "m_2"])
  })

  it("NEVER regresses — a stale-older intersection after seeing a newer row is ignored", async () => {
    const useHook = await loadHook()
    const root = makeRoot()
    const rowOld = makeRow("m_old")
    const rowNew = makeRow("m_new")
    attachRows(root, [rowOld, rowNew])
    useHook({
      channelId: "ch_1",
      messages: [
        { id: "m_old", createdAt: "2026-07-01T00:00:00.000Z", authorId: "u_other" },
        { id: "m_new", createdAt: "2026-07-02T00:00:00.000Z", authorId: "u_other" },
      ],
      scrollRootEl: root,
    })
    flushEffects()
    // See the newer one first.
    fireIntersections([{ target: rowNew, isIntersecting: true, intersectionRatio: 0.9 }])
    // Then scroll back — an older row briefly clears the threshold again.
    fireIntersections([{ target: rowOld, isIntersecting: true, intersectionRatio: 0.9 }])
    expect(advanceSpy.mock.calls.map((c) => c[1])).toEqual(["m_new"])
  })

  it("breaks (createdAt, id) ties lexicographically on id", async () => {
    const useHook = await loadHook()
    const root = makeRoot()
    const rowA = makeRow("m_a")
    const rowB = makeRow("m_b")
    attachRows(root, [rowA, rowB])
    useHook({
      channelId: "ch_1",
      messages: [
        { id: "m_a", createdAt: "2026-07-01T00:00:00.000Z", authorId: "u_other" },
        { id: "m_b", createdAt: "2026-07-01T00:00:00.000Z", authorId: "u_other" },
      ],
      scrollRootEl: root,
    })
    flushEffects()
    fireIntersections([{ target: rowA, isIntersecting: true, intersectionRatio: 0.9 }])
    fireIntersections([{ target: rowB, isIntersecting: true, intersectionRatio: 0.9 }])
    // b > a lexicographically at the same createdAt, so both advance.
    expect(advanceSpy.mock.calls.map((c) => c[1])).toEqual(["m_a", "m_b"])
  })
})

describe("useChannelWatermark — self-authored skip", () => {
  it("does NOT advance for a message authored by the viewer", async () => {
    const useHook = await loadHook()
    const root = makeRoot()
    const row = makeRow("m_1")
    attachRows(root, [row])
    useHook({
      channelId: "ch_1",
      messages: [
        { id: "m_1", createdAt: "2026-07-01T00:00:00.000Z", authorId: "u_viewer" },
      ],
      scrollRootEl: root,
    })
    flushEffects()
    fireIntersections([{ target: row, isIntersecting: true, intersectionRatio: 0.99 }])
    expect(advanceSpy).not.toHaveBeenCalled()
  })
})

describe("useChannelWatermark — lifecycle", () => {
  it("flushes pending mark-reads on unmount / channel change", async () => {
    const useHook = await loadHook()
    const root = makeRoot()
    attachRows(root, [])
    useHook({ channelId: "ch_1", messages: [], scrollRootEl: root })
    flushEffects()
    // Trigger cleanup — the effect keyed on channelId returns
    // `flushPendingReads`.
    runCleanups()
    expect(flushSpy).toHaveBeenCalled()
  })

  it("no-op when scrollRootEl is null (IntersectionObserver never mounts)", async () => {
    const useHook = await loadHook()
    useHook({ channelId: "ch_1", messages: [], scrollRootEl: null })
    flushEffects()
    expect(observers).toHaveLength(0)
  })
})
