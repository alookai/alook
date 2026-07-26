import { describe, it, expect, vi, beforeEach } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import type { BotSummary } from "@/hooks/community/use-bots"

// BotList pulls in many hooks + portal-heavy children. Mock them to passthroughs
// so we can render just the card meta row and assert the model segment. What we
// assert is the presence/absence of `data-testid="bot-card-model"` and its text.

const useBotsMock = vi.fn()

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
}))
vi.mock("@/hooks/community/mutations", () => ({
  useCreateOrGetDm: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock("@/stores/community/ws", () => ({
  useOnlineUserIds: () => new Set<string>(),
}))

function passthrough(name: string) {
  return function P({ children }: { children?: React.ReactNode }) {
    return React.createElement("div", { "data-mock": name }, children)
  }
}
vi.mock("./create-bot-sheet", () => ({ CreateBotSheet: passthrough("create-sheet") }))
vi.mock("./edit-bot-sheet", () => ({ EditBotSheet: passthrough("edit-sheet") }))
vi.mock("./bot-activity-modal", () => ({ BotActivityModal: passthrough("activity-modal") }))
vi.mock("@/components/avatar", () => ({ AgentAvatar: () => React.createElement("span", {}) }))
vi.mock("@/components/provider-logo", () => ({ ProviderLogo: () => React.createElement("span", {}) }))
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: passthrough("dm"),
  DropdownMenuContent: passthrough("dmc"),
  DropdownMenuItem: passthrough("dmi"),
  DropdownMenuTrigger: passthrough("dmt"),
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
    .findAll((n) => n.props?.["data-testid"] === "bot-card-model")
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
})
