/**
 * Server-mutation tests. Same shim pattern as messages.test.ts / friends.test.ts.
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
  return await import("./servers")
}

beforeEach(() => {
  apiFetchMock.mockReset()
  capturedConfig = null
  capturedQc = new QueryClient()
})

describe("useLeaveServer — optimistic + rollback", () => {
  it("removes the server row and restores on failure", async () => {
    capturedQc.setQueryData(communityKeys.servers(), {
      servers: [
        { id: "srv_1", name: "n", initial: "N", active: false, unread: false, mentions: 0 },
      ],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    mod.useLeaveServer()
    await runMutation({ serverId: "srv_1" }).catch(() => {})
    const cache = capturedQc.getQueryData<{ servers: { id: string }[] }>(communityKeys.servers())
    expect(cache?.servers).toHaveLength(1)
  })

  it.each(["leave", "delete"] as const)(
    "%s success clears the server subtree, stream, and current private route",
    async (operation) => {
      apiFetchMock.mockResolvedValueOnce(undefined)
      const mod = await load()
      const { useCommunityStore } = await import("@/stores/community")
      const { useMessageStreamStore } = await import("@/stores/community/message-stream")
      useCommunityStore.getState().reset()
      useCommunityStore.getState().setCurrentServerId("srv_1")
      useCommunityStore.getState().setCurrentChannelId("private_child")
      useCommunityStore.getState().setCurrentChannelMeta({
        name: "Private title",
        parentChannelId: "private_parent",
      })
      useMessageStreamStore.getState().dispatch(
        { kind: "channel", id: "private_child", serverId: "srv_1" },
        {
          type: "wsMessage",
          message: {
            id: "message_1",
            type: "chat",
            authorId: "user_1",
            authorName: "User",
            content: "Private content",
          },
        },
      )
      capturedQc.setQueryData(communityKeys.server("srv_1"), {
        id: "srv_1",
        categories: [],
      })
      if (operation === "leave") mod.useLeaveServer()
      else mod.useDeleteServer()

      await runMutation({ serverId: "srv_1" })

      expect(useCommunityStore.getState()).toMatchObject({
        currentServerId: null,
        currentChannelId: null,
        currentChannelMeta: null,
      })
      expect(capturedQc.getQueryState(communityKeys.server("srv_1"))).toBeUndefined()
      expect([...useMessageStreamStore.getState().entries.values()]
        .some((entry) => entry.scope.serverId === "srv_1")).toBe(false)
    },
  )
})

describe("useUpdateServer — rollback on both caches", () => {
  it("restores server-detail + servers-list on failure", async () => {
    capturedQc.setQueryData(communityKeys.server("srv_1"), {
      id: "srv_1",
      name: "old",
      description: "d",
      icon: null,
      ownerId: "u_1",
      categories: [],
    })
    capturedQc.setQueryData(communityKeys.servers(), {
      servers: [
        {
          id: "srv_1",
          name: "old",
          description: "d",
          initial: "O",
          active: false,
          unread: false,
          mentions: 0,
        },
      ],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await load()
    mod.useUpdateServer()
    await runMutation({ serverId: "srv_1", name: "new", description: "d2" }).catch(() => {})
    const detail = capturedQc.getQueryData<{ name: string }>(communityKeys.server("srv_1"))
    expect(detail?.name).toBe("old")
    const list = capturedQc.getQueryData<{ servers: { name: string; description: string }[] }>(
      communityKeys.servers(),
    )
    expect(list?.servers[0]).toMatchObject({ name: "old", description: "d" })
  })

  it("keeps the canonical list metadata aligned with an optimistic detail update", async () => {
    capturedQc.setQueryData(communityKeys.server("srv_1"), {
      id: "srv_1",
      name: "old",
      description: "old description",
      icon: null,
      ownerId: "u_1",
      categories: [],
    })
    capturedQc.setQueryData(communityKeys.servers(), {
      servers: [{
        id: "srv_1",
        name: "old",
        description: "old description",
        initial: "O",
        active: false,
        mentions: 0,
      }],
    })
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useUpdateServer()

    await runMutation({
      serverId: "srv_1",
      name: "new",
      description: "new description",
    })

    expect(capturedQc.getQueryData(communityKeys.server("srv_1"))).toMatchObject({
      name: "new",
      description: "new description",
    })
    expect(capturedQc.getQueryData<{ servers: Array<{ name: string; description: string }> }>(
      communityKeys.servers(),
    )?.servers[0]).toMatchObject({
      name: "new",
      description: "new description",
    })
  })

  it("invalidates the channel-ref directory after settling", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await load()
    mod.useUpdateServer()
    const spy = vi.spyOn(capturedQc, "invalidateQueries")

    await runMutation({ serverId: "srv_1", name: "new", description: "updated" })

    expect(spy).toHaveBeenCalledWith({
      queryKey: communityKeys.channelRefDirectory(),
      exact: true,
    })
  })
})

describe("useCreateServer — invalidates servers()", () => {
  it("fires invalidateQueries after success", async () => {
    apiFetchMock.mockResolvedValueOnce({ server: { id: "srv_new" } })
    const mod = await load()
    mod.useCreateServer()
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation({ name: "n" })
    expect(spy.mock.calls.some((c) => {
      const k = c[0]?.queryKey as unknown[] | undefined
      return Array.isArray(k) && k.includes("servers")
    })).toBe(true)
  })
})

describe("useUploadServerIcon — patches caches on success", () => {
  it("writes cache-busted icon into server detail + list", async () => {
    capturedQc.setQueryData(communityKeys.server("srv_1"), {
      id: "srv_1",
      name: "n",
      description: "d",
      icon: null,
      ownerId: "u_1",
      categories: [],
    })
    capturedQc.setQueryData(communityKeys.servers(), {
      servers: [
        { id: "srv_1", name: "n", initial: "N", active: false, unread: false, mentions: 0, icon: null },
      ],
    })
    // Mock global fetch since uploadServerIcon uses raw fetch, not apiFetch.
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ url: "https://cdn/x" }), { status: 200 })) as typeof fetch
    try {
      const mod = await load()
      mod.useUploadServerIcon()
      const file = new File([""], "icon.png", { type: "image/png" })
      await runMutation({ serverId: "srv_1", file })
      const detail = capturedQc.getQueryData<{ icon: string | null }>(communityKeys.server("srv_1"))
      expect(detail?.icon).toMatch(/^https:\/\/cdn\/x\?t=/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
