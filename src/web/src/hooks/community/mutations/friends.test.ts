/**
 * Friend-mutation tests. Same shim pattern as messages.test.ts.
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
  return await import("./friends")
}

beforeEach(() => {
  apiFetchMock.mockReset()
  capturedConfig = null
  capturedQc = new QueryClient()
})

describe("useSendFriendRequest — invalidates friends on success", () => {
  it("triggers invalidateQueries(friends)", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useSendFriendRequest()
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation({ username: "alice" })
    expect(
      spy.mock.calls.some((c) => {
        const k = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(k) && k.includes("friends")
      }),
    ).toBe(true)
  })
})

describe("useAcceptFriendRequest — rollback", () => {
  it("restores the pending row when the server rejects", async () => {
    capturedQc.setQueryData(communityKeys.friends(), {
      friends: [],
      blocked: [],
      pending: [{ id: "f_1", name: "n", avatar: "N", kind: "incoming" }],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    mod.useAcceptFriendRequest()
    await runMutation({ friendshipId: "f_1" }).catch(() => {})
    const cache = capturedQc.getQueryData<{ pending: { id: string }[] }>(communityKeys.friends())
    expect(cache?.pending).toHaveLength(1)
  })
})

describe("useRemoveFriend — optimistic + rollback", () => {
  it("optimistically drops the friend and restores on failure", async () => {
    capturedQc.setQueryData(communityKeys.friends(), {
      friends: [{ id: "f_1", name: "n", avatar: "N", status: "offline", sub: "" }],
      blocked: [],
      pending: [],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    mod.useRemoveFriend()
    await runMutation({ friendshipId: "f_1" }).catch(() => {})
    const cache = capturedQc.getQueryData<{ friends: { id: string }[] }>(communityKeys.friends())
    expect(cache?.friends).toHaveLength(1)
  })
})

describe("useBlockUser — invalidates friends", () => {
  it("triggers invalidateQueries(friends) on success", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useBlockUser()
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation({ userId: "u_bad" })
    expect(
      spy.mock.calls.some((c) => {
        const k = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(k) && k.includes("friends")
      }),
    ).toBe(true)
  })
})

describe("useUnblockUser — rollback", () => {
  it("restores blocked entry on failure", async () => {
    capturedQc.setQueryData(communityKeys.friends(), {
      friends: [],
      blocked: [{ id: "b_1", userId: "u_bad", name: "b", avatar: "B" }],
      pending: [],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    mod.useUnblockUser()
    await runMutation({ userId: "u_bad" }).catch(() => {})
    const cache = capturedQc.getQueryData<{ blocked: { id: string }[] }>(communityKeys.friends())
    expect(cache?.blocked).toHaveLength(1)
  })
})
