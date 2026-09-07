import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BotListController } from "./bot-list-types"
import { fireEvent, render } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  group: vi.fn(),
  overlays: vi.fn(),
  createSheet: vi.fn(),
}))

vi.mock("./bot-list-machine-group", () => ({
  renderBotMachineGroup: (group: { machineId: string }, controller: BotListController) => {
    mocks.group(group, controller)
    return React.createElement("machine-group", { key: group.machineId, machineId: group.machineId })
  },
}))
vi.mock("./bot-list-overlays", () => ({
  renderBotListOverlaySlots: (controller: BotListController) => {
    mocks.overlays(controller)
    return {
      create: React.createElement("slot", { name: "create" }),
      help: React.createElement("slot", { name: "help" }),
      edit: React.createElement("slot", { name: "edit" }),
      activity: React.createElement("slot", { name: "activity" }),
      bug: React.createElement("slot", { name: "bug" }),
      deleteDialog: React.createElement("slot", { name: "delete" }),
      resetDialog: React.createElement("slot", { name: "reset" }),
      resetMachineDialog: React.createElement("slot", { name: "resetMachine" }),
    }
  },
}))
vi.mock("./create-bot-sheet", () => ({
  CreateBotSheet: (props: unknown) => {
    mocks.createSheet(props)
    return React.createElement("create-sheet", props as Record<string, unknown>)
  },
}))
vi.mock("@/components/community/onboarding-tiles/create-tile", () => ({
  CreateTile: () => React.createElement("create-tile"),
}))

import { BotListSkeleton, renderBotListView } from "./bot-list-view"

function controller(overrides: Partial<BotListController> = {}): BotListController {
  const noop = vi.fn()
  return {
    bots: [],
    isLoading: false,
    machines: [],
    machinesLoading: false,
    profilesByUserId: new Map(),
    createOpen: false,
    setCreateOpen: noop,
    editingBot: null,
    setEditingBot: noop,
    editOpen: false,
    setEditOpen: noop,
    activityBot: null,
    activityOpen: false,
    openActivity: noop,
    onActivityOpenChange: noop,
    bugReportBot: null,
    setBugReportBot: noop,
    bugReportOpen: false,
    setBugReportOpen: noop,
    confirmDelete: null,
    setConfirmDelete: noop,
    confirmReset: null,
    setConfirmReset: noop,
    confirmResetMachine: null,
    setConfirmResetMachine: noop,
    collapsedMachines: new Set(),
    setCollapsedMachines: noop,
    helpOpen: false,
    setHelpOpen: noop,
    guidedActive: false,
    guidedCreateLabel: "Create a bot",
    guidedAvatarSeed: undefined,
    groups: [],
    highlightId: null,
    groupRefs: { current: {} },
    chatWithBot: noop,
    onBotCreated: noop,
    openGuidedCreate: noop,
    openMachines: noop,
    bringMachineOnline: noop,
    machineName: () => "Machine",
    deleteConfirmedBot: noop,
    resetConfirmedBot: noop,
    resetConfirmedMachine: noop,
    ...overrides,
  } as BotListController
}

function withExactClass(container: HTMLElement, className: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("*"))
    .filter((node) => node.className === className)
}

function withClassFragment(container: HTMLElement, className: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("*"))
    .filter((node) => node.getAttribute("class")?.includes(className))
}

describe("renderBotListView", () => {
  beforeEach(() => vi.clearAllMocks())

  it("keeps the loaded header, group, and scroll geometry for either loading source", () => {
    for (const loading of [{ isLoading: true }, { machinesLoading: true }]) {
      const renderer = render(renderBotListView({}, controller(loading)))
      const cards = withClassFragment(renderer.container, "flex flex-col gap-3 p-4")
      expect(cards).toHaveLength(3)
      expect(cards.every((card) => card.parentElement === cards[0]!.parentElement)).toBe(true)
      expect(withExactClass(renderer.container,
        "flex flex-1 flex-col gap-6 overflow-y-auto p-6 thin-scrollbar")).toHaveLength(1)
      expect(withExactClass(renderer.container,
        "flex items-center justify-between gap-4")).toHaveLength(1)
      expect(withExactClass(renderer.container,
        "flex min-w-0 flex-1 flex-col gap-1")).toHaveLength(1)
      expect(withExactClass(renderer.container,
        "flex flex-col gap-3 rounded-lg p-1")).toHaveLength(1)
      expect(withExactClass(renderer.container,
        "flex h-7 items-center gap-2 px-1")).toHaveLength(1)
      expect(withExactClass(renderer.container,
        "flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-2.5 sm:items-end"))
        .toHaveLength(3)
      expect(withClassFragment(renderer.container, "size-10 shrink-0 rounded-full")).toHaveLength(3)
      expect(withClassFragment(renderer.container, "h-6 w-40 max-w-full rounded")).toHaveLength(3)
      expect(withClassFragment(renderer.container, "h-4 w-48 max-w-full rounded")).toHaveLength(3)
      expect(withClassFragment(renderer.container, "size-8 shrink-0 rounded-md")).toHaveLength(3)
      expect(mocks.overlays).not.toHaveBeenCalled()
      expect(mocks.createSheet).not.toHaveBeenCalled()
      renderer.unmount()
    }
  })

  it("bypasses loading for warm bots and renders the populated branch", () => {
    const state = controller({
      bots: [{ id: "b1" }] as BotListController["bots"],
      isLoading: true,
      machinesLoading: true,
    })
    const renderer = render(renderBotListView({}, state))
    expect(withClassFragment(renderer.container, "h-6 w-40 max-w-full rounded")).toHaveLength(0)
    expect(mocks.overlays).toHaveBeenCalledWith(state)
  })

  it("keeps empty state machine routing and constructs only its direct create sheet", () => {
    const openMachines = vi.fn()
    const setCreateOpen = vi.fn()
    const onBotCreated = vi.fn()
    const state = controller({
      openMachines,
      createOpen: true,
      setCreateOpen,
      onBotCreated,
      guidedActive: true,
      guidedAvatarSeed: "seed",
    })
    const renderer = render(renderBotListView({}, state))
    expect(renderer.container.querySelectorAll("create-tile")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("create-sheet")).toHaveLength(1)
    expect(renderer.getByText("Connect a machine first")).toBeInTheDocument()
    expect(renderer.getByText(
      "Bots need a connected machine to run. Connect one first, then come back to create your bot.",
    )).toBeInTheDocument()
    fireEvent.click(renderer.getByRole("button", { name: "Connect a machine" }))
    expect(openMachines).toHaveBeenCalledOnce()
    expect(mocks.createSheet).toHaveBeenCalledWith(expect.objectContaining({
      open: true,
      onOpenChange: setCreateOpen,
      onCreated: onBotCreated,
      guided: true,
      avatarSeed: "seed",
    }))
    expect(mocks.overlays).not.toHaveBeenCalled()
  })

  it("uses guided create for empty bots on a machine and preserves back wiring", () => {
    const onBack = vi.fn()
    const openGuidedCreate = vi.fn()
    const renderer = render(renderBotListView(
      { onBack },
      controller({
        machines: [{ id: "mac1" }] as BotListController["machines"],
        guidedCreateLabel: "Open bot chat",
        openGuidedCreate,
      }),
    ))
    fireEvent.click(renderer.getByRole("button", { name: "Back" }))
    expect(onBack).toHaveBeenCalledOnce()
    expect(renderer.getByText("No bots yet")).toBeInTheDocument()
    expect(renderer.getByText(
      "Create a bot and chat with it from anywhere — spin up servers and share it with family and friends.",
    )).toBeInTheDocument()
    fireEvent.click(renderer.getByRole("button", { name: "Open bot chat" }))
    expect(openGuidedCreate).toHaveBeenCalledOnce()
  })

  it("inserts group results and all eight named overlay slots in exact sibling order", () => {
    const setHelpOpen = vi.fn()
    const openGuidedCreate = vi.fn()
    const state = controller({
      bots: [{ id: "b1" }] as BotListController["bots"],
      setHelpOpen,
      openGuidedCreate,
      groups: [
        { machineId: "mac1", machine: null, bots: [] },
        { machineId: "mac2", machine: null, bots: [] },
      ],
    })
    const renderer = render(renderBotListView({}, state))
    expect(mocks.group.mock.calls.map(([group]) => group.machineId)).toEqual(["mac1", "mac2"])
    expect(mocks.group.mock.calls.every(([, passed]) => passed === state)).toBe(true)
    expect(mocks.overlays).toHaveBeenCalledWith(state)
    expect(withExactClass(renderer.container,
      "flex flex-1 flex-col gap-6 overflow-y-auto thin-scrollbar p-6")).toHaveLength(1)
    expect(withExactClass(renderer.container,
      "flex items-center justify-between gap-4")).toHaveLength(1)
    expect(renderer.getByText("My Bots")).toHaveClass("text-xl", "font-medium", "text-foreground")
    expect(renderer.getByText(
      "Bots you own — they show up as friends and can be added to any server.",
    )).toHaveClass("text-sm", "text-muted-foreground")
    expect(withExactClass(renderer.container, "flex items-center gap-1")).toHaveLength(1)
    expect(withExactClass(renderer.container, "flex flex-col gap-6")).toHaveLength(1)
    fireEvent.click(renderer.getByRole("button", { name: "How your agent works" }))
    expect(setHelpOpen).toHaveBeenCalledWith(true)
    fireEvent.click(renderer.getByRole("button", { name: "Create a bot" }))
    expect(openGuidedCreate).toHaveBeenCalledOnce()
    expect(Array.from(renderer.container.querySelectorAll("slot"))
      .map((node) => node.getAttribute("name"))).toEqual([
      "create",
      "help",
      "edit",
      "activity",
      "bug",
      "delete",
      "reset",
      "resetMachine",
    ])
  })

  it("keeps the same outer/back-bar contract in loading, empty, and populated branches", () => {
    const onBack = vi.fn()
    const loadingRenderer = render(React.createElement(BotListSkeleton, { onBack }))
    expect(loadingRenderer.container.querySelectorAll('[data-slot="loading-back-placeholder"]'))
      .toHaveLength(1)
    expect(loadingRenderer.queryAllByRole("button", { name: "Back" })).toHaveLength(0)
    loadingRenderer.unmount()

    const states = [
      controller(),
      controller({ bots: [{ id: "b1" }] as BotListController["bots"] }),
    ]
    for (const state of states) {
      const renderer = render(renderBotListView({ onBack }, state))
      expect(withExactClass(renderer.container, "flex min-h-0 flex-1 flex-col"))
        .not.toHaveLength(0)
      const back = renderer.getByRole("button", { name: "Back" })
      expect(back.parentElement?.className).toBe(
        "flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-6",
      )
      fireEvent.click(back)
      renderer.unmount()
    }
    expect(onBack).toHaveBeenCalledTimes(2)
  })
})
