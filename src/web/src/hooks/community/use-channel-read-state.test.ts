/**
 * `useChannelReadStateSnapshot` — the once-per-mount frozen snapshot of the
 * viewer's read pointer for a channel.
 *
 * The vitest env is node (no jsdom), so we drive the hook through a minimal
 * React shim: useRef + useEffect + useQuery are mocked so the test can
 * observe the freeze invariant without a real render loop.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// ── React shim ────────────────────────────────────────────────────────────
let refs: Map<string, { current: unknown }> = new Map()
let refCounter = 0
let pendingEffects: Array<() => void> = []

vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const id = `ref-${refCounter++}`
    if (!refs.has(id)) refs.set(id, { current: initial })
    return refs.get(id)!
  },
  useEffect: (fn: () => void, _deps: unknown[]) => {
    pendingEffects.push(fn)
  },
}))

function flushEffects() {
  const effects = pendingEffects
  pendingEffects = []
  for (const fn of effects) fn()
}

// ── TanStack Query shim — we control the returned value per-render ────────
let queryReturn: { data: unknown; isFetching: boolean } = {
  data: undefined,
  isFetching: false,
}
vi.mock("@tanstack/react-query", () => ({
  useQuery: (_config: unknown) => queryReturn,
}))

// apiFetch is unused directly (the queryFn is stubbed by the useQuery mock)
// but the module still imports it, so provide a stub.
vi.mock("@/lib/api/client", () => ({
  apiFetch: vi.fn(),
}))

function resetHarness() {
  refs = new Map()
  refCounter = 0
  pendingEffects = []
  queryReturn = { data: undefined, isFetching: false }
}

async function loadHook() {
  const mod = await import("./use-channel-read-state")
  return mod.useChannelReadStateSnapshot
}

beforeEach(() => {
  resetHarness()
})

describe("useChannelReadStateSnapshot — freeze invariant", () => {
  it("returns null before the query resolves", async () => {
    const useHook = await loadHook()
    queryReturn = { data: undefined, isFetching: true }
    const first = useHook("ch_1")
    flushEffects()
    expect(first.snapshot).toBeNull()
    expect(first.isFetching).toBe(true)
  })

  it("returns the resolved value on first success", async () => {
    const useHook = await loadHook()
    queryReturn = {
      data: {
        lastReadMessageId: "m_42",
        lastReadAt: "2026-07-01T00:00:00.000Z",
      },
      isFetching: false,
    }
    const r = useHook("ch_1")
    flushEffects()
    expect(r.snapshot).toEqual({
      lastReadMessageId: "m_42",
      lastReadAt: "2026-07-01T00:00:00.000Z",
    })
  })

  it("freezes the snapshot — a subsequent 'refetch' with a NEW value must NOT change what the hook returns", async () => {
    const useHook = await loadHook()

    // First render: query resolves with value A.
    queryReturn = {
      data: {
        lastReadMessageId: "m_original",
        lastReadAt: "2026-07-01T00:00:00.000Z",
      },
      isFetching: false,
    }
    useHook("ch_1")
    flushEffects()

    // Second render (same mount, same channel): simulate a phantom refetch
    // that would have advanced the pointer. Reset counters mimicking a
    // React re-render — refs are stable across renders in real React, so
    // we DON'T clear `refs` here (that would emulate a fresh mount).
    refCounter = 0
    pendingEffects = []
    queryReturn = {
      data: {
        lastReadMessageId: "m_way_later",
        lastReadAt: "2026-07-15T00:00:00.000Z",
      },
      isFetching: false,
    }
    const r2 = useHook("ch_1")
    flushEffects()

    // The ref must still hold the original — the "New" divider stays put.
    expect(r2.snapshot).toEqual({
      lastReadMessageId: "m_original",
      lastReadAt: "2026-07-01T00:00:00.000Z",
    })
  })

  it("resets the ref on channelId change so switching channels rebuilds the snapshot", async () => {
    const useHook = await loadHook()

    // Channel ch_1 resolves with A.
    queryReturn = {
      data: { lastReadMessageId: "m_a", lastReadAt: "2026-07-01T00:00:00.000Z" },
      isFetching: false,
    }
    useHook("ch_1")
    flushEffects()

    // Same-mount channel switch — the hook body checks lastChannelIdRef and
    // clears snapshotRef. Simulate the re-render:
    refCounter = 0
    pendingEffects = []
    queryReturn = {
      data: { lastReadMessageId: "m_b", lastReadAt: "2026-07-02T00:00:00.000Z" },
      isFetching: false,
    }
    const r = useHook("ch_2")
    flushEffects()

    expect(r.snapshot).toEqual({
      lastReadMessageId: "m_b",
      lastReadAt: "2026-07-02T00:00:00.000Z",
    })
  })

  it("returns null on subsequent renders when the initial fetch resolved to null (never-visited channel)", async () => {
    const useHook = await loadHook()
    queryReturn = {
      data: { lastReadMessageId: null, lastReadAt: null },
      isFetching: false,
    }
    useHook("ch_1")
    flushEffects()

    // The hook latches ANY non-null query.data, including the sentinel
    // "no row exists" shape.
    refCounter = 0
    pendingEffects = []
    // Even if a phantom refetch produced a real pointer, the freeze holds.
    queryReturn = {
      data: {
        lastReadMessageId: "m_late",
        lastReadAt: "2026-07-15T00:00:00.000Z",
      },
      isFetching: false,
    }
    const r = useHook("ch_1")
    flushEffects()
    expect(r.snapshot).toEqual({ lastReadMessageId: null, lastReadAt: null })
  })
})
