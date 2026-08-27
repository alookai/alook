import { createElement, type ReactNode } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ServerRail } from "./server-rail"

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  announce: vi.fn(),
}))

vi.mock("@atlaskit/pragmatic-drag-and-drop-live-region", () => ({
  announce: mocks.announce,
  cleanup: vi.fn(),
}))
vi.mock("@/hooks/community/mutations", () => ({
  useServerRailCommit: () => ({ mutate: mocks.mutate, isPending: false }),
}))
vi.mock("./use-server-rail-pdd", () => ({
  useServerRailPdd: () => ({ registerItem: vi.fn() }),
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

function renderRail() {
  return TestRenderer.create(createElement(ServerRail, {
    servers,
    folders,
    view: "server",
    onHome: vi.fn(),
  }))
}

describe("ServerRail one-in-flight structural guard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("sessionStorage", { getItem: vi.fn(() => null), setItem: vi.fn() })
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
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
})
