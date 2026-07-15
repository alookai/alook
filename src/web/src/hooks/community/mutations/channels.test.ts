/**
 * Channel-mutation tests. Same shim pattern as folders.test.ts / servers.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { UNCATEGORIZED_CATEGORY_ID } from "@alook/shared"

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
  onSettled?: (data: unknown, err: unknown, args: Args, ctx: Ctx) => unknown
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

// Mirrors React Query's lifecycle order: onMutate → mutationFn →
// (onSuccess | onError) → onSettled (always, on both paths).
async function runMutation<Args>(args: Args) {
  const cfg = capturedConfig as MutConfig<Args, unknown>
  const ctx = cfg.onMutate ? await cfg.onMutate(args) : undefined
  try {
    const data = cfg.mutationFn ? await cfg.mutationFn(args) : undefined
    cfg.onSuccess?.(data, args, ctx)
    cfg.onSettled?.(data, undefined, args, ctx)
    return { data, ctx }
  } catch (err) {
    cfg.onError?.(err, args, ctx)
    cfg.onSettled?.(undefined, err, args, ctx)
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

describe("useMoveChannel", () => {
  it("PATCHes the channel with the new categoryId and invalidates the server tree", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useMoveChannel()
    const invalidateSpy = vi.spyOn(capturedQc, "invalidateQueries")

    await runMutation({ serverId: "s1", channelId: "c1", categoryId: "cat2" })

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/c1",
      { method: "PATCH", body: JSON.stringify({ categoryId: "cat2" }) },
    )
    expect(
      invalidateSpy.mock.calls.some((c) => {
        const k = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(k) && k[0] === "community" && k[1] === "servers" && k[2] === "s1"
      }),
    ).toBe(true)
  })

  it("sends categoryId: null when moving to uncategorized", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useMoveChannel()
    await runMutation({ serverId: "s1", channelId: "c1", categoryId: null })
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/c1",
      { method: "PATCH", body: JSON.stringify({ categoryId: null }) },
    )
  })
})

describe("useCreateChannel — optimistic pending row", () => {
  type Ch = { id: string; name: string; type?: string; pending?: boolean }
  type Cat = { id: string; name: string; channels: Ch[] }
  const seed = (categories: Cat[]) =>
    capturedQc.setQueryData(communityKeys.server("s1"), {
      id: "s1", name: "S", description: "", icon: null, ownerId: "u1", categories,
    })
  const channels = (catId: string): Ch[] => {
    const detail = capturedQc.getQueryData<{ categories: Cat[] }>(communityKeys.server("s1"))
    return detail?.categories.find((c) => c.id === catId)?.channels ?? []
  }

  it("inserts a pending channel into the matching category", async () => {
    seed([{ id: "cat_1", name: "General", channels: [] }])
    apiFetchMock.mockResolvedValueOnce({ channel: { id: "ch_real" } })
    const mod = await load()
    mod.useCreateChannel()

    // Observe the cache right after onMutate, before mutationFn resolves.
    const cfg = capturedConfig!
    const ctx = await cfg.onMutate!({ serverId: "s1", categoryId: "cat_1", name: "  hi  ", type: "text" })
    const pending = channels("cat_1")[0]
    expect(pending.id).toMatch(/^tmp_ch_/)
    expect(pending.pending).toBe(true)
    expect(pending.name).toBe("hi")
    expect(pending.type).toBe("text")
    expect((ctx as { tempId: string }).tempId).toBe(pending.id)
  })

  it("cancels in-flight server refetches before the optimistic write", async () => {
    seed([{ id: "cat_1", name: "General", channels: [] }])
    apiFetchMock.mockResolvedValueOnce({ channel: { id: "ch_real" } })
    const mod = await load()
    mod.useCreateChannel()

    const cancelSpy = vi.spyOn(capturedQc, "cancelQueries")
    let cancelledBeforeWrite = false
    const originalSetQueryData = capturedQc.setQueryData.bind(capturedQc)
    vi.spyOn(capturedQc, "setQueryData").mockImplementation(((...args: Parameters<typeof capturedQc.setQueryData>) => {
      if (cancelSpy.mock.calls.length > 0) cancelledBeforeWrite = true
      return originalSetQueryData(...args)
    }) as typeof capturedQc.setQueryData)

    await runMutation({ serverId: "s1", categoryId: "cat_1", name: "hi", type: "text" })
    expect(
      cancelSpy.mock.calls.some((c) => {
        const k = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(k) && k[0] === "community" && k[1] === "servers" && k[2] === "s1"
      }),
    ).toBe(true)
    expect(cancelledBeforeWrite).toBe(true)
  })

  it("is a no-op write when the target category is not in the cache", async () => {
    seed([{ id: "cat_1", name: "General", channels: [{ id: "ch_a", name: "a" }] }])
    apiFetchMock.mockResolvedValueOnce({ channel: { id: "ch_real" } })
    const mod = await load()
    mod.useCreateChannel()
    const ctx = await capturedConfig!.onMutate!({ serverId: "s1", categoryId: "cat_missing", name: "hi", type: "text" })
    expect(channels("cat_1")).toHaveLength(1)
    expect((ctx as { tempId: string }).tempId).toMatch(/^tmp_ch_/)
  })

  it("rolls back to the snapshot on failure", async () => {
    seed([{ id: "cat_1", name: "General", channels: [] }])
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    mod.useCreateChannel()
    await runMutation({ serverId: "s1", categoryId: "cat_1", name: "hi", type: "text" }).catch(() => {})
    expect(channels("cat_1")).toHaveLength(0)
  })

  it("swaps the temp id to the real id and clears pending on success", async () => {
    seed([{ id: "cat_1", name: "General", channels: [] }])
    apiFetchMock.mockResolvedValueOnce({ channel: { id: "ch_real" } })
    const mod = await load()
    mod.useCreateChannel()
    await runMutation({ serverId: "s1", categoryId: "cat_1", name: "hi", type: "text" })
    const row = channels("cat_1")[0]
    expect(row.id).toBe("ch_real")
    expect(row.pending).toBe(false)
  })

  it("invalidates the server tree on both success and failure", async () => {
    const matchesServerKey = (c: { queryKey?: unknown }) => {
      const k = c.queryKey as unknown[] | undefined
      return Array.isArray(k) && k[0] === "community" && k[1] === "servers" && k[2] === "s1"
    }

    seed([{ id: "cat_1", name: "General", channels: [] }])
    apiFetchMock.mockResolvedValueOnce({ channel: { id: "ch_real" } })
    let mod = await load()
    mod.useCreateChannel()
    let invalidateSpy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation({ serverId: "s1", categoryId: "cat_1", name: "hi", type: "text" })
    expect(invalidateSpy.mock.calls.some((c) => matchesServerKey(c[0] ?? {}))).toBe(true)

    capturedQc = new QueryClient()
    seed([{ id: "cat_1", name: "General", channels: [] }])
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    mod = await load()
    mod.useCreateChannel()
    invalidateSpy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation({ serverId: "s1", categoryId: "cat_1", name: "hi", type: "text" }).catch(() => {})
    expect(invalidateSpy.mock.calls.some((c) => matchesServerKey(c[0] ?? {}))).toBe(true)
  })

  it("POSTs { categoryId, name, type } to the channels endpoint", async () => {
    seed([{ id: "cat_1", name: "General", channels: [] }])
    apiFetchMock.mockResolvedValueOnce({ channel: { id: "ch_real" } })
    const mod = await load()
    mod.useCreateChannel()
    await runMutation({ serverId: "s1", categoryId: "cat_1", name: "hi", type: "text" })
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/servers/s1/channels",
      { method: "POST", body: JSON.stringify({ categoryId: "cat_1", name: "hi", type: "text" }) },
    )
  })

  it("synthesizes an uncategorized bucket for the first top-level channel (categoryId empty, no bucket yet)", async () => {
    seed([{ id: "cat_1", name: "General", channels: [] }])
    apiFetchMock.mockResolvedValueOnce({ channel: { id: "ch_real" } })
    const mod = await load()
    mod.useCreateChannel()

    const ctx = await capturedConfig!.onMutate!({ serverId: "s1", categoryId: "", name: "top", type: "text" })
    const bucket = channels(UNCATEGORIZED_CATEGORY_ID)
    expect(bucket).toHaveLength(1)
    expect(bucket[0].id).toBe((ctx as { tempId: string }).tempId)
    expect(bucket[0].pending).toBe(true)

    await capturedConfig!.mutationFn!({ serverId: "s1", categoryId: "", name: "top", type: "text" })
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/servers/s1/channels",
      { method: "POST", body: JSON.stringify({ categoryId: null, name: "top", type: "text" }) },
    )
  })

  it("attaches to an existing empty-name bucket even when its id is not the synthetic constant", async () => {
    seed([{ id: "cat_none", name: "", channels: [] }])
    apiFetchMock.mockResolvedValueOnce({ channel: { id: "ch_real" } })
    const mod = await load()
    mod.useCreateChannel()
    await capturedConfig!.onMutate!({ serverId: "s1", categoryId: "", name: "top", type: "text" })
    // No duplicate synthetic bucket — the pending row lands in the existing one.
    const detail = capturedQc.getQueryData<{ categories: Cat[] }>(communityKeys.server("s1"))
    expect(detail?.categories).toHaveLength(1)
    expect(detail?.categories[0].channels).toHaveLength(1)
  })

  it("translates the synthetic uncategorized bucket id to null for the API, but still writes the optimistic row into that bucket", async () => {
    seed([{ id: UNCATEGORIZED_CATEGORY_ID, name: "", channels: [] }])
    apiFetchMock.mockResolvedValueOnce({ channel: { id: "ch_real" } })
    const mod = await load()
    mod.useCreateChannel()

    const ctx = await capturedConfig!.onMutate!({ serverId: "s1", categoryId: UNCATEGORIZED_CATEGORY_ID, name: "top", type: "text" })
    // Optimistic row landed in the synthetic bucket by its bucket id.
    expect(channels(UNCATEGORIZED_CATEGORY_ID)[0].id).toBe((ctx as { tempId: string }).tempId)

    await capturedConfig!.mutationFn!({ serverId: "s1", categoryId: UNCATEGORIZED_CATEGORY_ID, name: "top", type: "text" })
    // But the wire request sends categoryId: null — never the synthetic id.
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/servers/s1/channels",
      { method: "POST", body: JSON.stringify({ categoryId: null, name: "top", type: "text" }) },
    )
  })
})

describe("useCreateCategory — optimistic pending category", () => {
  type Cat = { id: string; name: string; pending?: boolean; channels: unknown[] }
  const seed = (categories: Cat[]) =>
    capturedQc.setQueryData(communityKeys.server("s1"), {
      id: "s1", name: "S", description: "", icon: null, ownerId: "u1", categories,
    })
  const cats = (): Cat[] =>
    capturedQc.getQueryData<{ categories: Cat[] }>(communityKeys.server("s1"))?.categories ?? []

  it("appends a pending category with a tmp_cat_ id", async () => {
    seed([{ id: "cat_1", name: "General", channels: [] }])
    apiFetchMock.mockResolvedValueOnce({ category: { id: "cat_real" } })
    const mod = await load()
    mod.useCreateCategory()
    const ctx = await capturedConfig!.onMutate!({ serverId: "s1", name: "  Ideas  " })
    const added = cats().find((c) => c.pending)
    expect(added?.id).toMatch(/^tmp_cat_/)
    expect(added?.name).toBe("Ideas")
    expect((ctx as { tempId: string }).tempId).toBe(added?.id)
  })

  it("swaps the temp id to the real id and clears pending on success", async () => {
    seed([{ id: "cat_1", name: "General", channels: [] }])
    apiFetchMock.mockResolvedValueOnce({ category: { id: "cat_real" } })
    const mod = await load()
    mod.useCreateCategory()
    await runMutation({ serverId: "s1", name: "Ideas" })
    const added = cats().find((c) => c.name === "Ideas")
    expect(added?.id).toBe("cat_real")
    expect(added?.pending).toBe(false)
  })

  it("rolls back on failure", async () => {
    seed([{ id: "cat_1", name: "General", channels: [] }])
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    mod.useCreateCategory()
    await runMutation({ serverId: "s1", name: "Ideas" }).catch(() => {})
    expect(cats()).toHaveLength(1)
    expect(cats()[0].id).toBe("cat_1")
  })
})

describe("useDeleteCategory — optimistic removal with rollback", () => {
  type Cat = { id: string; name: string; channels: unknown[] }
  const seed = (categories: Cat[]) =>
    capturedQc.setQueryData(communityKeys.server("s1"), {
      id: "s1", name: "S", description: "", icon: null, ownerId: "u1", categories,
    })
  const cats = (): Cat[] =>
    capturedQc.getQueryData<{ categories: Cat[] }>(communityKeys.server("s1"))?.categories ?? []

  it("removes the category from the cache optimistically", async () => {
    seed([{ id: "cat_1", name: "General", channels: [] }, { id: "cat_2", name: "Ideas", channels: [] }])
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useDeleteCategory()
    await capturedConfig!.onMutate!({ serverId: "s1", categoryId: "cat_2" })
    expect(cats().map((c) => c.id)).toEqual(["cat_1"])
  })

  it("restores the category on a rejected delete (e.g. 409 non-empty)", async () => {
    seed([{ id: "cat_1", name: "General", channels: [] }, { id: "cat_2", name: "Ideas", channels: [] }])
    apiFetchMock.mockRejectedValueOnce(new Error("Move or delete its channels first"))
    const mod = await load()
    mod.useDeleteCategory()
    await runMutation({ serverId: "s1", categoryId: "cat_2" }).catch(() => {})
    expect(cats().map((c) => c.id)).toEqual(["cat_1", "cat_2"])
  })
})
