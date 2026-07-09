/**
 * `useDmReadStateSnapshot` — DM sibling of `useChannelReadStateSnapshot`.
 * Mirrors the freeze invariant tests exactly; if the two hooks ever
 * diverge in behavior the divider anchor will drift out of parity across
 * channels and DMs.
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
  const mod = await import("./use-dm-read-state")
  return mod.useDmReadStateSnapshot
}

beforeEach(() => {
  resetHarness()
})

describe("useDmReadStateSnapshot — freeze invariant", () => {
  it("returns null before the query resolves", async () => {
    const useHook = await loadHook()
    queryReturn = { data: undefined, isFetching: true }
    const first = useHook("dm_1")
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
        lastReadSeq: 42,
      },
      isFetching: false,
    }
    const r = useHook("dm_1")
    flushEffects()
    expect(r.snapshot).toEqual({
      lastReadMessageId: "m_42",
      lastReadAt: "2026-07-01T00:00:00.000Z",
      lastReadSeq: 42,
    })
  })

  it("freezes the snapshot — a subsequent 'refetch' with a NEW value must NOT change what the hook returns", async () => {
    const useHook = await loadHook()

    // First render: query resolves with value A.
    queryReturn = {
      data: {
        lastReadMessageId: "m_original",
        lastReadAt: "2026-07-01T00:00:00.000Z",
        lastReadSeq: 10,
      },
      isFetching: false,
    }
    useHook("dm_1")
    flushEffects()

    // Second render (same mount, same DM): simulate a phantom refetch
    // that would have advanced the pointer.
    refCounter = 0
    pendingEffects = []
    queryReturn = {
      data: {
        lastReadMessageId: "m_way_later",
        lastReadAt: "2026-07-15T00:00:00.000Z",
        lastReadSeq: 999,
      },
      isFetching: false,
    }
    const r2 = useHook("dm_1")
    flushEffects()

    expect(r2.snapshot).toEqual({
      lastReadMessageId: "m_original",
      lastReadAt: "2026-07-01T00:00:00.000Z",
      lastReadSeq: 10,
    })
  })

  it("resets the ref on dmId change so switching DMs rebuilds the snapshot", async () => {
    const useHook = await loadHook()

    queryReturn = {
      data: {
        lastReadMessageId: "m_a",
        lastReadAt: "2026-07-01T00:00:00.000Z",
        lastReadSeq: 1,
      },
      isFetching: false,
    }
    useHook("dm_1")
    flushEffects()

    // Same-mount DM switch — the hook body checks lastDmIdRef and
    // clears snapshotRef. Simulate the re-render:
    refCounter = 0
    pendingEffects = []
    queryReturn = {
      data: {
        lastReadMessageId: "m_b",
        lastReadAt: "2026-07-02T00:00:00.000Z",
        lastReadSeq: 2,
      },
      isFetching: false,
    }
    const r = useHook("dm_2")
    flushEffects()

    expect(r.snapshot).toEqual({
      lastReadMessageId: "m_b",
      lastReadAt: "2026-07-02T00:00:00.000Z",
      lastReadSeq: 2,
    })
  })

  it("returns the null-pointer sentinel when the initial fetch resolved with no prior read row", async () => {
    const useHook = await loadHook()
    queryReturn = {
      data: { lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 },
      isFetching: false,
    }
    useHook("dm_1")
    flushEffects()

    refCounter = 0
    pendingEffects = []
    // Even if a phantom refetch produced a real pointer, the freeze holds.
    queryReturn = {
      data: {
        lastReadMessageId: "m_late",
        lastReadAt: "2026-07-15T00:00:00.000Z",
        lastReadSeq: 50,
      },
      isFetching: false,
    }
    const r = useHook("dm_1")
    flushEffects()
    expect(r.snapshot).toEqual({
      lastReadMessageId: null,
      lastReadAt: null,
      lastReadSeq: 0,
    })
  })
})
