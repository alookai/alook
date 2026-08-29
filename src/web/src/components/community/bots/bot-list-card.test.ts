import { describe, it, expect, vi, beforeEach } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import type { BotSummary } from "@/hooks/community/use-bots"
import { tid } from "@/lib/community/testids"

// BotList pulls in many hooks + portal-heavy children. Mock them to passthroughs
// so we can render just the card meta row and assert the model segment. What we
// assert is the presence/absence of the canonical model test ID and its text.

const useBotsMock = vi.fn()
const bugReportDialogMock = vi.fn()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("@/hooks/community/use-machines", () => ({
  useMachines: () => ({ machines: [{ id: "mac1", displayName: "Mac", hostname: "mac", status: "online" }] }),
}))
vi.mock("@/hooks/community/use-bots", () => ({
  useBots: () => useBotsMock(),
  useDeleteBot: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useResetBotSession: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useResetMachineAgents: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock("@/hooks/community/mutations", () => ({
  useCreateOrGetDm: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock("@/stores/community/ws", () => ({
  useProfilesByUserId: () => new Map(),
}))

function passthrough(name: string) {
  return function P({ children }: { children?: React.ReactNode }) {
    return React.createElement("div", { "data-mock": name }, children)
  }
}
vi.mock("./create-bot-sheet", () => ({ CreateBotSheet: passthrough("create-sheet") }))
vi.mock("./edit-bot-sheet", () => ({ EditBotSheet: passthrough("edit-sheet") }))
vi.mock("./bot-activity-modal", () => ({ BotActivityModal: passthrough("activity-modal") }))
vi.mock("./bug-report-dialog", () => ({
  BugReportDialog: (props: { bot: Pick<BotSummary, "id" | "name"> }) => {
    bugReportDialogMock(props)
    return React.createElement("div", { "data-mock": "bug-report-dialog" })
  },
}))
vi.mock("@/components/avatar", () => ({ AgentAvatar: () => React.createElement("span", {}) }))
vi.mock("@/components/provider-logo", () => ({ ProviderLogo: () => React.createElement("span", {}) }))
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: passthrough("dm"),
  DropdownMenuContent: passthrough("dmc"),
  DropdownMenuItem: passthrough("dmi"),
  DropdownMenuTrigger: passthrough("dmt"),
}))
// The heatmap's real Tooltip needs `window` (floating-ui) — mock to passthroughs
// so the node renderer can mount the card. The model-segment assertions don't
// touch the heatmap.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: passthrough("tt"),
  TooltipTrigger: ({ render }: { render: React.ReactElement }) => render,
  TooltipContent: passthrough("ttc"),
}))
vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: passthrough("ad"),
  AlertDialogAction: passthrough("ada"),
  AlertDialogCancel: passthrough("adc"),
  AlertDialogContent: passthrough("adco"),
  AlertDialogDescription: passthrough("add"),
  AlertDialogFooter: passthrough("adf"),
  AlertDialogHeader: passthrough("adh"),
  AlertDialogTitle: passthrough("adt"),
}))

import { BotList } from "./bot-list"

function bot(over: Partial<BotSummary>): BotSummary {
  return {
    id: "b1",
    name: "Blake",
    description: "",
    image: null,
    machineId: "mac1",
    runtime: "claude",
    modelName: null,
    lastRefreshContextAt: null,
    dailyActivity: [],
    ...over,
  }
}

function render(): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(React.createElement(BotList, {}))
  })
  return renderer
}

function modelSegments(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll((n) => n.props?.["data-testid"] === tid.botCardModel)
    .map((n) => {
      const c = n.props.children
      return typeof c === "string" ? c : Array.isArray(c) ? c.join("") : String(c)
    })
}

describe("BotList — card model segment", () => {
  beforeEach(() => {
    useBotsMock.mockReset()
  })

  it("renders `opus-4-6` after the runtime when a model is set", () => {
    useBotsMock.mockReturnValue({ bots: [bot({ modelName: "claude-opus-4-6" })], isLoading: false })
    const renderer = render()
    expect(modelSegments(renderer)).toEqual(["opus-4-6"])
  })

  it("shows a `local default` hint when modelName is null", () => {
    useBotsMock.mockReturnValue({ bots: [bot({ modelName: null })], isLoading: false })
    const renderer = render()
    expect(modelSegments(renderer)).toEqual(["local default"])
  })

  it("folds and reopens a machine category from its header", () => {
    useBotsMock.mockReturnValue({ bots: [bot({ modelName: null })], isLoading: false })
    const renderer = render()
    const collapse = renderer.root.findByProps({ "aria-label": "Collapse Mac" })

    act(() => collapse.props.onClick())
    expect(renderer.root.findAll((node) => node.props.hidden === true)).toHaveLength(1)
    const expand = renderer.root.findByProps({ "aria-label": "Expand Mac" })
    expect(expand.props["aria-expanded"]).toBe(false)

    act(() => expand.props.onClick())
    expect(renderer.root.findAll((node) => node.props.hidden === true)).toHaveLength(0)
    expect(modelSegments(renderer)).toEqual(["local default"])
  })
})

describe("BotList — bug-report feature entry", () => {
  beforeEach(() => {
    useBotsMock.mockReset()
    bugReportDialogMock.mockReset()
  })

  it("always renders exactly one Report a problem action per bot", () => {
    const bots = [bot({ id: "b1" }), bot({ id: "b2", name: "Maya" })]
    useBotsMock.mockReturnValue({
      bots,
      isLoading: false,
      data: { bots },
    })

    const renderer = render()
    const reportItems = renderer.root.findAll(
      (node) => node.props?.["data-testid"] === "bot-report-problem-item",
    )
    expect(reportItems).toHaveLength(2)
    expect(renderer.root
      .findAll((node) => ["bot-reset-session-item", "bot-report-problem-item"]
        .includes(node.props?.["data-testid"]))
      .map((node) => node.props["data-testid"]))
      .toEqual([
        "bot-reset-session-item",
        "bot-report-problem-item",
        "bot-reset-session-item",
        "bot-report-problem-item",
      ])
    expect(reportItems.map((item) => item.props.children).join(" ")).toContain("Report a problem")
    expect(bugReportDialogMock).not.toHaveBeenCalled()

    act(() => reportItems[1]!.props.onClick())
    expect(bugReportDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({ bot: { id: "b2", name: "Maya" } }),
    )
  })
})
