/**
 * WS2 regression guard — the caching config of the WS-live server-scoped
 * queries.
 *
 * `usePresence` and the server-detail resource are WS-live queries. They carry
 * `staleTime: Infinity` to stop a refetch on every channel switch, paired with
 * `refetchOnReconnect: true`. Server-members pagination is collection-owned;
 * the hook delegates to that projection instead of creating a second query.
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
const serverMembersProjection = vi.hoisted(() => vi.fn(() => ({
  members: [], loading: false, loadingMore: false, hasMore: false, total: 0, failed: false,
})))
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
vi.mock("@/lib/community-db/projections", () => ({
  useOptionalCommunityDbRegistry: () => null,
  useAttentionScopes: () => [],
  useAttentionItems: () => [],
  useServerRailProjection: () => undefined,
  useServerTreeProjection: () => undefined,
  useServerMembersProjection: serverMembersProjection,
}))

function configFor(keyIncludes: string) {
  return queryConfigs.find((c) => JSON.stringify(c.queryKey).includes(keyIncludes))
}

beforeEach(() => {
  queryConfigs = []
  serverMembersProjection.mockClear()
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
    const cfg = configFor("channel-resource")
    expect(cfg?.staleTime).toBe(Infinity)
    expect(cfg?.refetchOnReconnect).toBe(true)
  })

  it("useServerMembers delegates paging to the canonical projection", async () => {
    const { useServerMembers } = await import("./use-server-members")
    useServerMembers("srv_1")
    expect(serverMembersProjection).toHaveBeenCalledWith("srv_1", 50)
    expect(configFor("members")).toBeUndefined()
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
