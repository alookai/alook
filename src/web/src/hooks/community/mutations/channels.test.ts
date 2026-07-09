/**
 * Channel-mutation tests. Same shim pattern as folders.test.ts / servers.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

vi.mock("react", () => ({
  useRef: (initial: unknown) => ({ current: initial }),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useState: (initial: unknown) => [initial, () => {}],
}))

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

type MutConfig<Args, Ctx> = {
  mutationFn?: (args: Args) => unknown
  onMutate?: (args: Args) => Promise<Ctx> | Ctx
  onSuccess?: (data: unknown, args: Args, ctx: Ctx) => unknown
  onError?: (err: unknown, args: Args, ctx: Ctx) => unknown
}
let capturedConfig: MutConfig<unknown, unknown> | null = null
let capturedQc: QueryClient
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => capturedQc,
    useMutation: (config: MutConfig<unknown, unknown>) => {
      capturedConfig = config
      return {}
    },
  }
})

async function runMutation<Args>(args: Args) {
  const cfg = capturedConfig as MutConfig<Args, unknown>
  const ctx = cfg.onMutate ? await cfg.onMutate(args) : undefined
  try {
    const data = cfg.mutationFn ? await cfg.mutationFn(args) : undefined
    cfg.onSuccess?.(data, args, ctx)
    return { data, ctx }
  } catch (err) {
    cfg.onError?.(err, args, ctx)
    throw err
  }
}

async function load() {
  vi.resetModules()
  return await import("./channels")
}

beforeEach(() => {
  apiFetchMock.mockReset()
  capturedConfig = null
  capturedQc = new QueryClient()
})

describe("useReorderServers — cancels in-flight refetches before optimistic write", () => {
  it("calls cancelQueries with communityKeys.servers() before writing", async () => {
    capturedQc.setQueryData(communityKeys.servers(), {
      servers: [
        { id: "srv_1", name: "a", initial: "A", active: false, unread: false, mentions: 0 },
        { id: "srv_2", name: "b", initial: "B", active: false, unread: false, mentions: 0 },
      ],
    })
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useReorderServers()

    const cancelSpy = vi.spyOn(capturedQc, "cancelQueries")
    let cancelledBeforeWrite = false
    const originalSetQueryData = capturedQc.setQueryData.bind(capturedQc)
    vi.spyOn(capturedQc, "setQueryData").mockImplementation(((...args: Parameters<typeof capturedQc.setQueryData>) => {
      if (cancelSpy.mock.calls.length > 0) cancelledBeforeWrite = true
      return originalSetQueryData(...args)
    }) as typeof capturedQc.setQueryData)

    await runMutation({ serverIds: ["srv_2", "srv_1"] })

    expect(
      cancelSpy.mock.calls.some((c) => {
        const k = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(k) && k[0] === "community" && k[1] === "servers"
      }),
    ).toBe(true)
    expect(cancelledBeforeWrite).toBe(true)
  })

  it("applies the optimistic reorder to the servers cache", async () => {
    capturedQc.setQueryData(communityKeys.servers(), {
      servers: [
        { id: "srv_1", name: "a", initial: "A", active: false, unread: false, mentions: 0 },
        { id: "srv_2", name: "b", initial: "B", active: false, unread: false, mentions: 0 },
      ],
    })
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useReorderServers()
    await runMutation({ serverIds: ["srv_2", "srv_1"] })
    const cache = capturedQc.getQueryData<{ servers: { id: string }[] }>(communityKeys.servers())
    expect(cache?.servers.map((s) => s.id)).toEqual(["srv_2", "srv_1"])
  })

  it("rolls back to the snapshot on failure", async () => {
    capturedQc.setQueryData(communityKeys.servers(), {
      servers: [
        { id: "srv_1", name: "a", initial: "A", active: false, unread: false, mentions: 0 },
        { id: "srv_2", name: "b", initial: "B", active: false, unread: false, mentions: 0 },
      ],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    mod.useReorderServers()
    await runMutation({ serverIds: ["srv_2", "srv_1"] }).catch(() => {})
    const cache = capturedQc.getQueryData<{ servers: { id: string }[] }>(communityKeys.servers())
    expect(cache?.servers.map((s) => s.id)).toEqual(["srv_1", "srv_2"])
  })
})
