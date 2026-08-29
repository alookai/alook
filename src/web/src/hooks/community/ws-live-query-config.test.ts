/**
 * WS2 regression guard — the caching config of the WS-live server-scoped
 * queries.
 *
 * `usePresence`, `useServer` and `useServerMembers` read caches that incoming
 * WebSocket events live-patch, so they carry `staleTime: Infinity` to stop a
 * refetch on every channel switch. That is ONLY safe paired with
 * `refetchOnReconnect: true`: the WS reconnect handler does not re-seed these
 * caches, so an event missed during a socket gap would otherwise leave them
 * permanently stale. These tests pin that pairing so a future edit can't drop
 * the reconnect backstop while keeping the infinite staleTime.
 *
 * `useInvites` is NOT WS-live — it gets a short finite staleTime instead,
 * and must NOT be `Infinity`.
 *
 * The hooks are driven through a minimal react shim (the vitest env is node);
 * `useQuery` / `useInfiniteQuery` are mocked to capture the options object.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// ── react shim — functional stubs so the hooks run without a render loop ────
vi.mock("react", () => ({
  useMemo: (fn: () => unknown) => fn(),
  useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => {}],
  useRef: (init: unknown) => ({ current: init }),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}))

// ── react-query shim — capture each query's options ─────────────────────────
let queryConfigs: Array<Record<string, unknown>> = []
const queryStub = {
  data: undefined,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: () => {},
}
vi.mock("@tanstack/react-query", () => ({
  useQuery: (cfg: Record<string, unknown>) => {
    queryConfigs.push(cfg)
    return queryStub
  },
  useInfiniteQuery: (cfg: Record<string, unknown>) => {
    queryConfigs.push(cfg)
    return queryStub
  },
  useQueryClient: () => ({
    setQueryData: () => {},
    getQueryData: () => undefined,
    invalidateQueries: () => {},
  }),
  keepPreviousData: Symbol("keepPreviousData"),
}))

vi.mock("@/lib/api/client", () => ({
  apiFetch: vi.fn(() => Promise.resolve({})),
  toastApiError: vi.fn(),
}))

function configFor(keyIncludes: string) {
  return queryConfigs.find((c) => JSON.stringify(c.queryKey).includes(keyIncludes))
}

beforeEach(() => {
  queryConfigs = []
})

describe("WS-live queries — staleTime: Infinity + refetchOnReconnect backstop", () => {
  it("usePresence pairs Infinity staleTime with refetchOnReconnect", async () => {
    const { usePresence } = await import("./use-server-panels")
    usePresence("srv_1")
    const cfg = configFor("presence")
    expect(cfg?.staleTime).toBe(Infinity)
    expect(cfg?.refetchOnReconnect).toBe(true)
  })

  it("useServer pairs Infinity staleTime with refetchOnReconnect", async () => {
    const { useServer } = await import("./use-servers")
    useServer("srv_1")
    // The plain server-detail key ends at the serverId — no trailing segment
    // like "presence"/"members" — so match it exactly.
    const cfg = queryConfigs.find(
      (c) => JSON.stringify(c.queryKey) === JSON.stringify(["community", "servers", "srv_1"]),
    )
    expect(cfg?.staleTime).toBe(Infinity)
    expect(cfg?.refetchOnReconnect).toBe(true)
  })

  it("useServerMembers pairs Infinity staleTime with refetchOnReconnect", async () => {
    const { useServerMembers } = await import("./use-server-members")
    useServerMembers("srv_1")
    const cfg = configFor("members")
    expect(cfg?.staleTime).toBe(Infinity)
    expect(cfg?.refetchOnReconnect).toBe(true)
  })

  it("useServers (the rail / mention-badge list) pairs Infinity staleTime with refetchOnReconnect", async () => {
    // Regression guard: without this the top-level servers() list refetched
    // `GET /api/community/servers` on every channel switch that remounted a
    // consumer — a per-switch server-level request WS1/WS2 were meant to kill.
    const { useServers } = await import("./use-servers")
    useServers()
    const cfg = queryConfigs.find(
      (c) => JSON.stringify(c.queryKey) === JSON.stringify(["community", "servers"]),
    )
    expect(cfg?.staleTime).toBe(Infinity)
    expect(cfg?.refetchOnReconnect).toBe(true)
  })
})

describe("non-WS-live queries — finite staleTime, never Infinity", () => {
  it("useInvites uses a finite staleTime", async () => {
    const { useInvites } = await import("./use-server-panels")
    useInvites("srv_1", true)
    const cfg = configFor("invites")
    expect(cfg?.staleTime).toBe(60_000)
    expect(cfg?.staleTime).not.toBe(Infinity)
  })

})
