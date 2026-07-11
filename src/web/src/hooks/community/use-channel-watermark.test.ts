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

// ── MutationObserver polyfill ────────────────────────────────────────────
// The virtualized message list mounts/unmounts rows as the user scrolls —
// no `messages` array change fires, so the IntersectionObserver seed effect
// never re-runs. The hook wires a MutationObserver on the scroll root to
// observe rows added after the initial seed; this polyfill records the
// callback and lets a test fire an "added node" batch.
type MutationObserverInstance = {
  callback: MutationCallback
  disconnected: boolean
}
let mutationObservers: MutationObserverInstance[] = []

class MockMutationObserver {
  private inst: MutationObserverInstance
  constructor(callback: MutationCallback) {
    this.inst = { callback, disconnected: false }
    mutationObservers.push(this.inst)
  }
  observe() {}
  disconnect() {
    this.inst.disconnected = true
  }
  takeRecords(): MutationRecord[] {
    return []
  }
}

// Simulate the virtualizer appending new row nodes to the scroll container.
function fireAddedNodes(nodes: Element[]) {
  for (const obs of mutationObservers) {
    if (obs.disconnected) continue
    obs.callback(
      [
        {
          type: "childList",
          addedNodes: nodes as unknown as NodeList,
          removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord,
      ],
      undefined as unknown as MutationObserver,
    )
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
  mutationObservers = []
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
// hook reads at intersection time. `matches`/`querySelectorAll` mirror the
// Element API the MutationObserver-added-node scan reads: the row element
// itself carries `data-msg-id`, so `matches("[data-msg-id]")` is true and a
// self-scan returns itself.
function makeRow(id: string): Element {
  const el = {
    dataset: { msgId: id },
    nodeType: 1,
    matches: (sel: string) => sel === "[data-msg-id]",
    querySelectorAll: () => [] as unknown as Iterable<Element>,
  }
  return el as unknown as Element
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
  ;(globalThis as unknown as { MutationObserver: unknown }).MutationObserver =
    MockMutationObserver
})

describe("useChannelWatermark — visibility gate", () => {
  it("advances the watermark when a row hits >=0.2 visibility", async () => {
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
    fireIntersections([{ target: row, isIntersecting: true, intersectionRatio: 0.3 }])
    expect(advanceSpy).toHaveBeenCalledWith("ch_1", "m_1")
  })

  it("does NOT advance when ratio is below 0.2", async () => {
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
    fireIntersections([{ target: row, isIntersecting: true, intersectionRatio: 0.1 }])
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

describe("useChannelWatermark — virtualized rows (mounted on scroll, no messages change)", () => {
  it("observes a row the virtualizer mounts AFTER the initial seed, so scrolling clears unreads", async () => {
    // Regression: with the virtualized message list, rows enter the DOM as
    // the user scrolls — the `messages` array reference doesn't change, so
    // the seed effect (deps: [channelId, messages, scrollRootEl, viewerId])
    // never re-runs and the newly-mounted row is never observed. The read
    // watermark then never advances past whatever was on-screen at mount,
    // so "NEW" unreads never clear on scroll. A MutationObserver on the
    // scroll root must pick up the added row and observe it.
    const useHook = await loadHook()
    const root = makeRoot()
    // At mount only the top row is rendered by the virtualizer.
    const topRow = makeRow("m_1")
    attachRows(root, [topRow])
    useHook({
      channelId: "ch_1",
      messages: [
        { id: "m_1", createdAt: "2026-07-01T00:00:00.000Z", authorId: "u_other" },
        { id: "m_2", createdAt: "2026-07-01T00:00:05.000Z", authorId: "u_other" },
      ],
      scrollRootEl: root,
    })
    flushEffects()

    // User scrolls down — the virtualizer mounts m_2's row into the DOM.
    // No `messages` change fires; only a DOM mutation.
    const scrolledRow = makeRow("m_2")
    fireAddedNodes([scrolledRow])

    // The newly-mounted row must now be observed and advance the watermark.
    fireIntersections([{ target: scrolledRow, isIntersecting: true, intersectionRatio: 0.9 }])
    expect(advanceSpy).toHaveBeenCalledWith("ch_1", "m_2")
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
