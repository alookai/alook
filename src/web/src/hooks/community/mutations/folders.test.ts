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
  return await import("./folders")
}

beforeEach(() => {
  apiFetchMock.mockReset()
  capturedConfig = null
  capturedQc = new QueryClient()
})

describe("useDeleteServerFolder — rollback", () => {
  it("restores the folder on failure", async () => {
    capturedQc.setQueryData(communityKeys.folders(), {
      folders: [{ id: "fld_1", name: "g", position: 0, servers: [] }],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    mod.useDeleteServerFolder()
    await runMutation({ folderId: "fld_1" }).catch(() => {})
    const cache = capturedQc.getQueryData<{ folders: { id: string }[] }>(communityKeys.folders())
    expect(cache?.folders).toHaveLength(1)
  })
})

describe("useUpdateFolderItems — rollback", () => {
  it("restores previous membership on failure", async () => {
    capturedQc.setQueryData(communityKeys.folders(), {
      folders: [
        {
          id: "fld_1",
          name: "g",
          position: 0,
          servers: [{ id: "s_1", name: "a", initial: "A", icon: null }],
        },
      ],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    mod.useUpdateFolderItems()
    await runMutation({ folderId: "fld_1", serverIds: ["s_1", "s_2"] }).catch(() => {})
    const cache = capturedQc.getQueryData<{ folders: { servers: { id: string }[] }[] }>(
      communityKeys.folders(),
    )
    expect(cache?.folders[0].servers.map((s) => s.id)).toEqual(["s_1"])
  })
})
