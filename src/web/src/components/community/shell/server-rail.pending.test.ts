import { createElement, type ReactNode } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ServerRail, ServerRailPending, ServerRailSkeleton } from "./server-rail"
import { tid } from "@/lib/community/testids"
import type { RailInstruction } from "@/lib/community/server-rail-model"

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  announce: vi.fn(),
  capturePddOptions: vi.fn(),
  querySelector: vi.fn(),
}))

vi.mock("@atlaskit/pragmatic-drag-and-drop-live-region", () => ({
  announce: mocks.announce,
  cleanup: vi.fn(),
}))
vi.mock("@/hooks/community/mutations", () => ({
  useServerRailCommit: () => ({ mutate: mocks.mutate, isPending: false }),
}))
vi.mock("./use-server-rail-pdd", () => ({
  useServerRailPdd: (options: unknown) => {
    mocks.capturePddOptions(options)
    return { registerItem: vi.fn() }
  },
}))
vi.mock("./sortable-server", () => ({
  SortableServer: (props: Record<string, unknown>) => createElement("sortable-server", props),
}))
vi.mock("./rail-folder", () => ({
  RailFolder: (props: Record<string, unknown>) => createElement("rail-folder", props),
}))
vi.mock("./rail-icon", () => ({ RailIcon: () => null }))
vi.mock("./animated-alook-logo", () => ({ AnimatedAlookLogo: () => null }))
vi.mock("../settings/create-server-dialog", () => ({ CreateServerDialog: () => null }))
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: (props: Record<string, unknown>) => createElement("skeleton", props),
}))
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("@/lib/community-onboarding", () => ({
  completeCommunityOnboarding: vi.fn(),
  isCommunityOnboardingStage: () => false,
}))

const servers = [
  { id: "a", name: "A", initial: "A", active: true, unread: false, mentions: 0 },
  { id: "b", name: "B", initial: "B", active: false, unread: false, mentions: 0 },
  { id: "c", name: "C", initial: "C", active: false, unread: false, mentions: 0 },
]
const folders = [{
  id: "one",
  name: "One",
  position: 0,
  servers: [{ id: "b", name: "B", initial: "B" }],
}]
const animationFrames: FrameRequestCallback[] = []

function railElement(currentFolders = folders) {
  return createElement(ServerRail, {
    servers,
    folders: currentFolders,
    view: "server",
    onHome: vi.fn(),
  })
}

function renderRail() {
  return TestRenderer.create(railElement())
}

type MutationCallbacks = {
  onSuccess: (response: { createdFolderIds: Record<string, string> }) => void
  onError: () => void
  onSettled: (data?: unknown, error?: Error | null) => void
}

function latestMutation() {
  const call = mocks.mutate.mock.calls.at(-1)!
  return {
    args: call[0] as { commands: Array<{ kind: string; clientId?: string }> },
    callbacks: call[1] as MutationCallbacks,
  }
}

function drop(instruction: RailInstruction) {
  const options = mocks.capturePddOptions.mock.calls.at(-1)![0] as {
    onDrop: (instruction: RailInstruction) => void
  }
  options.onDrop(instruction)
}

function flushAnimationFrame() {
  const callback = animationFrames.shift()
  if (!callback) throw new Error("Expected a queued animation frame")
  callback(0)
}

async function expectReconciledFocus(testId: string, focus: ReturnType<typeof vi.fn>) {
  expect(mocks.querySelector).not.toHaveBeenCalled()
  expect(focus).not.toHaveBeenCalled()
  await act(async () => flushAnimationFrame())
  expect(mocks.querySelector).not.toHaveBeenCalled()
  expect(focus).not.toHaveBeenCalled()
  await act(async () => flushAnimationFrame())
  expect(mocks.querySelector).toHaveBeenLastCalledWith(`[data-testid="${testId}"]`)
  expect(focus).toHaveBeenCalledTimes(1)
}

describe("ServerRail one-in-flight structural guard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    animationFrames.length = 0
    vi.stubGlobal("sessionStorage", { getItem: vi.fn(() => null), setItem: vi.fn() })
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    vi.stubGlobal("document", { querySelector: mocks.querySelector })
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrames.push(callback)
      return animationFrames.length
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it("exports an inert data-free rail placeholder", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ServerRailSkeleton))
    })
    expect(renderer.root.findByProps({ "data-testid": tid.initialRailPending }))
      .toBeDefined()
    expect(renderer.root.findAllByType("skeleton")).toHaveLength(1)
    expect(renderer.root.findAllByType("button")).toHaveLength(0)
  })

  it("uses the canonical rail frame for pending home, list, and add geometry", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ServerRailPending, { bottomInset: 60 }))
    })
    const nav = renderer.root.findByType("nav")
    expect(nav.props.className).toBe(
      "flex min-h-0 w-14 shrink-0 flex-col items-center overflow-hidden pt-2",
    )
    expect(nav.props["aria-hidden"]).toBe(true)
    expect(renderer.root.findAllByType("skeleton")).toHaveLength(2)
    expect(renderer.root.findAllByType("button")).toHaveLength(0)
    const home = renderer.root.findByProps({ "data-slot": "community-home-logo-pending" })
    expect(home.props.className).toContain("size-10")
    expect(home.props.className).toContain("rounded-[9px]")
    expect(home.props.className).not.toContain("rounded-[20px]")
    expect(renderer.root.findByProps({ "data-slot": "community-server-rail-viewport" }).props.className)
      .toContain("min-h-0 w-full flex-1")
    expect(renderer.root.findByProps({ "data-testid": tid.serverRailScroll }).props.className)
      .toContain("shrink overflow-y-auto")
    expect(renderer.root.findAllByProps({ "data-slot": "community-server-rail-add" }))
      .toHaveLength(0)
  })

  it.each([
    ["empty", 0],
    ["one", 1],
    ["multiple", 6],
    ["overflow", 48],
  ] as const)("keeps one count-independent viewport around a %s server list", async (_label, count) => {
    const cardinalityServers = Array.from({ length: count }, (_, index) => ({
      id: `server-${index}`,
      name: `Server ${index}`,
      initial: "S",
      active: index === 0,
      unread: false,
      mentions: 0,
    }))
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ServerRail, {
        servers: cardinalityServers,
        folders: [],
        view: "server",
        onHome: vi.fn(),
      }))
    })

    expect(renderer.root.findAllByProps({ "data-slot": "community-server-rail-viewport" }))
      .toHaveLength(1)
    expect(renderer.root.findByProps({ "data-slot": "community-server-rail-viewport" }).props.className)
      .toBe("flex min-h-0 w-full flex-1 flex-col items-center")
    expect(renderer.root.findAllByType("sortable-server")).toHaveLength(count)
    expect(renderer.root.findByProps({ "data-testid": tid.serverRailScroll }).props.className)
      .toContain("min-h-0 w-full shrink overflow-y-auto")
    expect(renderer.root.findAllByProps({ "data-slot": "community-server-rail-add" }))
      .toHaveLength(1)
  })

  it("omits Add for unresolved empty data and keeps it for nonempty revalidation", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ServerRail, {
        servers: [],
        folders: [],
        serversLoading: true,
        view: "dm",
        onHome: vi.fn(),
      }))
    })
    expect(renderer.root.findAllByProps({ "data-slot": "community-server-rail-add" }))
      .toHaveLength(0)

    await act(async () => {
      renderer.update(createElement(ServerRail, {
        servers: [servers[0]],
        folders: [],
        serversLoading: true,
        view: "dm",
        onHome: vi.fn(),
      }))
    })
    expect(renderer.root.findAllByProps({ "data-slot": "community-server-rail-add" }))
      .toHaveLength(1)
  })

  it("aggregates unread only while collapsed and preserves it on the expanded child", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    const unreadServers = servers.map((server) => ({
      ...server,
      unread: server.id === "b",
    }))
    await act(async () => {
      renderer = TestRenderer.create(createElement(ServerRail, {
        servers: unreadServers,
        folders,
        view: "server",
        onHome: vi.fn(),
      }))
    })

    expect(renderer.root.findByType("rail-folder").props).toMatchObject({
      open: false,
      active: false,
      unread: true,
    })

    await act(async () => renderer.root.findByType("rail-folder").props.onToggle())

    expect(renderer.root.findByType("rail-folder").props).toMatchObject({
      open: true,
      active: false,
      unread: false,
    })
    const child = renderer.root.findAllByType("sortable-server")
      .find((node) => node.props.server.id === "b")
    expect(child?.props.server.unread).toBe(true)
  })

  it.each(["drop-first", "ungroup-first"] as const)(
    "allows one PATCH when drag-drop and ungroup callbacks race: %s",
    async (order) => {
      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => { renderer = renderRail() })
      const ungroup = renderer.root.findByType("rail-folder").props.onUngroup
      const instruction = {
        operation: "reorder-after",
        source: { kind: "server", id: "a" },
        target: { kind: "server", id: "c" },
      } satisfies RailInstruction

      await act(async () => {
        if (order === "drop-first") {
          drop(instruction)
          ungroup()
        } else {
          ungroup()
          drop(instruction)
        }
      })

      expect(mocks.mutate).toHaveBeenCalledTimes(1)
      expect(mocks.announce).toHaveBeenCalledWith("A server rail move is already being saved")

      const options = mocks.mutate.mock.calls[0]![1]
      await act(async () => { options.onSettled() })
      await act(async () => {
        if (order === "drop-first") ungroup()
        else drop(instruction)
      })
      expect(mocks.mutate).toHaveBeenCalledTimes(2)
    },
  )

  it("keeps immediate rejected-operation focus on one animation frame", async () => {
    const focus = vi.fn()
    mocks.querySelector.mockReturnValue({ focus })
    await act(async () => { renderRail() })
    await act(async () => drop({
      operation: "reorder-after",
      source: { kind: "server", id: "a" },
      target: { kind: "server", id: "a" },
    }))

    expect(mocks.mutate).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    await act(async () => flushAnimationFrame())
    expect(mocks.querySelector).toHaveBeenLastCalledWith(
      `[data-testid="${tid.serverIcon("a")}"]`,
    )
    expect(focus).toHaveBeenCalledTimes(1)
    expect(animationFrames).toHaveLength(0)
  })

  it.each(["success", "error"] as const)(
    "returns drag source focus only after the mutation settles: %s",
    async (outcome) => {
      const focus = vi.fn()
      mocks.querySelector.mockReturnValue({ focus })
      await act(async () => { renderRail() })
      await act(async () => drop({
        operation: "reorder-after",
        source: { kind: "server", id: "a" },
        target: { kind: "server", id: "b" },
      }))
      const { callbacks } = latestMutation()

      await act(async () => {
        if (outcome === "success") callbacks.onSuccess({ createdFolderIds: {} })
        else callbacks.onError()
      })
      expect(focus).not.toHaveBeenCalled()

      await act(async () => callbacks.onSettled(
        undefined,
        outcome === "error" ? new Error("failed") : null,
      ))
      await expectReconciledFocus(tid.serverIcon("a"), focus)
    },
  )

  it.each(["success", "error"] as const)(
    "returns combine-created-group focus to its source server after settle: %s",
    async (outcome) => {
      const focus = vi.fn()
      mocks.querySelector.mockReturnValue({ focus })
      await act(async () => { renderRail() })
      await act(async () => drop({
        operation: "combine",
        source: { kind: "server", id: "a" },
        target: { kind: "server", id: "c" },
      }))
      const { args, callbacks } = latestMutation()

      await act(async () => {
        if (outcome === "success") {
          const clientId = args.commands.find((command) => command.kind === "create-folder")?.clientId
          callbacks.onSuccess({ createdFolderIds: clientId ? { [clientId]: "created" } : {} })
        } else {
          callbacks.onError()
        }
      })
      expect(focus).not.toHaveBeenCalled()

      await act(async () => callbacks.onSettled(
        undefined,
        outcome === "error" ? new Error("failed") : null,
      ))
      await expectReconciledFocus(tid.serverIcon("a"), focus)
    },
  )

  it("preserves a user collapse while a created group id is reconciling", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = renderRail() })
    await act(async () => drop({
      operation: "combine",
      source: { kind: "server", id: "a" },
      target: { kind: "server", id: "c" },
    }))
    const { args, callbacks } = latestMutation()
    const clientId = args.commands.find((command) => command.kind === "create-folder")?.clientId
    expect(clientId).toBeDefined()
    const optimisticFolder = renderer.root.findAllByType("rail-folder")
      .find((folder) => folder.props.folderId === clientId)
    expect(optimisticFolder?.props.open).toBe(true)

    await act(async () => optimisticFolder?.props.onToggle())
    expect(optimisticFolder?.props.open).toBe(false)
    await act(async () => renderer.update(railElement([
      ...folders,
      {
        id: "created",
        name: "Group",
        position: 1,
        servers: [
          { id: "a", name: "A", initial: "A" },
          { id: "c", name: "C", initial: "C" },
        ],
      },
    ])))
    await act(async () => callbacks.onSuccess({
      createdFolderIds: clientId ? { [clientId]: "created" } : {},
    }))

    const reconciledFolder = renderer.root.findAllByType("rail-folder")
      .find((folder) => folder.props.folderId === "created")
    expect(reconciledFolder?.props.open).toBe(false)
  })

  it("keeps a created group expanded when cache reconciliation replaces its id", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = renderRail() })
    await act(async () => drop({
      operation: "combine",
      source: { kind: "server", id: "a" },
      target: { kind: "server", id: "c" },
    }))
    const { args, callbacks } = latestMutation()
    const clientId = args.commands.find((command) => command.kind === "create-folder")?.clientId
    expect(clientId).toBeDefined()

    await act(async () => renderer.update(railElement([
      ...folders,
      {
        id: "created",
        name: "Group",
        position: 1,
        servers: [
          { id: "a", name: "A", initial: "A" },
          { id: "c", name: "C", initial: "C" },
        ],
      },
    ])))
    await act(async () => callbacks.onSuccess({
      createdFolderIds: clientId ? { [clientId]: "created" } : {},
    }))

    const reconciledFolder = renderer.root.findAllByType("rail-folder")
      .find((folder) => folder.props.folderId === "created")
    expect(reconciledFolder?.props.open).toBe(true)
  })

  it.each(["success", "error"] as const)(
    "returns Ungroup focus after settle to a surviving entity: %s",
    async (outcome) => {
      const focus = vi.fn()
      mocks.querySelector.mockReturnValue({ focus })
      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => { renderer = renderRail() })
      const ungroup = renderer.root.findByType("rail-folder").props.onUngroup
      await act(async () => ungroup())
      const { callbacks } = latestMutation()

      await act(async () => {
        if (outcome === "success") callbacks.onSuccess({ createdFolderIds: {} })
        else callbacks.onError()
      })
      expect(focus).not.toHaveBeenCalled()

      await act(async () => callbacks.onSettled(
        undefined,
        outcome === "error" ? new Error("failed") : null,
      ))
      await expectReconciledFocus(
        outcome === "success" ? tid.serverIcon("b") : tid.serverRailFolder("one"),
        focus,
      )
    },
  )
})
