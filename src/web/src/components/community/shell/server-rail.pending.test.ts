import { createElement, type ReactNode } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ServerRail } from "./server-rail"
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
vi.mock("./server-rail-move-menu", () => ({ ServerRailMoveMenu: () => null }))
vi.mock("../settings/create-server-dialog", () => ({ CreateServerDialog: () => null }))
vi.mock("@/components/ui/skeleton", () => ({ Skeleton: () => null }))
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
  { id: "a", name: "A", initial: "A", active: true, mentions: 0 },
  { id: "b", name: "B", initial: "B", active: false, mentions: 0 },
]
const folders = [{
  id: "one",
  name: "One",
  position: 0,
  servers: [{ id: "b", name: "B", initial: "B" }],
}]
const animationFrames: FrameRequestCallback[] = []

function renderRail() {
  return TestRenderer.create(createElement(ServerRail, {
    servers,
    folders,
    view: "server",
    onHome: vi.fn(),
  }))
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

  it.each(["create-first", "ungroup-first"] as const)(
    "allows one PATCH when stale create and ungroup callbacks race: %s",
    async (order) => {
      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => { renderer = renderRail() })
      const create = renderer.root.findAllByType("sortable-server")[0]!.props.onCreateFolder
      const ungroup = renderer.root.findByType("rail-folder").props.onUngroup

      await act(async () => {
        if (order === "create-first") {
          create()
          ungroup()
        } else {
          ungroup()
          create()
        }
      })

      expect(mocks.mutate).toHaveBeenCalledTimes(1)
      expect(mocks.announce).toHaveBeenCalledWith("A server rail move is already being saved")

      const options = mocks.mutate.mock.calls[0]![1]
      await act(async () => { options.onSettled() })
      await act(async () => {
        if (order === "create-first") ungroup()
        else create()
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
    "returns Move focus only after the mutation settles: %s",
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
    "returns Create group focus to its source server after settle: %s",
    async (outcome) => {
      const focus = vi.fn()
      mocks.querySelector.mockReturnValue({ focus })
      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => { renderer = renderRail() })
      const create = renderer.root.findAllByType("sortable-server")
        .find((node) => node.props.server.id === "a")!.props.onCreateFolder
      await act(async () => create())
      const { args, callbacks } = latestMutation()

      await act(async () => {
        if (outcome === "success") {
          const clientId = args.commands[0]?.clientId
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
