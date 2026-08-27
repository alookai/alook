import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useShellRailController } from "./use-shell-rail-controller"

const mocks = vi.hoisted(() => ({
  servers: [{ id: "s1", name: "One" }, { id: "s2", name: "Two" }],
  folders: [] as Array<{ id: string; name: string; position: number; servers: Array<{ id: string }> }>,
  createServer: vi.fn(),
  leaveServer: vi.fn(),
  uploadIcon: vi.fn(),
  markVoluntaryLeave: vi.fn(),
  markSwitch: vi.fn(),
  toast: vi.fn(),
  toastApiError: vi.fn(),
  lastMeLeaf: { current: null as string | null },
}))

vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("@/lib/api/client", () => ({ toastApiError: mocks.toastApiError }))
vi.mock("@/lib/perf/switch-mark", () => ({ markSwitch: mocks.markSwitch }))
vi.mock("@/lib/community/eject-server", () => ({
  markVoluntaryLeave: mocks.markVoluntaryLeave,
  pickPostEjectDestination: () => "/c/me",
}))
vi.mock("@/hooks/community/use-servers", () => ({
  useServers: () => ({
    servers: mocks.servers,
    isLoading: false,
  }),
  serverQueryFn: (id: string) => () => Promise.resolve({ id }),
}))
vi.mock("@/hooks/community/use-folders", () => ({ useFolders: () => ({ folders: mocks.folders }) }))
vi.mock("@/hooks/community/mutations", () => ({
  useCreateServer: () => ({ mutateAsync: mocks.createServer }),
  useLeaveServer: () => ({ mutate: mocks.leaveServer }),
  useUploadServerIcon: () => ({ mutate: mocks.uploadIcon }),
}))
vi.mock("@/stores/community", () => ({
  useCommunityStore: (selector: (state: { currentServerId: string }) => unknown) =>
    selector({ currentServerId: "s1" }),
}))
vi.mock("@/lib/community/last-channel", () => ({
  getLastChannel: () => null,
  pickServerLandingHref: (id: string, channelIds: string[]) =>
    channelIds[0] ? `/c/channels/${id}/${channelIds[0]}` : `/c/channels/${id}`,
}))
vi.mock("@/lib/community/last-me-location", () => ({
  ME_ROOT: "/c/me",
  getLastMeLeaf: () => mocks.lastMeLeaf.current,
  pickMeLandingLocation: (leaf: string | null) => `/c/me/${leaf ?? "friends"}`,
}))

type Result = ReturnType<typeof useShellRailController>

function Capture({ options, onResult }: {
  options: Parameters<typeof useShellRailController>[0]
  onResult: (result: Result) => void
}) {
  onResult(useShellRailController(options))
  return null
}

async function renderController(overrides: Record<string, unknown> = {}) {
  const pushed: string[] = []
  const replaced: string[] = []
  const prefetched: string[] = []
  const router = {
    push: (href: string) => { pushed.push(href) },
    replace: (href: string) => { replaced.push(href) },
    prefetch: (href: string) => { prefetched.push(href) },
  }
  const navigation = {
    currentHref: "/c/channels/s1",
    navigationPending: false,
    pendingHref: null,
    push: router.push,
    replace: router.replace,
    prefetch: router.prefetch,
    resolveAndPush: vi.fn(),
    cancelPendingNavigation: vi.fn(),
  }
  const cache = new Map<string, unknown>()
  const queryClient = {
    getQueryData: vi.fn((key: unknown[]) => cache.get(String(key.at(-1)))),
    fetchQuery: vi.fn(),
  }
  const options = {
    navigation,
    queryClient,
    breakpoint: "desktop",
    view: "server",
    activeServerId: "s1",
    ...overrides,
  } as never
  let current!: Result
  let renderer!: TestRenderer.ReactTestRenderer
  const onResult = (result: Result) => { current = result }
  await act(async () => {
    renderer = TestRenderer.create(createElement(Capture, {
      options,
      onResult,
    }))
  })
  return {
    get current() { return current },
    renderer,
    options,
    router,
    navigation,
    queryClient,
    cache,
    pushed,
    replaced,
    prefetched,
    async rerender() {
      await act(async () => {
        renderer.update(createElement(Capture, { options, onResult }))
      })
    },
  }
}

describe("useShellRailController", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock === "function" && "mockReset" in mock) mock.mockReset()
    }
    mocks.folders.length = 0
    mocks.lastMeLeaf.current = null
  })

  it("commits cold server navigation synchronously without waiting for detail", async () => {
    const hook = await renderController()
    await act(async () => {
      hook.current.railProps.onServerNavigate("s1")
      hook.current.railProps.onServerNavigate("s2")
    })

    expect(hook.pushed).toEqual(["/c/channels/s1", "/c/channels/s2"])
    expect(hook.queryClient.fetchQuery).not.toHaveBeenCalled()
    expect(mocks.markSwitch).toHaveBeenNthCalledWith(1, "server", "s1")
    expect(mocks.markSwitch).toHaveBeenNthCalledWith(2, "server", "s2")

  })

  it("projects the pending target for every rail entry without changing committed actions", async () => {
    const openSettings = vi.fn()
    const hook = await renderController({
      projectedActiveServerId: "s2",
      onOpenActiveServerSettings: openSettings,
    })

    expect(hook.current.railProps.activeServerId).toBe("s2")
    expect(hook.current.railProps.servers.map((server) => [server.id, server.active]))
      .toEqual([["s1", false], ["s2", true]])

    await act(async () => hook.current.railProps.onOpenSettings("s2"))
    expect(openSettings).not.toHaveBeenCalled()
    expect(hook.pushed).toEqual(["/c/channels/s2?settings=1"])
  })

  it("does not leave deferred server work that can overwrite a direct channel navigation", async () => {
    const hook = await renderController()
    await act(async () => {
      hook.current.railProps.onServerNavigate("s2")
      hook.current.navigate("s1", "c1")
    })
    expect(hook.pushed).toEqual(["/c/channels/s2", "/c/channels/s1/c1"])
    expect(hook.queryClient.fetchQuery).not.toHaveBeenCalled()
    expect(mocks.markSwitch).toHaveBeenLastCalledWith("channel", "c1")
  })

  it("keeps settings and invite actions synchronous and scoped to their target", async () => {
    const openSettings = vi.fn()
    const openInvite = vi.fn()
    const hook = await renderController({
      onOpenActiveServerSettings: openSettings,
      onOpenActiveServerInvite: openInvite,
    })
    await act(async () => {
      hook.current.railProps.onOpenSettings("s1")
    })
    expect(openSettings).toHaveBeenCalledTimes(1)
    expect(hook.pushed).toEqual([])
    await act(async () => {
      hook.current.railProps.onOpenInvitePopover("s1")
    })
    expect(openInvite).toHaveBeenCalledTimes(1)
    expect(hook.pushed).toEqual([])
    await act(async () => hook.current.railProps.onOpenSettings("s2"))
    await act(async () => hook.current.railProps.onOpenInvitePopover("s2"))
    expect(hook.pushed).toEqual([
      "/c/channels/s2?settings=1",
      "/c/channels/s2?invite=1",
    ])

    hook.pushed.length = 0
    await act(async () => {
      hook.current.railProps.onOpenSettings(undefined)
      hook.current.railProps.onOpenInvitePopover(undefined)
    })
    expect(hook.pushed).toEqual([])
  })

  it("commits Home immediately after a cold server intent", async () => {
    const hook = await renderController()

    await act(async () => {
      hook.current.railProps.onServerNavigate("s2")
      hook.current.railProps.onHome()
    })
    expect(hook.pushed).toEqual(["/c/channels/s2", "/c/me/friends"])
    expect(hook.queryClient.fetchQuery).not.toHaveBeenCalled()
  })

  it("always sends rail selection to the semantic server root", async () => {
    const hook = await renderController()
    hook.cache.set("s1", {
      categories: [{ channels: [{ id: "cached", pending: false }] }],
    })

    await act(async () => hook.current.railProps.onServerNavigate("s1"))
    expect(hook.pushed).toEqual(["/c/channels/s1"])
  })

  it("uses cached and fetched destinations for navigation and prefetch fallbacks", async () => {
    const hook = await renderController()
    hook.cache.set("s1", {
      categories: [{ channels: [{ id: "pending", pending: true }, { id: "cached", pending: false }] }],
    })

    await act(async () => hook.current.railProps.onServerNavigate("s1"))
    await act(async () => hook.current.railProps.onServerPrefetch("s1"))
    await act(async () => hook.current.railProps.onHomePrefetch())
    expect(hook.pushed).toEqual(["/c/channels/s1"])
    expect(hook.prefetched).toEqual(["/c/channels/s1/cached", "/c/me/friends"])
    expect(hook.queryClient.fetchQuery).not.toHaveBeenCalled()

    hook.queryClient.fetchQuery.mockImplementationOnce(async ({ queryKey }: { queryKey: unknown[] }) => {
      const id = String(queryKey.at(-1))
      hook.cache.set(id, { categories: [{ channels: [{ id: "fetched", pending: false }] }] })
    })
    await act(async () => hook.current.railProps.onServerNavigate("s2"))
    expect(hook.pushed).toContain("/c/channels/s2")
    expect(hook.queryClient.fetchQuery).not.toHaveBeenCalled()
    await act(async () => hook.current.railProps.onServerPrefetch("s2"))
    expect(hook.prefetched).toContain("/c/channels/s2/fetched")
    expect(hook.queryClient.fetchQuery).toHaveBeenLastCalledWith(expect.objectContaining({
      queryKey: expect.any(Array),
      queryFn: expect.any(Function),
      staleTime: Infinity,
    }))

    hook.queryClient.fetchQuery.mockRejectedValueOnce(new Error("offline"))
    await act(async () => hook.current.railProps.onServerPrefetch("s3"))
    expect(hook.prefetched).toContain("/c/channels/s3")
  })

  it("uses one breakpoint-canonical Home destination for click and prefetch", async () => {
    mocks.lastMeLeaf.current = "dm-last"
    const desktop = await renderController({ breakpoint: "desktop" })
    await act(async () => {
      desktop.current.railProps.onHomePrefetch()
      desktop.current.railProps.onHome()
    })
    expect(desktop.prefetched).toEqual(["/c/me/dm-last"])
    expect(desktop.pushed).toEqual(["/c/me/dm-last"])

    for (const breakpoint of ["mobile", "unknown"] as const) {
      const safeRoot = await renderController({ breakpoint })
      await act(async () => {
        safeRoot.current.railProps.onHomePrefetch()
        safeRoot.current.railProps.onHome()
      })
      expect(safeRoot.prefetched).toEqual(["/c/me"])
      expect(safeRoot.pushed).toEqual(["/c/me"])
    }
  })

  it("keeps callback fields stable without stabilizing the railProps aggregate", async () => {
    const hook = await renderController()
    const firstProps = hook.current.railProps
    const callbacks = {
      onHome: firstProps.onHome,
      onServerNavigate: firstProps.onServerNavigate,
      onCreateServer: firstProps.onCreateServer,
      onLeaveServer: firstProps.onLeaveServer,
    }
    await hook.rerender()
    expect(hook.current.railProps).not.toBe(firstProps)
    expect(hook.current.railProps.onHome).toBe(callbacks.onHome)
    expect(hook.current.railProps.onServerNavigate).toBe(callbacks.onServerNavigate)
    expect(hook.current.railProps.onCreateServer).toBe(callbacks.onCreateServer)
    expect(hook.current.railProps.onLeaveServer).toBe(callbacks.onLeaveServer)
  })

  it("preserves create and leave side-effect ordering", async () => {
    const order: string[] = []
    mocks.createServer.mockImplementation(async () => {
      order.push("create")
      return { server: { id: "new" } }
    })
    mocks.toast.mockImplementation(() => { order.push("toast") })
    const hook = await renderController()
    hook.navigation.push = (href: string) => { order.push(`push:${href}`) }
    await act(async () => hook.current.railProps.onCreateServer("New"))
    expect(order).toEqual(["create", "toast", "push:/c/channels/new"])

    order.length = 0
    mocks.markVoluntaryLeave.mockImplementation(() => { order.push("mark") })
    mocks.leaveServer.mockImplementation((_input, options) => {
      order.push("mutate")
      options.onSuccess()
    })
    hook.navigation.replace = (href: string) => { order.push(`replace:${href}`) }
    await act(async () => hook.current.railProps.onLeaveServer("s1"))
    expect(order).toEqual(["mark", "mutate", "toast", "replace:/c/me"])
  })

  it("preserves optional icon upload and create/leave error reporting", async () => {
    const file = new File(["icon"], "icon.png", { type: "image/png" })
    const order: string[] = []
    mocks.createServer.mockImplementation(async () => {
      order.push("create")
      return { server: { id: "new" } }
    })
    mocks.toast.mockImplementation(() => { order.push("toast") })
    mocks.uploadIcon.mockImplementation(() => { order.push("upload") })
    const hook = await renderController()
    hook.navigation.push = (href: string) => { order.push(`push:${href}`) }

    await act(async () => hook.current.railProps.onCreateServer("New", file))
    expect(order).toEqual(["create", "toast", "upload", "push:/c/channels/new"])
    expect(mocks.uploadIcon).toHaveBeenCalledWith(
      { serverId: "new", file },
      expect.objectContaining({ onError: expect.any(Function) }),
    )
    const iconError = new Error("icon")
    mocks.uploadIcon.mock.calls[0]![1].onError(iconError)
    expect(mocks.toastApiError).toHaveBeenCalledWith(
      iconError,
      "Server created, but the icon failed to upload",
    )

    const createError = new Error("create")
    mocks.createServer.mockRejectedValueOnce(createError)
    await act(async () => hook.current.railProps.onCreateServer("Broken"))
    expect(mocks.toastApiError).toHaveBeenCalledWith(createError, "Failed to create server")

    await act(async () => hook.current.railProps.onLeaveServer("s2"))
    const leaveError = new Error("leave")
    mocks.leaveServer.mock.calls.at(-1)![1].onError(leaveError)
    expect(mocks.toastApiError).toHaveBeenCalledWith(leaveError, "Failed to leave server")
  })

  it("passes complete memberships to the normalized rail and no legacy mutation callbacks", async () => {
    mocks.folders.push({
      id: "f1",
      name: "Group",
      position: 0,
      servers: [{ id: "s2" }],
    })
    const hook = await renderController()
    expect(hook.current.railProps.servers.map((server) => server.id)).toEqual(["s1", "s2"])
    expect(hook.current.railProps.folders).toEqual(mocks.folders)
    expect(hook.current.railProps).not.toHaveProperty("onReorderRail")
    expect(hook.current.railProps).not.toHaveProperty("onFolderItemsChange")
  })
})
