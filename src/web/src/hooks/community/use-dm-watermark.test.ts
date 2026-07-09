/**
 * `useDmWatermark` — DM sibling of `useChannelWatermark`. Same
 * IntersectionObserver behavior, same monotone forward invariant, same
 * self-authored skip, same flush-on-unmount contract. Tests mirror the
 * channel-side coverage so a divergence between the two hooks would
 * surface here immediately.
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
  useAdvanceDmWatermark: () => advanceSpy,
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
  const mod = await import("./use-dm-watermark")
  return mod.useDmWatermark
}

function makeRoot(): HTMLElement {
  return { __kind: "root" } as unknown as HTMLElement
}

function makeRow(id: string): Element {
  return { dataset: { msgId: id } } as unknown as Element
}

function attachRows(root: HTMLElement, rows: Element[]) {
  ;(root as unknown as { querySelectorAll: (sel: string) => Iterable<Element> }).querySelectorAll =
    () => rows
}

beforeEach(() => {
  resetHarness()
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    MockIntersectionObserver
})

describe("useDmWatermark — visibility gate", () => {
  it("advances the watermark when a row hits >=0.2 visibility", async () => {
    const useHook = await loadHook()
    const root = makeRoot()
    const row = makeRow("m_1")
    attachRows(root, [row])
    useHook({
      dmId: "dm_1",
      messages: [
        { id: "m_1", createdAt: "2026-07-01T00:00:00.000Z", authorId: "u_other" },
      ],
      scrollRootEl: root,
    })
    flushEffects()
    fireIntersections([{ target: row, isIntersecting: true, intersectionRatio: 0.3 }])
    expect(advanceSpy).toHaveBeenCalledWith("dm_1", "m_1")
  })

  it("does NOT advance when ratio is below 0.2", async () => {
    const useHook = await loadHook()
    const root = makeRoot()
    const row = makeRow("m_1")
    attachRows(root, [row])
    useHook({
      dmId: "dm_1",
      messages: [
        { id: "m_1", createdAt: "2026-07-01T00:00:00.000Z", authorId: "u_other" },
      ],
      scrollRootEl: root,
    })
    flushEffects()
    fireIntersections([{ target: row, isIntersecting: true, intersectionRatio: 0.1 }])
    expect(advanceSpy).not.toHaveBeenCalled()
  })
})

describe("useDmWatermark — monotone forward", () => {
  it("NEVER regresses — a stale-older intersection after seeing a newer row is ignored", async () => {
    const useHook = await loadHook()
    const root = makeRoot()
    const rowOld = makeRow("m_old")
    const rowNew = makeRow("m_new")
    attachRows(root, [rowOld, rowNew])
    useHook({
      dmId: "dm_1",
      messages: [
        { id: "m_old", createdAt: "2026-07-01T00:00:00.000Z", authorId: "u_other" },
        { id: "m_new", createdAt: "2026-07-02T00:00:00.000Z", authorId: "u_other" },
      ],
      scrollRootEl: root,
    })
    flushEffects()
    fireIntersections([{ target: rowNew, isIntersecting: true, intersectionRatio: 0.9 }])
    fireIntersections([{ target: rowOld, isIntersecting: true, intersectionRatio: 0.9 }])
    expect(advanceSpy.mock.calls.map((c) => c[1])).toEqual(["m_new"])
  })
})

describe("useDmWatermark — self-authored skip", () => {
  it("does NOT advance for a message authored by the viewer", async () => {
    const useHook = await loadHook()
    const root = makeRoot()
    const row = makeRow("m_1")
    attachRows(root, [row])
    useHook({
      dmId: "dm_1",
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

describe("useDmWatermark — lifecycle", () => {
  it("flushes pending mark-reads on unmount / DM change", async () => {
    const useHook = await loadHook()
    const root = makeRoot()
    attachRows(root, [])
    useHook({ dmId: "dm_1", messages: [], scrollRootEl: root })
    flushEffects()
    runCleanups()
    expect(flushSpy).toHaveBeenCalled()
  })

  it("no-op when scrollRootEl is null (IntersectionObserver never mounts)", async () => {
    const useHook = await loadHook()
    useHook({ dmId: "dm_1", messages: [], scrollRootEl: null })
    flushEffects()
    expect(observers).toHaveLength(0)
  })
})
