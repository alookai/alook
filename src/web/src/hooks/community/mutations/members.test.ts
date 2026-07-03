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
  return await import("./members")
}

beforeEach(() => {
  apiFetchMock.mockReset()
  capturedConfig = null
  capturedQc = new QueryClient()
})

describe("useSetMemberRole — optimistic + rollback", () => {
  it("updates the member's role in cache; restores on failure", async () => {
    capturedQc.setQueryData(communityKeys.members("srv_1"), {
      pages: [
        {
          members: [
            { id: "mem_1", userId: "u_1", role: "member", name: "n", avatar: "N", status: "offline", sub: "" },
          ],
          hasMore: false,
          limit: 50,
          total: 1,
        },
      ],
      pageParams: [null],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    mod.useSetMemberRole()
    await runMutation({ serverId: "srv_1", memberId: "mem_1", role: "admin" }).catch(() => {})
    const cache = capturedQc.getQueryData<{ pages: { members: { role: string }[] }[] }>(
      communityKeys.members("srv_1"),
    )
    expect(cache?.pages[0].members[0].role).toBe("member")
  })
})

describe("useKickMember — optimistic + rollback", () => {
  it("removes the member; restores on failure", async () => {
    capturedQc.setQueryData(communityKeys.members("srv_1"), {
      pages: [
        {
          members: [
            { id: "mem_1", userId: "u_1", role: "member", name: "n", avatar: "N", status: "offline", sub: "" },
          ],
          hasMore: false,
          limit: 50,
          total: 1,
        },
      ],
      pageParams: [null],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    mod.useKickMember()
    await runMutation({ serverId: "srv_1", memberId: "mem_1" }).catch(() => {})
    const cache = capturedQc.getQueryData<{ pages: { members: { id: string }[] }[] }>(
      communityKeys.members("srv_1"),
    )
    expect(cache?.pages[0].members).toHaveLength(1)
  })
})
