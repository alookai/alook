/**
 * Channel-mutation tests. Same shim pattern as folders.test.ts / servers.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { UNCATEGORIZED_CATEGORY_ID } from "@alook/shared"
import { serverDetailResourceKey } from "@/lib/community-db/server-detail-resource"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import type { CategoryRow, ChannelRow } from "@/lib/community-db/schema"

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
let registry: CommunityDbRegistry
let unregister: () => void
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
  return await import("./channels")
}

function resourceFixture(url: unknown) {
  if (typeof url !== "string") return undefined
  if (url.endsWith("/attention")) {
    return {
      scopes: [],
      items: [],
      limit: 100,
      truncated: false,
      included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
    }
  }
  if (url.endsWith("/read-state")) return { revision: 0, readStates: [] }
  if (url.endsWith("/server-folders")) return { folders: [] }
  if (url.endsWith("/notifications")) return []
  if (url.endsWith("/dms")) return { conversations: [] }
  if (url.endsWith("/servers")) return { servers: [] }
  return undefined
}

beforeEach(async () => {
  apiFetchMock.mockReset()
  apiFetchMock.mockImplementation(resourceFixture)
  capturedConfig = null
  capturedQc = new QueryClient()
  const collections = await import("@/lib/community-db/collections")
  registry = collections.createCommunityDbRegistry(capturedQc, "viewer")
  unregister = collections.registerCommunityDbRegistry(registry)
  await registry.preload()
  const start = async (collection: {
    startSyncImmediate?: () => void
    isReady?: () => boolean
    onFirstReady?: (callback: () => void) => () => void
  }) => {
    collection.startSyncImmediate?.()
    if (collection.isReady?.()) return
    await new Promise<void>((resolve) => {
      const subscription: { unsubscribe?: () => void } = {}
      subscription.unsubscribe = collection.onFirstReady?.(() => {
        subscription.unsubscribe?.()
        resolve()
      })
    })
  }
  await Promise.all([
    start(registry.collections.categories),
    start(registry.collections.channels),
  ])
})

afterEach(async () => {
  unregister()
  await registry.cleanup()
})

function seedServerTree(categories: Array<{
  id: string
  name: string
  channels: Array<Partial<ChannelRow> & Pick<ChannelRow, "id" | "name">>
}>) {
  const categoryRows: CategoryRow[] = categories.flatMap((category, position) => (
    category.id === UNCATEGORIZED_CATEGORY_ID || category.name === "" ? [] : [{
      id: category.id,
      serverId: "s1",
      name: category.name,
      position,
      private: false,
      creatorId: null,
      pending: false,
    }]
  ))
  const channelRows: ChannelRow[] = categories.flatMap((category) => (
    category.channels.map((channel, position) => ({
      id: channel.id,
      serverId: "s1",
      categoryId: category.id === UNCATEGORIZED_CATEGORY_ID || category.name === ""
        ? null
        : category.id,
      name: channel.name,
      type: channel.type ?? "text",
      parentChannelId: channel.parentChannelId ?? null,
      parentMessageId: channel.parentMessageId ?? null,
      creatorId: channel.creatorId ?? null,
      position,
      archived: channel.archived ?? false,
      muted: channel.muted ?? false,
      unread: channel.unread ?? false,
      tags: channel.tags ?? [],
      pending: channel.pending ?? false,
      lastMessageAt: channel.lastMessageAt ?? null,
    }))
  ))
  registry.collections.categories.utils.writeBatch(() => {
    const incoming = new Map(categoryRows.map((row) => [row.id, row]))
    const current = new Set<string>()
    for (const row of registry.collections.categories.values()) {
      current.add(row.id)
      const next = incoming.get(row.id)
      if (next) registry.collections.categories.utils.writeUpdate(next)
      else registry.collections.categories.utils.writeDelete(row.id)
    }
    for (const row of categoryRows) {
      if (!current.has(row.id)) registry.collections.categories.utils.writeInsert(row)
    }
  })
  registry.collections.channels.utils.writeBatch(() => {
    const incoming = new Map(channelRows.map((row) => [row.id, row]))
    const current = new Set<string>()
    for (const row of registry.collections.channels.values()) {
      current.add(row.id)
      const next = incoming.get(row.id)
      if (next) registry.collections.channels.utils.writeUpdate(next)
      else registry.collections.channels.utils.writeDelete(row.id)
    }
    for (const row of channelRows) {
      if (!current.has(row.id)) registry.collections.channels.utils.writeInsert(row)
    }
  })
}

function canonicalChannels(categoryId: string) {
  const normalized = categoryId === UNCATEGORIZED_CATEGORY_ID ? null : categoryId
  return [...registry.collections.channels.values()]
    .filter((channel) => channel.serverId === "s1" && channel.categoryId === normalized)
    .sort((left, right) => left.position - right.position)
}

function canonicalCategories() {
  return [...registry.collections.categories.values()]
    .filter((category) => category.serverId === "s1")
    .sort((left, right) => left.position - right.position)
}

describe("useRenameChannel", () => {
  type CachedChannel = { id: string; name: string; active: boolean; unread: boolean }
  type CachedCategory = { id: string; name: string; channels: CachedChannel[] }
  const originalServer = () => ({
    id: "s1",
    name: "Studio",
    discriminator: "0042",
    description: "",
    icon: null,
    ownerId: "u1",
    categories: [{
      id: "cat_1",
      name: "Channels",
      channels: [
        { id: "c1", name: "general", active: true, unread: false },
        { id: "c2", name: "random", active: false, unread: true },
      ],
    }],
  })
  const originalDirectory = () => [{
    id: "s1",
    name: "Studio",
    discriminator: "0042",
    channels: [
      { id: "c1", name: "general" },
      { id: "c2", name: "random" },
    ],
  }, {
    id: "s2",
    name: "Elsewhere",
    discriminator: "0100",
    channels: [{ id: "c3", name: "other" }],
  }]
  const seed = () => {
    seedServerTree(originalServer().categories)
    capturedQc.setQueryData(communityKeys.channelRefDirectory(), originalDirectory())
  }
  const serverChannels = () => [...registry.collections.channels.values()]
    .filter((channel) => channel.serverId === "s1")
  const directory = () =>
    capturedQc.getQueryData<ReturnType<typeof originalDirectory>>(communityKeys.channelRefDirectory())!

  it("cancels both exact queries before optimistically patching both caches", async () => {
    seed()
    apiFetchMock.mockResolvedValueOnce({ id: "c1", name: "General-Chat" })
    const mod = await load()
    mod.useRenameChannel()
    const cancelSpy = vi.spyOn(capturedQc, "cancelQueries")

    await capturedConfig!.onMutate!({ serverId: "s1", channelId: "c1", name: "  General Chat  " })

    expect(cancelSpy).toHaveBeenCalledWith({
      queryKey: serverDetailResourceKey("viewer", "s1"),
      exact: true,
    })
    expect(cancelSpy).toHaveBeenCalledWith({
      queryKey: communityKeys.channelRefDirectory(),
      exact: true,
    })
    expect(serverChannels().map((channel) => channel.name)).toEqual(["General Chat", "random"])
    expect(directory()).toEqual(originalDirectory())
  })

  it("reconciles both caches to the PATCH response's normalized name", async () => {
    seed()
    apiFetchMock.mockResolvedValueOnce({ id: "c1", name: "General-Chat" })
    const mod = await load()
    mod.useRenameChannel()

    await runMutation({ serverId: "s1", channelId: "c1", name: "General Chat" })

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/c1",
      { method: "PATCH", body: JSON.stringify({ name: "General Chat" }) },
    )
    expect(serverChannels().find((channel) => channel.id === "c1")?.name).toBe("General-Chat")
    expect(directory()).toEqual(originalDirectory())
  })

  it("restores both snapshots on failure without optimistic residue", async () => {
    seed()
    apiFetchMock.mockRejectedValueOnce(new Error("duplicate"))
    const mod = await load()
    mod.useRenameChannel()

    await runMutation({ serverId: "s1", channelId: "c1", name: "Taken Name" }).catch(() => {})

    expect(serverChannels().find((channel) => channel.id === "c1")?.name).toBe("general")
    expect(directory()[0].channels.find((channel) => channel.id === "c1")?.name).toBe("general")
  })

  it.each(["success", "error"] as const)(
    "invalidates exact server detail and ref directory after %s",
    async (outcome) => {
      seed()
      if (outcome === "success") {
        apiFetchMock.mockResolvedValueOnce({ id: "c1", name: "renamed" })
      } else {
        apiFetchMock.mockRejectedValueOnce(new Error("boom"))
      }
      const mod = await load()
      mod.useRenameChannel()
      const invalidateSpy = vi.spyOn(capturedQc, "invalidateQueries")

      await runMutation({ serverId: "s1", channelId: "c1", name: "renamed" }).catch(() => {})

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: serverDetailResourceKey("viewer", "s1"),
        exact: true,
      })
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: communityKeys.channelRefDirectory(),
        exact: true,
      })
    },
  )

  it("leaves present caches unchanged when the channel is missing", async () => {
    seed()
    apiFetchMock.mockResolvedValueOnce({ id: "missing", name: "renamed" })
    const beforeServer = capturedQc.getQueryData(communityKeys.server("s1"))
    const beforeDirectory = capturedQc.getQueryData(communityKeys.channelRefDirectory())
    const mod = await load()
    mod.useRenameChannel()

    await runMutation({ serverId: "s1", channelId: "missing", name: "renamed" })

    expect(capturedQc.getQueryData(communityKeys.server("s1"))).toBe(beforeServer)
    expect(capturedQc.getQueryData(communityKeys.channelRefDirectory())).toBe(beforeDirectory)
  })

  it("still cancels the directory when no canonical registry owns a server key", async () => {
    seed()
    unregister()
    unregister = () => {}
    const mod = await load()
    mod.useRenameChannel()
    const cancelSpy = vi.spyOn(capturedQc, "cancelQueries")

    await capturedConfig!.onMutate!({ serverId: "s1", channelId: "c1", name: "renamed" })

    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(cancelSpy).toHaveBeenCalledWith({
      queryKey: communityKeys.channelRefDirectory(),
      exact: true,
    })
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
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: serverDetailResourceKey("viewer", "s1"),
      exact: true,
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: communityKeys.channelRefDirectory(),
      exact: true,
    })
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

  it.each([
    ["cat_2", "cat_2"],
    [UNCATEGORIZED_CATEGORY_ID, null],
  ] as const)("publishes a successful move to %s in the canonical row", async (target, expected) => {
    seedServerTree([
      { id: "cat_1", name: "One", channels: [{ id: "c1", name: "general" }] },
      { id: "cat_2", name: "Two", channels: [] },
    ])
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useMoveChannel()

    await runMutation({ serverId: "s1", channelId: "c1", categoryId: target })

    expect(registry.collections.channels.get("c1")?.categoryId).toBe(expected)
  })
})

describe("useCreateChannel — optimistic pending row", () => {
  type Ch = { id: string; name: string; type?: string; pending?: boolean }
  type Cat = { id: string; name: string; channels: Ch[] }
  const seed = (categories: Cat[]) => seedServerTree(categories)
  const channels = (catId: string): Ch[] => {
    return canonicalChannels(catId)
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
    const originalWriteUpsert = registry.collections.channels.utils.writeUpsert.bind(
      registry.collections.channels.utils,
    )
    vi.spyOn(registry.collections.channels.utils, "writeUpsert").mockImplementation(((...args: Parameters<typeof originalWriteUpsert>) => {
      if (cancelSpy.mock.calls.length > 0) cancelledBeforeWrite = true
      return originalWriteUpsert(...args)
    }) as typeof registry.collections.channels.utils.writeUpsert)

    await runMutation({ serverId: "s1", categoryId: "cat_1", name: "hi", type: "text" })
    expect(
      cancelSpy.mock.calls.some((c) => {
        const k = c[0]?.queryKey as unknown[] | undefined
        return JSON.stringify(k) === JSON.stringify(serverDetailResourceKey("viewer", "s1"))
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

  it("re-inserts a snapshotted channel that disappeared before rollback", async () => {
    seed([{ id: "cat_1", name: "General", channels: [{ id: "c1", name: "original" }] }])
    const mod = await load()
    mod.useCreateChannel()
    const args = { serverId: "s1", categoryId: "cat_1", name: "new", type: "text" as const }
    const ctx = await capturedConfig!.onMutate!(args)
    registry.collections.channels.utils.writeDelete("c1")

    capturedConfig!.onError?.(new Error("failed"), args, ctx)

    expect(registry.collections.channels.get("c1")?.name).toBe("original")
    expect(channels("cat_1")).toHaveLength(1)
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
      return JSON.stringify(c.queryKey) === JSON.stringify(serverDetailResourceKey("viewer", "s1"))
    }

    seed([{ id: "cat_1", name: "General", channels: [] }])
    apiFetchMock.mockResolvedValueOnce({ channel: { id: "ch_real" } })
    let mod = await load()
    mod.useCreateChannel()
    let invalidateSpy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation({ serverId: "s1", categoryId: "cat_1", name: "hi", type: "text" })
    expect(invalidateSpy.mock.calls.some((c) => matchesServerKey(c[0] ?? {}))).toBe(true)

    seed([{ id: "cat_1", name: "General", channels: [] }])
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    mod = await load()
    mod.useCreateChannel()
    invalidateSpy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation({ serverId: "s1", categoryId: "cat_1", name: "hi", type: "text" }).catch(() => {})
    expect(invalidateSpy.mock.calls.some((c) => matchesServerKey(c[0] ?? {}))).toBe(true)
  })

  it("POSTs { type, serverId, categoryId, name } to the unified create door", async () => {
    seed([{ id: "cat_1", name: "General", channels: [] }])
    apiFetchMock.mockResolvedValueOnce({ channel: { id: "ch_real" } })
    const mod = await load()
    mod.useCreateChannel()
    await runMutation({ serverId: "s1", categoryId: "cat_1", name: "hi", type: "text" })
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels",
      { method: "POST", body: JSON.stringify({ type: "text", serverId: "s1", categoryId: "cat_1", name: "hi" }) },
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
      "/api/community/channels",
      { method: "POST", body: JSON.stringify({ type: "text", serverId: "s1", categoryId: null, name: "top" }) },
    )
  })

  it("attaches to an existing empty-name bucket even when its id is not the synthetic constant", async () => {
    seed([{ id: "cat_none", name: "", channels: [] }])
    apiFetchMock.mockResolvedValueOnce({ channel: { id: "ch_real" } })
    const mod = await load()
    mod.useCreateChannel()
    await capturedConfig!.onMutate!({ serverId: "s1", categoryId: "", name: "top", type: "text" })
    // No duplicate synthetic bucket — the pending row lands in the existing one.
    expect(canonicalCategories()).toHaveLength(0)
    expect(channels(UNCATEGORIZED_CATEGORY_ID)).toHaveLength(1)
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
      "/api/community/channels",
      { method: "POST", body: JSON.stringify({ type: "text", serverId: "s1", categoryId: null, name: "top" }) },
    )
  })
})

describe("useCreateCategory — optimistic pending category", () => {
  type Cat = { id: string; name: string; pending?: boolean; channels: Array<{ id: string; name: string }> }
  const seed = (categories: Cat[]) => seedServerTree(categories)
  const cats = (): Cat[] => canonicalCategories().map((category) => ({
    id: category.id,
    name: category.name,
    pending: category.pending,
    channels: [],
  }))

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

describe("useDeleteChannel", () => {
  it("retires projected unread after a successful DELETE without waiting for self-WS", async () => {
    const mod = await load()
    const { getActiveAccountUnreadProjection } = await import(
      "@/hooks/community/account-unread-projection"
    )
    const projection = getActiveAccountUnreadProjection(capturedQc)
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    mod.useDeleteChannel()
    apiFetchMock.mockResolvedValueOnce(undefined)

    await runMutation({ serverId: "s1", channelId: "c1" })

    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
    expect(projection.projectUnread("inbox-unreads", "c1", true, 1)).toBe(false)
  })

  it("keeps projected unread when the DELETE fails", async () => {
    const mod = await load()
    const { getActiveAccountUnreadProjection } = await import(
      "@/hooks/community/account-unread-projection"
    )
    const projection = getActiveAccountUnreadProjection(capturedQc)
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    mod.useDeleteChannel()
    apiFetchMock.mockRejectedValueOnce(new Error("500"))

    await expect(runMutation({ serverId: "s1", channelId: "c1" })).rejects.toThrow("500")

    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
    expect(projection.projectUnread("inbox-unreads", "c1", true, 1)).toBe(true)
  })
})

describe("useDeleteCategory — optimistic removal with rollback", () => {
  type Cat = { id: string; name: string; channels: Array<{ id: string; name: string }> }
  const seed = (categories: Cat[]) => seedServerTree(categories)
  const cats = (): Cat[] => canonicalCategories().map((category) => ({
    id: category.id,
    name: category.name,
    channels: [],
  }))

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

describe("committed category mutations", () => {
  it("sends and publishes the category name update", async () => {
    seedServerTree([{ id: "cat_1", name: "Original", channels: [] }])
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useUpdateCategory()

    await runMutation({ serverId: "s1", categoryId: "cat_1", name: "Renamed" })

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/servers/s1/categories/cat_1",
      { method: "PATCH", body: JSON.stringify({ name: "Renamed" }) },
    )
    expect(registry.collections.categories.get("cat_1")?.name).toBe("Renamed")
  })

  it("publishes successful category reordering and ignores unknown ids", async () => {
    seedServerTree([
      { id: "cat_1", name: "One", channels: [] },
      { id: "cat_2", name: "Two", channels: [] },
    ])
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useReorderCategories()

    await runMutation({ serverId: "s1", categoryIds: ["cat_2", "missing", "cat_1"] })

    expect(canonicalCategories().map(({ id, position }) => [id, position])).toEqual([
      ["cat_2", 0],
      ["cat_1", 2],
    ])
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/servers/s1/categories/reorder",
      { method: "PATCH", body: JSON.stringify({ categoryIds: ["cat_2", "missing", "cat_1"] }) },
    )
  })

  it("publishes successful channel reordering and ignores unknown ids", async () => {
    seedServerTree([{ id: "cat_1", name: "One", channels: [
      { id: "c1", name: "One" },
      { id: "c2", name: "Two" },
    ] }])
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useReorderChannels()

    await runMutation({ serverId: "s1", channelIds: ["c2", "missing", "c1"] })

    expect(canonicalChannels("cat_1").map(({ id, position }) => [id, position])).toEqual([
      ["c2", 0],
      ["c1", 2],
    ])
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/servers/s1/channels/reorder",
      { method: "PATCH", body: JSON.stringify({ channelIds: ["c2", "missing", "c1"] }) },
    )
  })
})
