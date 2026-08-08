/**
 * `useEagerChannelRead` — the once-per-mount "mark this channel read on open"
 * PUT, and the query invalidations that follow it.
 *
 * The vitest env is node (no jsdom), so we drive the hook through the same
 * minimal React shim the other community-hook tests use: useRef + useEffect
 * are mocked so we can flush the mount effect by hand. `apiFetch` is stubbed
 * to resolve immediately; `useQueryClient` returns a spy client so we can
 * assert exactly which query keys get invalidated after the PUT.
 *
 * The behaviour under test (WS1 rail-fan-out fix): the eager PUT must always
 * refresh `inbox()`, but must refresh the rail mention badge
 * (`server(serverId)`) ONLY when this server actually carries mentions —
 * never the whole `servers()` prefix. A plain switch into a mention-free
 * server must not trigger any server-level refetch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import type { ServersResponse } from "@/hooks/community/use-servers"

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

// ── apiFetch stub — the PUT resolves immediately ───────────────────────────
const apiFetchMock = vi.fn(() => Promise.resolve({}))
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

// ── TanStack Query shim — a spy client with a controllable cache ───────────
let serversCache: ServersResponse | undefined
const invalidateQueries = vi.fn()
const getQueryData = vi.fn((_key: unknown) => serversCache)
const setQueryData = vi.fn()
const setQueriesData = vi.fn()
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries,
    getQueryData,
    setQueryData,
    setQueriesData,
  }),
}))

function resetHarness() {
  refs = new Map()
  refCounter = 0
  pendingEffects = []
  serversCache = undefined
  apiFetchMock.mockClear()
  invalidateQueries.mockClear()
  getQueryData.mockClear()
  setQueryData.mockClear()
  setQueriesData.mockClear()
}

async function loadHook() {
  const mod = await import("./use-eager-channel-read")
  return mod.useEagerChannelRead
}

// Awaits the microtasks the eager PUT's `.then()` chain schedules.
const settle = () => new Promise((r) => setTimeout(r, 0))

function invalidatedKeys() {
  return invalidateQueries.mock.calls.map((c) => JSON.stringify(c[0].queryKey))
}

beforeEach(() => {
  resetHarness()
})

const server = (id: string, mentions: number) => ({
  id,
  name: id,
  initial: id[0]?.toUpperCase() ?? "?",
  active: false,
  mentions,
  icon: null,
})

describe("useEagerChannelRead — rail-badge fan-out gate", () => {
  it("fires exactly one mark-read PUT per mount", async () => {
    const useHook = await loadHook()
    useHook({
      channelId: "ch_1",
      serverId: "srv_1",
      isChildChannel: false,
      snapshotReady: true,
    })
    flushEffects()
    await settle()
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/channels/ch_1/read", {
      method: "PUT",
    })
  })

  it("does not repeat a PUT for the same channel and fires once after a channel switch", async () => {
    const hook = await loadHook()
    const render = (channelId: string) => {
      refCounter = 0
      pendingEffects = []
      hook({
        channelId,
        serverId: "srv_1",
        isChildChannel: false,
        snapshotReady: true,
      })
      flushEffects()
    }

    render("ch_1")
    await settle()
    render("ch_1")
    await settle()
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    render("ch_2")
    await settle()
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/community/channels/ch_2/read", {
      method: "PUT",
    })
  })

  it("uses the unified channels/[id]/read trunk for a child channel too (a thread IS a channel)", async () => {
    // The per-type /threads/:id/read split is retired — all kinds mark read via
    // channels/[id]/read, which dispatches by surface. isChildChannel no longer
    // picks the endpoint.
    const useHook = await loadHook()
    useHook({
      channelId: "th_9",
      serverId: "srv_1",
      isChildChannel: true,
      snapshotReady: true,
    })
    flushEffects()
    await settle()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/channels/th_9/read", {
      method: "PUT",
    })
  })

  it("always invalidates inbox() after the PUT", async () => {
    const useHook = await loadHook()
    serversCache = { servers: [server("srv_1", 0)] }
    useHook({
      channelId: "ch_1",
      serverId: "srv_1",
      isChildChannel: false,
      snapshotReady: true,
    })
    flushEffects()
    await settle()
    expect(invalidatedKeys()).toContain(JSON.stringify(communityKeys.inbox()))
  })

  it("does NOT refetch any server-level query when this server has no mentions", async () => {
    const useHook = await loadHook()
    serversCache = { servers: [server("srv_1", 0), server("srv_2", 5)] }
    useHook({
      channelId: "ch_1",
      serverId: "srv_1",
      isChildChannel: false,
      snapshotReady: true,
    })
    flushEffects()
    await settle()
    const keys = invalidatedKeys()
    // inbox only — no server(), no servers() cascade.
    expect(keys).toContain(JSON.stringify(communityKeys.inbox()))
    expect(keys).not.toContain(JSON.stringify(communityKeys.server("srv_1")))
    expect(keys).not.toContain(JSON.stringify(communityKeys.servers()))
  })

  it("refreshes the servers() list with exact:true (no cascade) when this server has mentions", async () => {
    const useHook = await loadHook()
    serversCache = { servers: [server("srv_1", 3)] }
    useHook({
      channelId: "ch_1",
      serverId: "srv_1",
      isChildChannel: false,
      snapshotReady: true,
    })
    flushEffects()
    await settle()
    // The badge count lives in the servers() LIST; refresh that, and ONLY that,
    // with exact:true. A non-exact servers() invalidate prefix-matches the
    // nested server(id)/members/presence/… subtree and force-refetches all of
    // it (the per-switch storm). We must NOT touch server(serverId) (it doesn't
    // even hold the count).
    const serversCall = invalidateQueries.mock.calls.find(
      (c) => JSON.stringify(c[0].queryKey) === JSON.stringify(communityKeys.servers()),
    )
    expect(serversCall).toBeTruthy()
    expect(serversCall![0].exact).toBe(true)
    expect(invalidatedKeys()).not.toContain(JSON.stringify(communityKeys.server("srv_1")))
  })

  it("does not PUT until the read-state snapshot is ready", async () => {
    const useHook = await loadHook()
    useHook({
      channelId: "ch_1",
      serverId: "srv_1",
      isChildChannel: false,
      snapshotReady: false,
    })
    flushEffects()
    await settle()
    expect(apiFetchMock).not.toHaveBeenCalled()
  })
})
