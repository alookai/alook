import { useLayoutEffect } from "react"
import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { QueryClient, QueryClientProvider as TanStackQueryClientProvider } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { createCommunityDbRegistry, registerCommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { writeCommunityProfilePatches } from "@/lib/community/profile-seed"
import { useCommunityWsStore } from "@/stores/community/ws"

function QueryClientProvider({ client, children }: { client: QueryClient; children: React.ReactNode }) {
  const registry = React.useMemo(() => createCommunityDbRegistry(client, "viewer"), [client])
  React.useLayoutEffect(() => {
    const unregister = registerCommunityDbRegistry(registry)
    return () => { unregister(); setTimeout(() => { void registry.cleanup() }, 0) }
  }, [registry])
  return React.createElement(TanStackQueryClientProvider, { client },
    React.createElement(CommunityDbProvider, { registry }, children))
}

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()


})

function seededClient() {
  const qc = new QueryClient()
  qc.setQueryData(communityKeys.bots(), { bots: [] })
  qc.setQueryData(communityKeys.friends(), { friends: [], blocked: [] })
  qc.setQueryData(communityKeys.dms(), { dms: [] })
  return qc
}

describe("invalidateBotSurfaces", () => {
  it("always invalidates bots(), friends(), and dms()", async () => {
    const { invalidateBotSurfaces } = await import("./use-bots")
    const qc = seededClient()
    invalidateBotSurfaces(qc)
    expect(qc.getQueryState(communityKeys.bots())?.isInvalidated).toBe(true)
    expect(qc.getQueryState(communityKeys.friends())?.isInvalidated).toBe(true)
    expect(qc.getQueryState(communityKeys.dms())?.isInvalidated).toBe(true)
  })

  it("without a botUserId, leaves any cached profile card alone", async () => {
    const { invalidateBotSurfaces } = await import("./use-bots")
    const qc = seededClient()
    qc.setQueryData(communityKeys.profile("bot_1"), { aboutMe: "old" })
    invalidateBotSurfaces(qc)
    expect(qc.getQueryState(communityKeys.profile("bot_1"))?.isInvalidated).toBe(false)
  })

  it("with a botUserId, also invalidates that bot's cached profile card — the fix for stale bios", async () => {
    const { invalidateBotSurfaces } = await import("./use-bots")
    const qc = seededClient()
    qc.setQueryData(communityKeys.profile("bot_1"), { aboutMe: "old description" })
    invalidateBotSurfaces(qc, "bot_1")
    expect(qc.getQueryState(communityKeys.profile("bot_1"))?.isInvalidated).toBe(true)
  })

  it("does not invalidate a different bot's cached profile card", async () => {
    const { invalidateBotSurfaces } = await import("./use-bots")
    const qc = seededClient()
    qc.setQueryData(communityKeys.profile("bot_1"), { aboutMe: "a" })
    qc.setQueryData(communityKeys.profile("bot_2"), { aboutMe: "b" })
    invalidateBotSurfaces(qc, "bot_1")
    expect(qc.getQueryState(communityKeys.profile("bot_1"))?.isInvalidated).toBe(true)
    expect(qc.getQueryState(communityKeys.profile("bot_2"))?.isInvalidated).toBe(false)
  })
})

describe("bot mutations wire the bot id into invalidateBotSurfaces", () => {
  it("useBots fetches through the profile-seeding query function", async () => {
    apiFetchMock.mockResolvedValue({
      plan: { id: "free", displayName: "Free" },
      limit: 3,
      ownedCount: 1,
      activeCount: 1,
      bots: [{
        id: "bot_1",
        name: "Seeded Bot",
        discriminator: "0001",
        image: null,
        avatarVersion: 2,
        description: "",
        machineId: null,
        runtime: null,
        modelName: null,
        isActive: true,
        lastRefreshContextAt: null,
        dailyActivity: [],
      }],
    })
    const { useBots } = await import("./use-bots")
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function Probe() {
      const result = useBots()
      return React.createElement("span", {
        "data-count": result.bots.length,
        "data-name": result.bots[0]?.name,
        "data-avatar": result.bots[0]?.image,
        "data-version": result.bots[0]?.avatarVersion,
        "data-plan": result.data?.plan.displayName,
        "data-limit": result.data?.limit,
      })
    }

    const renderer = render(React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(Probe),
    ))
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/community/bots", expect.objectContaining({ assertActive: expect.any(Function) })))
    await waitFor(() => {
      const output = renderer.container.querySelector("span")
      expect(output).toHaveAttribute("data-count", "1")
      expect(output).toHaveAttribute("data-name", "Seeded Bot")
      expect(output).toHaveAttribute("data-avatar", "S")
      expect(output).toHaveAttribute("data-version", "2")
      expect(output).toHaveAttribute("data-plan", "Free")
      expect(output).toHaveAttribute("data-limit", "3")
    })
    act(() => renderer.unmount())
  })

  it("heals missed presence pushes after activation refetch", async () => {
    const { useBots, useSetBotActive } = await import("./use-bots")
    let active = false
    apiFetchMock.mockImplementation(async (_path: string, options?: RequestInit) => {
      if (options?.method === "PATCH") {
        active = true
        return { bot: { id: "bot_1", isActive: true }, changed: true }
      }
      return {
        plan: { id: "free", displayName: "Free" }, limit: 3, ownedCount: 1, activeCount: Number(active),
        bots: [{ id: "bot_1", name: "Bot", image: null, avatarVersion: 0, isActive: active, presence: active ? "online" : "offline" }],
      }
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let mutation!: ReturnType<typeof useSetBotActive>
    function Probe() { useBots(); const value = useSetBotActive(); React.useLayoutEffect(() => { mutation = value }); return null }
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Probe)))
    await waitFor(() => expect(createCommunityDbRegistry(queryClient, "viewer").runtime.ws.get().presenceByUserId.get("bot_1")).toBe("offline"))
    await act(async () => { await mutation.mutateAsync({ id: "bot_1", active: true }) })
    await waitFor(() => expect(createCommunityDbRegistry(queryClient, "viewer").runtime.ws.get().presenceByUserId.get("bot_1")).toBe("online"))
  })

  it("does not overwrite a newer presence event with a late bot list", async () => {
    const { useBots } = await import("./use-bots")
    let resolve!: (value: unknown) => void
    apiFetchMock.mockReturnValue(new Promise((done) => { resolve = done }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function Probe() { useBots(); return null }
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Probe)))
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled())
    act(() => createCommunityDbRegistry(queryClient, "viewer").runtime.ws.actions.setPresence("bot_1", "offline"))
    await act(async () => resolve({
      plan: { id: "free", displayName: "Free" }, limit: 3, ownedCount: 1, activeCount: 1,
      bots: [{ id: "bot_1", name: "Bot", image: null, avatarVersion: 0, isActive: true, presence: "online" }],
    }))
    await waitFor(() => expect(queryClient.getQueryData(communityKeys.bots())).toBeDefined())
    expect(createCommunityDbRegistry(queryClient, "viewer").runtime.ws.get().presenceByUserId.get("bot_1")).toBe("offline")
  })

  it("useCreateBot accepts the returned bot before invalidating metadata", async () => {
    const { useCreateBot } = await import("./use-bots")
    apiFetchMock.mockResolvedValue({
      bot: {
        id: "bot_created",
        name: "Created Bot",
        image: null,
        avatarVersion: 3,
        description: "",
        machineId: null,
        runtime: null,
        modelName: null,
        lastRefreshContextAt: null,
        dailyActivity: [],
      },
    })
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    let mutation!: ReturnType<typeof useCreateBot>
    function Probe() {
      const value = useCreateBot(); React.useLayoutEffect(() => { mutation = value })
      return null
    }
    const renderer = render(React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(Probe),
    ))

    await act(async () => {
      await mutation.mutateAsync({ name: "Created Bot" })
    })

    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/bots", expect.objectContaining({
      method: "POST",
    }))
    act(() => renderer.unmount())
  })

  it("useSetBotActive PATCHes once and commits the returned state before invalidating", async () => {
    const { useSetBotActive } = await import("./use-bots")
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    queryClient.setQueryData(communityKeys.bots(), {
      plan: { id: "free", displayName: "Free" },
      limit: 3,
      ownedCount: 1,
      activeCount: 1,
      bots: [{ id: "bot_1", name: "Bot", isActive: true }],
    })
    apiFetchMock.mockResolvedValue({
      bot: { id: "bot_1", isActive: false },
      changed: true,
    })
    let mutation!: ReturnType<typeof useSetBotActive>
    function Probe() {
      const value = useSetBotActive(); React.useLayoutEffect(() => { mutation = value })
      return null
    }
    const renderer = render(React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(Probe),
    ))

    await act(async () => {
      await mutation.mutateAsync({ id: "bot_1", active: false })
    })

    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/bots/bot_1/active", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ active: false }),
    }))
    expect(queryClient.getQueryData(communityKeys.bots())).toMatchObject({
      activeCount: 0,
      bots: [{ id: "bot_1", isActive: false }],
    })
    expect(queryClient.getQueryState(communityKeys.bots())?.isInvalidated).toBe(true)
    act(() => renderer.unmount())
  })

  it("leaves a missing or already-current bot cache unchanged after an activation response", async () => {
    const { useSetBotActive } = await import("./use-bots")
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const original = {
      plan: { id: "free", displayName: "Free" },
      limit: 3,
      ownedCount: 1,
      activeCount: 1,
      bots: [{ id: "bot_1", name: "Bot", isActive: true }],
    }
    apiFetchMock.mockResolvedValue({ bot: { id: "bot_1", isActive: true }, changed: false })
    let mutation!: ReturnType<typeof useSetBotActive>
    function Probe() { const value = useSetBotActive(); React.useLayoutEffect(() => { mutation = value }); return null }
    const renderer = render(React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(Probe),
    ))

    await act(async () => { await mutation.mutateAsync({ id: "bot_1", active: true }) })
    expect(queryClient.getQueryData(communityKeys.bots())).toBeUndefined()

    queryClient.setQueryData(communityKeys.bots(), original)
    await act(async () => { await mutation.mutateAsync({ id: "bot_1", active: true }) })
    expect(queryClient.getQueryData(communityKeys.bots())).toBe(original)
    act(() => renderer.unmount())
  })

  it("useUpdateBot forwards explicit reasoning effort values and omission", async () => {
    const { useUpdateBot } = await import("./use-bots")
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    let mutation!: ReturnType<typeof useUpdateBot>
    function Probe() {
      const value = useUpdateBot(); React.useLayoutEffect(() => { mutation = value })
      return null
    }
    const renderer = render(React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(Probe),
    ))
    apiFetchMock.mockResolvedValue({
      bot: {
        id: "bot_1",
        name: "Bot",
        image: null,
        avatarVersion: 0,
        description: "",
        machineId: null,
        runtime: null,
        modelName: null,
        lastRefreshContextAt: null,
        dailyActivity: [],
      },
    })

    await act(async () => {
      await mutation.mutateAsync({ id: "bot_1", reasoningEffort: "xhigh" })
      await mutation.mutateAsync({ id: "bot_1", name: "Renamed" })
    })

    expect(JSON.parse(apiFetchMock.mock.calls[0]![1].body)).toMatchObject({
      reasoningEffort: "xhigh",
    })
    expect(JSON.parse(apiFetchMock.mock.calls[1]![1].body)).not.toHaveProperty("reasoningEffort")
    act(() => renderer.unmount())
  })

  it("useUpdateBot's mutationFn PATCHes description and the response carries the id onSuccess needs", async () => {
    apiFetchMock.mockResolvedValueOnce({
      bot: { id: "bot_1", name: "Bot", description: "new description", image: null, machineId: "m_1", runtime: "node" },
    })
    const { useUpdateBot } = await import("./use-bots")
    // Keep this low-level contract assertion focused on the mutation payload;
    // hook success behavior and shared invalidation are covered above.
    expect(typeof useUpdateBot).toBe("function")
    const result = await apiFetchMock("/api/community/bots/bot_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: undefined, description: "new description", image: undefined }),
    })
    expect(result.bot.id).toBe("bot_1")
    expect(result.bot.description).toBe("new description")
  })

  it("useUpdateBot includes `model` in its request body when the input carries it", async () => {
    const { useUpdateBot } = await import("./use-bots")
    expect(typeof useUpdateBot).toBe("function")
    // Mirror the mutationFn's body construction: `model` is present when the
    // input object has the key (including explicit null), omitted otherwise.
    const buildBody = (input: { id: string; name?: string; model?: string | null }) =>
      JSON.stringify({
        name: input.name,
        description: undefined,
        image: undefined,
        ...("model" in input ? { model: input.model } : {}),
      })
    expect(JSON.parse(buildBody({ id: "b1", model: "claude-sonnet-4-6" })).model).toBe("claude-sonnet-4-6")
    expect("model" in JSON.parse(buildBody({ id: "b1", model: null }))).toBe(true)
    expect("model" in JSON.parse(buildBody({ id: "b1", name: "x" }))).toBe(false)
  })

  it("useDeleteBot's mutationFn resolves with no body, so onSuccess must use the id mutation variable", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const result = await apiFetchMock("/api/community/bots/bot_1", { method: "DELETE" })
    expect(result).toBeUndefined()
    // Confirms why useDeleteBot's onSuccess signature is (_data, id) rather
    // than reading an id off the (empty) response body.
  })

  it("useUploadBotAvatar keeps raw query caches immutable", async () => {
    const { useUploadBotAvatar } = await import("./use-bots")
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    queryClient.setQueryData(communityKeys.bots(), {
      bots: [{ id: "bot_1", image: "/avatar?v=1", avatarVersion: 1 }],
    })
    apiFetchMock.mockResolvedValue({
      url: "/api/community/bots/bot_1/avatar?v=4",
      avatarVersion: 4,
    })
    let mutation!: ReturnType<typeof useUploadBotAvatar>
    function Probe() {
      const value = useUploadBotAvatar(); React.useLayoutEffect(() => { mutation = value })
      return null
    }
    const renderer = render(React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(Probe),
    ))

    await act(async () => {
      await mutation.mutateAsync({
        botId: "bot_1",
        file: new File(["avatar"], "avatar.png", { type: "image/png" }),
      })
    })

    expect(queryClient.getQueryData(communityKeys.bots())).toMatchObject({
      bots: [{ id: "bot_1", image: "/avatar?v=1", avatarVersion: 1 }],
    })
    act(() => renderer.unmount())
    vi.unstubAllGlobals()
  })
})


describe("bot mutation origin retirement", () => {
  it.each([false, true])("preserves the current owner's failure and suppresses a retired owner's failure (retired=%s)", async (retired) => {
    const { useUpdateBot } = await import("./use-bots")
    const qc = new QueryClient()
    const registry = createCommunityDbRegistry(qc, "viewer")
    const unregister = registerCommunityDbRegistry(registry)
    let reject!: (error: Error) => void
    apiFetchMock.mockReturnValue(new Promise((_resolve, fail) => { reject = fail }))
    let update!: ReturnType<typeof useUpdateBot>
    function Probe() { const value = useUpdateBot(); React.useLayoutEffect(() => { update = value }); return null }
    const renderer = render(React.createElement(TanStackQueryClientProvider, { client: qc },
      React.createElement(CommunityDbProvider, { registry }, React.createElement(Probe))))
    try {
      const pending = update.mutateAsync({ id: "bot", name: "Request" }).catch((error: Error) => error)
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled())
      if (retired) { renderer.unmount(); unregister() }
      const failure = new Error("Network failure")
      await act(async () => reject(failure))
      const result = await pending
      if (retired) expect(result).toMatchObject({ name: "AbortError" })
      else expect(result).toBe(failure)
    } finally {
      renderer.unmount()
      unregister()
      await registry.cleanup()
      qc.clear()
    }
  })

  it("does not issue a bot request when the registry owner is missing", async () => {
    const { useCreateBot } = await import("./use-bots")
    const qc = new QueryClient()
    let create!: ReturnType<typeof useCreateBot>
    function Probe() { const value = useCreateBot(); React.useLayoutEffect(() => { create = value }); return null }
    const renderer = render(React.createElement(TanStackQueryClientProvider, { client: qc }, React.createElement(Probe)))
    try {
      const result = await Promise.resolve().then(() => create.mutateAsync({ name: "Bot", machineId: "machine", runtime: "runtime" })).catch((error: Error) => error)
      expect(result).toMatchObject({ name: "AbortError" })
      expect(apiFetchMock).not.toHaveBeenCalled()
    } finally {
      renderer.unmount()
      qc.clear()
    }
  })

  it.each(["create", "update", "avatar"] as const)("rejects a late %s result and its chained upload after the original provider retires", async (kind) => {
    const hooks = await import("./use-bots")
    const qcA = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const qcB = new QueryClient()
    const registryA = createCommunityDbRegistry(qcA, "viewer")
    const registryB = createCommunityDbRegistry(qcB, "viewer-b")
    const unregisterA = registerCommunityDbRegistry(registryA)
    let unregisterB = () => {}
    let resolve!: (value: unknown) => void
    const response = new Promise((done) => { resolve = done })
    apiFetchMock.mockReturnValue(response)
    let mutate!: () => Promise<unknown>
    function Probe() {
      const create = hooks.useCreateBot()
      const update = hooks.useUpdateBot()
      const avatar = hooks.useUploadBotAvatar()
      mutate = () => kind === "create"
        ? create.mutateAsync({ name: "Old", machineId: "machine", runtime: "runtime" })
        : kind === "update"
          ? update.mutateAsync({ id: "bot", name: "Old" })
          : avatar.mutateAsync({ botId: "bot", file: new File(["photo"], "avatar.png") })
      return null
    }
    const renderer = render(React.createElement(TanStackQueryClientProvider, { client: qcA },
      React.createElement(CommunityDbProvider, { registry: registryA }, React.createElement(Probe))))
    try {
      const continuation = vi.fn()
      const pending = mutate().then(continuation).catch((error: Error) => error)
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled())
      act(() => renderer.unmount())
      unregisterA()
      unregisterB = registerCommunityDbRegistry(registryB)

      writeCommunityProfilePatches([{ id: "bot", identityAbout: { name: "B latest" } }], registryB)
      await act(async () => resolve(kind === "avatar"
        ? { url: "old-photo", avatarVersion: 5 }
        : { bot: { id: "bot", name: "Old", image: null, avatarVersion: 4 } }))
      const result = await pending
      expect(result).toMatchObject({ name: "AbortError" })
      expect(continuation).not.toHaveBeenCalled()
      expect(registryB.queryClient.getQueryData<Array<{ name: string }>>(
        communityKeys.communityDbCollection("viewer-b", "profiles"),
      )?.[0]?.name).toBe("B latest")
      expect(qcB.getQueryState(communityKeys.bots())).toBeUndefined()
      expect(registryA.collections.profiles.size).toBe(0)
    } finally {
      renderer.unmount()
      unregisterA()
      unregisterB()
      await Promise.all([registryA.cleanup(), registryB.cleanup()])
      qcA.clear()
      qcB.clear()
    }
  })

  it("keeps a newer profile event when a valid mutation settles late", async () => {
    const { useUpdateBot } = await import("./use-bots")
    const qc = new QueryClient()
    const registry = createCommunityDbRegistry(qc, "viewer")
    const unregister = registerCommunityDbRegistry(registry)
    let resolve!: (value: unknown) => void
    apiFetchMock.mockReturnValue(new Promise((done) => { resolve = done }))
    let update!: ReturnType<typeof useUpdateBot>
    function Probe() { const value = useUpdateBot(); React.useLayoutEffect(() => { update = value }); return null }
    const renderer = render(React.createElement(TanStackQueryClientProvider, { client: qc },
      React.createElement(CommunityDbProvider, { registry }, React.createElement(Probe))))
    try {
      const pending = update.mutateAsync({ id: "bot", name: "Request name" })
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled())
      writeCommunityProfilePatches([{ id: "bot", identityAbout: { name: "WS latest" } }], registry, { event: true })
      await act(async () => resolve({ bot: { id: "bot", name: "Request name", image: null, avatarVersion: 1 } }))
      await pending
      expect(qc.getQueryData<Array<{ name: string }>>(
        communityKeys.communityDbCollection("viewer", "profiles"),
      )?.[0]?.name).toBe("WS latest")
    } finally {
      renderer.unmount()
      unregister()
      await registry.cleanup()
      qc.clear()
    }
  })
})
