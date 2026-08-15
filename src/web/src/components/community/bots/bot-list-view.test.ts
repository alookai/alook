import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BotListController } from "./bot-list-types"

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

import { renderBotListView } from "./bot-list-view"

function controller(overrides: Partial<BotListController> = {}): BotListController {
  const noop = vi.fn()
  return {
    bots: [],
    isLoading: false,
    machines: [],
    machinesLoading: false,
    onlineUserIds: new Set(),
    createOpen: false,
    setCreateOpen: noop,
    editingBot: null,
    setEditingBot: noop,
    editOpen: false,
    setEditOpen: noop,
    activityBot: null,
    setActivityBot: noop,
    activityOpen: false,
    setActivityOpen: noop,
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

describe("renderBotListView", () => {
  beforeEach(() => vi.clearAllMocks())

  it("keeps the exact three-card skeleton branch for either loading source", () => {
    for (const loading of [{ isLoading: true }, { machinesLoading: true }]) {
      let renderer!: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(renderBotListView({}, controller(loading)))
      })
      const skeletonFibers = renderer.root.findAll((node) =>
        typeof node.type === "function" && node.type.name === "BotCardSkeleton")
      expect(skeletonFibers).toHaveLength(3)
      expect(skeletonFibers.map((node) => node.parent)).toEqual([
        skeletonFibers[0]!.parent,
        skeletonFibers[0]!.parent,
        skeletonFibers[0]!.parent,
      ])
      expect(renderer.root.findAllByProps({ className: "flex flex-col gap-3 p-6" }))
        .toHaveLength(1)
      expect(renderer.root.findAllByProps({ className: "flex flex-col gap-3 p-4" }))
        .toHaveLength(3)
      expect(renderer.root.findAllByProps({ className: "size-10 shrink-0 rounded-full" }))
        .toHaveLength(3)
      expect(renderer.root.findAllByProps({ className: "h-3.5 w-28 rounded" }))
        .toHaveLength(3)
      expect(renderer.root.findAllByProps({ className: "h-3 w-48 rounded" }))
        .toHaveLength(3)
      expect(renderer.root.findAllByProps({ className: "size-8 shrink-0 rounded-md" }))
        .toHaveLength(3)
      expect(mocks.overlays).not.toHaveBeenCalled()
      expect(mocks.createSheet).not.toHaveBeenCalled()
      act(() => renderer.unmount())
    }
  })

  it("bypasses loading for warm bots and renders the populated branch", () => {
    const state = controller({
      bots: [{ id: "b1" }] as BotListController["bots"],
      isLoading: true,
      machinesLoading: true,
    })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(renderBotListView({}, state)) })
    expect(renderer.root.findAll((node) =>
      typeof node.type === "function" && node.type.name === "BotCardSkeleton"))
      .toHaveLength(0)
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
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderBotListView({}, state))
    })
    expect(renderer.root.findAllByType("create-tile")).toHaveLength(1)
    expect(renderer.root.findAllByType("create-sheet")).toHaveLength(1)
    expect(renderer.root.findAll((node) => node.children.includes("Connect a machine first")))
      .toHaveLength(1)
    expect(renderer.root.findAll((node) => node.children.includes(
      "Bots need a connected machine to run. Connect one first, then come back to create your bot.",
    ))).toHaveLength(1)
    const connect = renderer.root.findAllByType("button").find((node) =>
      node.children.includes("Connect a machine"))!
    act(() => connect.props.onClick())
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
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderBotListView(
        { onBack },
        controller({
          machines: [{ id: "mac1" }] as BotListController["machines"],
          guidedCreateLabel: "Open bot chat",
          openGuidedCreate,
        }),
      ))
    })
    act(() => renderer.root.findByProps({ "aria-label": "Back" }).props.onClick())
    expect(onBack).toHaveBeenCalledOnce()
    expect(renderer.root.findAll((node) => node.children.includes("No bots yet"))).toHaveLength(1)
    expect(renderer.root.findAll((node) => node.children.includes(
      "Create a bot and chat with it from anywhere — spin up servers and share it with family and friends.",
    ))).toHaveLength(1)
    const open = renderer.root.findAllByType("button").find((node) =>
      node.children.includes("Open bot chat"))!
    act(() => open.props.onClick())
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
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderBotListView({}, state))
    })
    expect(mocks.group.mock.calls.map(([group]) => group.machineId)).toEqual(["mac1", "mac2"])
    expect(mocks.group.mock.calls.every(([, passed]) => passed === state)).toBe(true)
    expect(mocks.overlays).toHaveBeenCalledWith(state)
    expect(renderer.root.findByProps({
      className: "flex flex-1 flex-col gap-6 overflow-y-auto thin-scrollbar p-6",
    })).toBeTruthy()
    expect(renderer.root.findAllByProps({
      className: "flex items-center justify-between gap-4",
    })).toHaveLength(1)
    expect(renderer.root.findByProps({
      className: "text-xl font-medium text-foreground",
    }).children).toEqual(["My Bots"])
    expect(renderer.root.findByProps({
      className: "text-sm text-muted-foreground",
    }).children).toEqual([
      "Bots you own — they show up as friends and can be added to any server.",
    ])
    expect(renderer.root.findAllByProps({ className: "flex items-center gap-1" }))
      .toHaveLength(1)
    expect(renderer.root.findAllByProps({ className: "flex flex-col gap-6" }))
      .toHaveLength(1)
    act(() => renderer.root.findByProps({ "aria-label": "How your agent works" }).props.onClick())
    expect(setHelpOpen).toHaveBeenCalledWith(true)
    const create = renderer.root.findAllByType("button").find((node) =>
      node.children.includes("Create a bot"))!
    act(() => create.props.onClick())
    expect(openGuidedCreate).toHaveBeenCalledOnce()
    expect(renderer.root.findAllByType("slot").map((node) => node.props.name)).toEqual([
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
    const states = [
      controller({ isLoading: true }),
      controller(),
      controller({ bots: [{ id: "b1" }] as BotListController["bots"] }),
    ]
    for (const state of states) {
      let renderer!: TestRenderer.ReactTestRenderer
      act(() => { renderer = TestRenderer.create(renderBotListView({ onBack }, state)) })
      expect(renderer.root.findAllByProps({ className: "flex min-h-0 flex-1 flex-col" }))
        .not.toHaveLength(0)
      const back = renderer.root.findByProps({ "aria-label": "Back" })
      expect(back.parent?.props.className).toBe(
        "flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-6",
      )
      act(() => back.props.onClick())
      act(() => renderer.unmount())
    }
    expect(onBack).toHaveBeenCalledTimes(3)
  })
})
