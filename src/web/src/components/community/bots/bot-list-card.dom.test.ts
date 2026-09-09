import { describe, it, expect, vi, beforeEach } from "vitest"
import React from "react"
import { fireEvent, render as rtlRender } from "@/test/react-dom-harness"
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
  useSetBotActive: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
  return function P({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) {
    return React.createElement("div", { "data-mock": name, ...props }, children)
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
// so the DOM harness can mount the card. The model-segment assertions don't
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
    isActive: true,
    lastRefreshContextAt: null,
    dailyActivity: [],
    ...over,
  }
}

function render() {
  return rtlRender(React.createElement(BotList, {}))
}

function modelSegments(renderer: ReturnType<typeof rtlRender>): string[] {
  return [...renderer.container.querySelectorAll(`[data-testid="${tid.botCardModel}"]`)]
    .map((node) => node.textContent ?? "")
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
    const collapse = renderer.getByRole("button", { name: "Collapse Mac" })

    fireEvent.click(collapse)
    expect(renderer.container.querySelectorAll("[hidden]")).toHaveLength(1)
    const expand = renderer.getByRole("button", { name: "Expand Mac" })
    expect(expand).toHaveAttribute("aria-expanded", "false")

    fireEvent.click(expand)
    expect(renderer.container.querySelectorAll("[hidden]")).toHaveLength(0)
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
      data: { bots, plan: { id: "free", displayName: "Free" }, limit: 3, ownedCount: 2, activeCount: 2 },
    })

    const renderer = render()
    const reportItems = [...renderer.container.querySelectorAll(
      '[data-testid="bot-report-problem-item"]',
    )]
    expect(reportItems).toHaveLength(2)
    expect([...renderer.container.querySelectorAll(
      '[data-testid="bot-reset-session-item"], [data-testid="bot-report-problem-item"]',
    )].map((node) => node.getAttribute("data-testid")))
      .toEqual([
        "bot-reset-session-item",
        "bot-report-problem-item",
        "bot-reset-session-item",
        "bot-report-problem-item",
      ])
    expect(reportItems.map((item) => item.textContent).join(" ")).toContain("Report a problem")
    expect(bugReportDialogMock).not.toHaveBeenCalled()

    fireEvent.click(reportItems[1]!)
    expect(bugReportDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({ bot: { id: "b2", name: "Maya" } }),
    )
  })
})
