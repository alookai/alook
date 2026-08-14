/**
 * `useChannelWatermark` — IntersectionObserver-driven read pointer advance.
 *
 * The vitest env is node (no jsdom, no IntersectionObserver). We install a
 * lightweight IO polyfill on `globalThis` that records the callback and
 * exposes a `trigger()` helper so tests can simulate intersections.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// ── React shim ────────────────────────────────────────────────────────────
// Positional hooks, React-faithful: `useRef`/`useEffect` are keyed by call
// order within a render, and `useEffect` honors its deps array (runs only when
// a dep changed vs the previous render — deps: [] runs once, no deps runs
// always). Faithful deps matter here: the hook resets its read watermark on a
// `[channelId]` effect and seeds once via a guarded ref — a shim that re-ran
// every effect on every render would spuriously reset/re-seed on a plain
// re-render (e.g. a WS message arriving), which React does not do.
let refs: Map<string, { current: unknown }> = new Map()
let refCounter = 0
let effectCounter = 0
const effectPrevDeps: Map<number, unknown[] | undefined> = new Map()
const effectCleanupBySlot: Map<number, () => void> = new Map()
let pendingEffects: Array<{ slot: number; fn: () => void | (() => void); deps: unknown[] | undefined }> = []
let effectCleanups: Array<() => void> = []

vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const id = `ref-${refCounter++}`
    if (!refs.has(id)) refs.set(id, { current: initial })
    return refs.get(id)!
  },
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
    pendingEffects.push({ slot: effectCounter++, fn, deps })
  },
}))

function depsChanged(prev: unknown[] | undefined, next: unknown[] | undefined): boolean {
  if (next === undefined) return true // no deps → run every render
  if (prev === undefined) return true // first render
  if (prev.length !== next.length) return true
  return next.some((d, i) => !Object.is(d, prev[i]))
}

function flushEffects() {
  const effects = pendingEffects
  pendingEffects = []
  for (const e of effects) {
    if (!depsChanged(effectPrevDeps.get(e.slot), e.deps)) continue
    // React runs the cleanup from the prior invocation before re-running.
    effectCleanupBySlot.get(e.slot)?.()
    effectCleanupBySlot.delete(e.slot)
    const cleanup = e.fn()
    if (typeof cleanup === "function") {
      effectCleanupBySlot.set(e.slot, cleanup)
      effectCleanups.push(cleanup)
    }
    effectPrevDeps.set(e.slot, e.deps)
  }
}

function runCleanups() {
  const c = effectCleanups
  effectCleanups = []
  for (const fn of c) fn()
}

// Simulate a React re-render: refs + effect slots persist (same call order →
// same ref / same effect identity), but the per-render counters rewind so the
// hook's `useRef`/`useEffect` calls map back onto the same slots. Effects then
// re-run only if their deps changed — faithful to React.
function rerender() {
  refCounter = 0
  effectCounter = 0
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
}))
vi.mock("@/lib/community/pending-reads", () => ({
  flushPendingReads: () => flushSpy(),
}))

vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "u_viewer", name: "viewer", avatar: "V" }),
}))

function resetHarness() {
  refs = new Map()
  refCounter = 0
  effectCounter = 0
  effectPrevDeps.clear()
  effectCleanupBySlot.clear()
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

// A message NEWER than everything in the mount window — used to exercise the
// watermark's advance path under the read-dedupe seed (the mount window is
// pre-seeded as "already read by the eager mark-read", so only a genuinely
// newer arrival advances). Its createdAt is later than any fixture below.
const NEWER = { id: "m_newer", createdAt: "2026-09-01T00:00:00.000Z", authorId: "u_other" }

describe("useChannelWatermark — visibility gate", () => {
  it("advances the watermark when a NEWER-than-seed row hits >=0.2 visibility", async () => {
    const useHook = await loadHook()
    const root = makeRoot()
    // Mount window: m_1 (already read by the eager mark-read → seeded, won't
    // advance). A newer message then arrives (WS) and its row mounts.
    const seedMsg = { id: "m_1", createdAt: "2026-07-01T00:00:00.000Z", authorId: "u_other" }
    attachRows(root, [makeRow("m_1")])
    useHook({ channelId: "ch_1", messages: [seedMsg], scrollRootEl: root })
    flushEffects()
    // Re-render with the newer message present (WS arrival) so the hook's
    // messagesRef sees it; its row mounts via a DOM mutation.
    rerender()
    useHook({ channelId: "ch_1", messages: [seedMsg, NEWER], scrollRootEl: root })
    flushEffects()
    const newerRow = makeRow(NEWER.id)
    fireAddedNodes([newerRow])
    fireIntersections([{ target: newerRow, isIntersecting: true, intersectionRatio: 0.3 }])
    expect(advanceSpy).toHaveBeenCalledWith("ch_1", NEWER.id)
  })

  it("does NOT re-advance a message already in the mount window (eager mark-read covered it)", async () => {
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
    // m_1 was present at mount → seeded as read by the eager PUT → the
    // watermark must NOT fire a second, redundant read PUT for it.
    fireIntersections([{ target: row, isIntersecting: true, intersectionRatio: 0.9 }])
    expect(advanceSpy).not.toHaveBeenCalled()
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

// A message older than every advancing fixture below — used to seed the mount
// window so the read-dedupe seed lands on it, leaving the (newer) test messages
// to arrive post-mount and exercise the advance path exactly as before the seed.
const SEED_BASELINE = { id: "m_seed", createdAt: "2026-06-01T00:00:00.000Z", authorId: "u_other" }

// Mount with just the seed baseline, then re-render with the baseline + the
// given post-mount arrivals (WS/scroll), mounting their rows via a DOM
// mutation. Returns the arrival row objects (keyed by id) so callers fire
// intersections on the SAME element instances the observer is tracking.
function mountThenArrive(
  // Not named `use…` on purpose — a plain helper isn't a React hook/component,
  // and the rules-of-hooks lint forbids calling a `use*` binding here.
  runWatermark: (a: { channelId: string; messages: unknown[]; scrollRootEl: HTMLElement }) => void,
  root: HTMLElement,
  arrivals: Array<{ id: string; createdAt: string; authorId: string }>,
): Record<string, Element> {
  attachRows(root, [makeRow(SEED_BASELINE.id)])
  runWatermark({ channelId: "ch_1", messages: [SEED_BASELINE], scrollRootEl: root })
  flushEffects()
  rerender()
  runWatermark({ channelId: "ch_1", messages: [SEED_BASELINE, ...arrivals], scrollRootEl: root })
  flushEffects()
  const rows: Record<string, Element> = {}
  for (const a of arrivals) rows[a.id] = makeRow(a.id)
  fireAddedNodes(Object.values(rows))
  return rows
}

describe("useChannelWatermark — monotone forward", () => {
  it("advances forward across two newer intersections", async () => {
    const useHook = await loadHook()
    const root = makeRoot()
    const rows = mountThenArrive(useHook, root, [
      { id: "m_1", createdAt: "2026-07-01T00:00:00.000Z", authorId: "u_other" },
      { id: "m_2", createdAt: "2026-07-01T00:00:01.000Z", authorId: "u_other" },
    ])
    fireIntersections([{ target: rows.m_1, isIntersecting: true, intersectionRatio: 0.9 }])
    fireIntersections([{ target: rows.m_2, isIntersecting: true, intersectionRatio: 0.9 }])
    expect(advanceSpy.mock.calls.map((c) => c[1])).toEqual(["m_1", "m_2"])
  })

  it("NEVER regresses — a stale-older intersection after seeing a newer row is ignored", async () => {
    const useHook = await loadHook()
    const root = makeRoot()
    const rows = mountThenArrive(useHook, root, [
      { id: "m_old", createdAt: "2026-07-01T00:00:00.000Z", authorId: "u_other" },
      { id: "m_new", createdAt: "2026-07-02T00:00:00.000Z", authorId: "u_other" },
    ])
    // See the newer one first.
    fireIntersections([{ target: rows.m_new, isIntersecting: true, intersectionRatio: 0.9 }])
    // Then scroll back — an older row briefly clears the threshold again.
    fireIntersections([{ target: rows.m_old, isIntersecting: true, intersectionRatio: 0.9 }])
    expect(advanceSpy.mock.calls.map((c) => c[1])).toEqual(["m_new"])
  })

  it("breaks (createdAt, id) ties lexicographically on id", async () => {
    const useHook = await loadHook()
    const root = makeRoot()
    const rows = mountThenArrive(useHook, root, [
      { id: "m_a", createdAt: "2026-07-01T00:00:00.000Z", authorId: "u_other" },
      { id: "m_b", createdAt: "2026-07-01T00:00:00.000Z", authorId: "u_other" },
    ])
    fireIntersections([{ target: rows.m_a, isIntersecting: true, intersectionRatio: 0.9 }])
    fireIntersections([{ target: rows.m_b, isIntersecting: true, intersectionRatio: 0.9 }])
    // b > a lexicographically at the same createdAt, so both advance.
    expect(advanceSpy.mock.calls.map((c) => c[1])).toEqual(["m_a", "m_b"])
  })
})

describe("useChannelWatermark — virtualized rows (mounted on scroll, no messages change)", () => {
  it("observes a row the virtualizer mounts AFTER the initial seed, so scrolling clears unreads", async () => {
    // Regression: with the virtualized message list, rows enter the DOM as
    // the user scrolls — the `messages` array reference doesn't change, so
    // the seed effect never re-runs and the newly-mounted row is never
    // observed. The read watermark then never advances past whatever was
    // on-screen at mount, so "NEW" unreads never clear on scroll. A
    // MutationObserver on the scroll root must pick up the added row.
    //
    // Under read-dedupe, the advancing row must also be NEWER than the mount
    // seed — a message already in the mount window was covered by the eager
    // mark-read, so scrolling to it correctly does not re-PUT. Here m_2 arrives
    // after the seed baseline and is genuinely newer.
    const useHook = await loadHook()
    const root = makeRoot()
    const rows = mountThenArrive(useHook, root, [
      { id: "m_2", createdAt: "2026-07-01T00:00:05.000Z", authorId: "u_other" },
    ])
    // The newly-mounted (newer) row is observed and advances the watermark.
    fireIntersections([{ target: rows.m_2, isIntersecting: true, intersectionRatio: 0.9 }])
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
