import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BotSummary } from "@/hooks/community/use-bots"
import { tid } from "@/lib/community/testids"
import type { BotListController, BotMachineGroup } from "./bot-list-types"

const mocks = vi.hoisted(() => ({ usage: vi.fn(), quota: vi.fn() }))

vi.mock("lucide-react", () => ({
  Activity: "activity-icon",
  ChevronDown: "chevron-icon",
  Monitor: "monitor-icon",
  MoreVertical: "more-icon",
  RotateCcw: "reset-icon",
}))
vi.mock("@/components/avatar", () => ({
  AgentAvatar: (props: unknown) => React.createElement("avatar", props as Record<string, unknown>),
}))
vi.mock("@/components/provider-logo", () => ({
  ProviderLogo: (props: unknown) => React.createElement("provider", props as Record<string, unknown>),
}))
vi.mock("./bot-token-usage-chart", () => ({
  BotTokenUsageHeatmap: (props: unknown) => {
    mocks.usage(props)
    return React.createElement("usage-heatmap", props as Record<string, unknown>)
  },
}))
vi.mock("./bot-quota-summary", () => ({
  MachineQuotaSummary: (props: unknown) => {
    mocks.quota(props)
    return React.createElement("quota-summary", props as Record<string, unknown>)
  },
}))
vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("card", props, children),
}))
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("button", props, children),
}))
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => React.createElement("menu", null, children),
  DropdownMenuContent: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("menu-content", props, children),
  DropdownMenuItem: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("menu-item", props, children),
  DropdownMenuTrigger: ({ render }: { render: React.ReactElement }) => render,
}))

import { renderBotMachineGroup } from "./bot-list-machine-group"

const bot = (overrides: Partial<BotSummary> = {}): BotSummary => ({
  id: "b1",
  name: "Blake",
  description: "",
  image: null,
  machineId: "mac1",
  runtime: "claude",
  modelName: "claude-opus-4-6",
  lastRefreshContextAt: null,
  dailyActivity: [],
  ...overrides,
})

function controller(overrides: Partial<BotListController> = {}): BotListController {
  const noop = vi.fn()
  return {
    profilesByUserId: new Map(),
    collapsedMachines: new Set(),
    setCollapsedMachines: noop,
    setConfirmResetMachine: noop,
    openActivity: noop,
    onActivityOpenChange: noop,
    setEditingBot: noop,
    setEditOpen: noop,
    setConfirmReset: noop,
    setBugReportBot: noop,
    setBugReportOpen: noop,
    setConfirmDelete: noop,
    groupRefs: { current: {} },
    highlightId: null,
    machineName: () => "My Mac",
    bringMachineOnline: noop,
    chatWithBot: noop,
    ...overrides,
  } as BotListController
}

const group = (overrides: Partial<BotMachineGroup> = {}): BotMachineGroup => ({
  machineId: "mac1",
  machine: { id: "mac1", displayName: "My Mac", hostname: "mac", status: "online" } as BotMachineGroup["machine"],
  bots: [bot()],
  ...overrides,
})

const text = (node: TestRenderer.ReactTestInstance): string =>
  node.children.map((child) => typeof child === "string" ? child : text(child)).join("")

describe("renderBotMachineGroup", () => {
  beforeEach(() => vi.clearAllMocks())

  it("keeps the keyed/ref-owned group, card projection, status, and reconnect action", () => {
    const bringMachineOnline = vi.fn()
    const state = controller({ bringMachineOnline })
    const element = renderBotMachineGroup(group(), state)
    expect(element.key).toBe("mac1")
    const groupNode = { marker: "group" }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(element, { createNodeMock: () => groupNode })
    })
    expect(state.groupRefs.current.mac1).toBe(groupNode)
    expect(element.props.className).toBe(
      "flex flex-col gap-3 rounded-lg p-1 transition-colors duration-500 ",
    )
    expect(renderer.root.findAllByProps({ className: "flex flex-col gap-1 px-1" }))
      .toHaveLength(1)
    expect(renderer.root.findAllByProps({ className: "flex flex-col gap-3" }))
      .toHaveLength(1)
    expect(renderer.root.findByType("card").props.className).toBe("flex flex-col gap-3 p-4")
    expect(renderer.root.findAllByProps({ className: "flex items-start justify-between gap-3" }))
      .toHaveLength(1)
    expect(renderer.root.findAllByProps({
      className: "flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-2.5",
    })).toHaveLength(1)
    expect(renderer.root.findAllByProps({ className: "basis-full sm:ml-auto sm:basis-auto" }))
      .toHaveLength(0)
    expect(renderer.root.findByProps({ "aria-label": "Collapse My Mac" }).props["aria-expanded"])
      .toBe(true)
    expect(renderer.root.findByType("avatar").props).toEqual(expect.objectContaining({
      name: "Blake",
      avatarUrl: null,
      seed: "b1",
      size: 40,
    }))
    expect(renderer.root.findByType("provider").props.provider).toBe("claude")
    expect(renderer.root.findByProps({ "data-testid": tid.botCardModel }).children).toEqual(["opus-4-6"])
    expect(mocks.usage).not.toHaveBeenCalled()
    expect(mocks.quota).toHaveBeenCalledWith({ machineId: "mac1", entries: undefined })

    const reconnect = renderer.root.findAllByType("button").find((node) =>
      node.children.includes("Bring online"))!
    const stopPropagation = vi.fn()
    act(() => reconnect.props.onClick({ stopPropagation }))
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(bringMachineOnline).toHaveBeenCalledWith("mac1")
  })

  it("keeps machine presence independent from bot presence and projects Reset all", () => {
    const setConfirmResetMachine = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderBotMachineGroup(
        group({ machine: { id: "mac1", displayName: "My Mac", status: "online" } as BotMachineGroup["machine"] }),
        controller({ profilesByUserId: new Map(), setConfirmResetMachine }),
      ))
    })
    expect(renderer.root.findAll((node) =>
      node.props.className === "inline-block size-1.5 shrink-0 rounded-full bg-status-online"))
      .toHaveLength(1)
    expect(renderer.root.findAll((node) => node.children.includes("Offline"))).not.toHaveLength(0)
    const resetAll = renderer.root.findAllByType("button").find((node) =>
      node.children.includes("Reset all"))!
    act(() => resetAll.props.onClick())
    expect(setConfirmResetMachine).toHaveBeenCalledWith("mac1")

    act(() => {
      renderer.update(renderBotMachineGroup(
        group({ machine: { id: "mac1", displayName: "My Mac", status: "offline" } as BotMachineGroup["machine"] }),
        controller({ profilesByUserId: new Map(), setConfirmResetMachine }),
      ))
    })
    expect(renderer.root.findAll((node) =>
      node.props.className === "inline-block size-1.5 shrink-0 rounded-full bg-muted-foreground"))
      .toHaveLength(1)
  })

  it("projects bot-owned fixed-scale heatmaps and machine-scoped quota once", () => {
    const usage = {
      capability: "supported" as const,
      days: [{
        day: "2026-08-29",
        period: "closed" as const,
        metrics: {
          input: 20,
          output: 10,
          cache: 0,
        },
      }],
    }
    const largerUsage = {
      capability: "supported" as const,
      days: [{
        day: "2026-08-29",
        period: "closed" as const,
        metrics: {
          input: 50,
          output: 20,
          cache: 30,
        },
      }],
    }
    const codexQuota = {
      scope: { kind: "machine_backend" as const, machineId: "mac1", agentBackendId: "codex" },
      capability: "supported" as const,
      runtimeState: "healthy" as const,
      snapshot: { status: "pending" as const },
    }
    const claudeQuota = {
      scope: { kind: "machine_backend" as const, machineId: "mac1", agentBackendId: "claude" },
      capability: "supported" as const,
      runtimeState: "healthy" as const,
      snapshot: { status: "pending" as const },
    }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderBotMachineGroup(
        group({
          machine: {
            id: "mac1",
            displayName: "My Mac",
            status: "online",
            quota: [codexQuota, claudeQuota],
          } as BotMachineGroup["machine"],
          bots: [
            bot({ id: "smaller", runtime: "codex", usage }),
            bot({ id: "larger", runtime: "claude", usage: largerUsage }),
          ],
        }),
        controller(),
      ))
    })
    expect(mocks.usage).toHaveBeenNthCalledWith(1, {
      botId: "smaller",
      usage,
      className: "self-center",
    })
    expect(mocks.usage).toHaveBeenNthCalledWith(2, {
      botId: "larger",
      usage: largerUsage,
      className: "self-center",
    })
    expect(renderer.root.findAllByType("usage-heatmap")).toHaveLength(2)
    expect(mocks.quota).toHaveBeenCalledTimes(1)
    expect(mocks.quota).toHaveBeenCalledWith({
      machineId: "mac1",
      entries: [codexQuota, claudeQuota],
    })
  })

  it("omits reconnect for an online bot even when its machine resolves", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderBotMachineGroup(
        group(),
        controller({ profilesByUserId: new Map([["b1", { id: "b1", presence: "online" }]]) }),
      ))
    })
    expect(renderer.root.findAll((node) => node.children.includes("Online"))).not.toHaveLength(0)
    expect(renderer.root.findAll((node) => node.children.includes("Bring online"))).toHaveLength(0)
  })

  it("keeps target-only highlight, card keys, and awake formatting", () => {
    const item = bot({
      id: "awake",
      lastRefreshContextAt: new Date(Date.now() - 3_600_000).toISOString(),
    })
    const highlighted = renderBotMachineGroup(
      group({ bots: [item] }),
      controller({ highlightId: "mac1" }),
    )
    const plain = renderBotMachineGroup(
      group({ bots: [item] }),
      controller({ highlightId: "other" }),
    )
    expect(highlighted.props.className).toBe(
      "flex flex-col gap-3 rounded-lg p-1 transition-colors duration-500 bg-primary/5 ring-2 ring-primary/40",
    )
    expect(plain.props.className).toBe(
      "flex flex-col gap-3 rounded-lg p-1 transition-colors duration-500 ",
    )
    const body = React.Children.toArray(highlighted.props.children)[1] as React.ReactElement<{
      children: React.ReactElement[]
    }>
    expect(body.props.children[0]!.key).toBe("awake")

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(highlighted) })
    expect(renderer.root.findAll((node) => node.children.includes("Awake 1h"))).not.toHaveLength(0)
  })

  it("keeps hidden collapse semantics and exact copied-Set toggling", () => {
    let nextSet: Set<string> | undefined
    const initial = new Set<string>()
    const setCollapsedMachines = vi.fn((updater: (value: Set<string>) => Set<string>) => {
      nextSet = updater(initial)
    })
    const state = controller({ collapsedMachines: initial, setCollapsedMachines })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(renderBotMachineGroup(group(), state)) })
    act(() => renderer.root.findByProps({ "aria-label": "Collapse My Mac" }).props.onClick())
    expect(nextSet).toEqual(new Set(["mac1"]))
    expect(nextSet).not.toBe(initial)
    expect(initial).toEqual(new Set())

    let expandedSet: Set<string> | undefined
    const collapsed = new Set(["mac1"])
    const expandMachines = vi.fn((updater: (value: Set<string>) => Set<string>) => {
      expandedSet = updater(collapsed)
    })
    act(() => {
      renderer.update(renderBotMachineGroup(group(), controller({
        collapsedMachines: collapsed,
        setCollapsedMachines: expandMachines,
      })))
    })
    const expand = renderer.root.findByProps({ "aria-label": "Expand My Mac" })
    expect(expand.props["aria-expanded"]).toBe(false)
    expect(renderer.root.findAll((node) => node.props.hidden === true)).toHaveLength(1)
    expect(renderer.root.findAllByType("card")).toHaveLength(1)
    act(() => expand.props.onClick())
    expect(expandedSet).toEqual(new Set())
    expect(expandedSet).not.toBe(collapsed)
    expect(collapsed).toEqual(new Set(["mac1"]))
  })

  it("keeps menu order, testids, and selected-bot action projections", () => {
    const openActivity = vi.fn()
    const setEditingBot = vi.fn()
    const setEditOpen = vi.fn()
    const setConfirmReset = vi.fn()
    const setBugReportBot = vi.fn()
    const setBugReportOpen = vi.fn()
    const setConfirmDelete = vi.fn()
    const chatWithBot = vi.fn()
    const item = bot()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderBotMachineGroup(group({ bots: [item] }), controller({
        openActivity,
        setEditingBot,
        setEditOpen,
        setConfirmReset,
        setBugReportBot,
        setBugReportOpen,
        setConfirmDelete,
        chatWithBot,
      })))
    })
    const items = renderer.root.findAllByType("menu-item")
    expect(items.map(text)).toEqual([
      " Chat",
      " View activity",
      " Edit",
      " Reset",
      " Report a problem",
      " Delete",
    ])
    expect(items[3]!.props["data-testid"]).toBe("bot-reset-session-item")
    expect(items[4]!.props["data-testid"]).toBe("bot-report-problem-item")
    expect(items[0]!.children[0]).toMatchObject({ props: { className: "size-4" } })
    expect(items[2]!.children[0]).toMatchObject({ props: { className: "size-4" } })
    expect(items[4]!.children[0]).toMatchObject({ props: { className: "size-4" } })
    expect([0, 2, 4, 5].map((index) =>
      (items[index]!.children[0] as TestRenderer.ReactTestInstance).type))
      .toEqual(["span", "span", "span", "span"])
    expect(items[1]!.findAllByType("activity-icon")).toHaveLength(1)
    expect(items[3]!.findAllByType("reset-icon")).toHaveLength(1)
    expect(items[5]!.props.variant).toBe("destructive")
    act(() => items[0]!.props.onClick())
    act(() => items[1]!.props.onClick())
    act(() => items[2]!.props.onClick())
    act(() => items[3]!.props.onClick())
    act(() => items[4]!.props.onClick())
    act(() => items[5]!.props.onClick())
    expect(chatWithBot).toHaveBeenCalledWith(item)
    expect(openActivity).toHaveBeenCalledWith(item)
    expect(setEditingBot).toHaveBeenCalledWith(item)
    expect(setEditOpen).toHaveBeenCalledWith(true)
    expect(setConfirmReset).toHaveBeenCalledWith(item)
    expect(setBugReportBot).toHaveBeenCalledWith({ id: "b1", name: "Blake" })
    expect(setBugReportOpen).toHaveBeenCalledWith(true)
    expect(setConfirmDelete).toHaveBeenCalledWith(item)
  })

  it("uses the global profile for bot status and omits reconnect for unknown machines", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderBotMachineGroup(
        group({ machine: null }),
        controller({
          profilesByUserId: new Map([["b1", { id: "b1", presence: "online" }]]),
          machineName: () => "Unknown machine",
        }),
      ))
    })
    expect(renderer.root.findAll((node) => node.children.includes("Online"))).not.toHaveLength(0)
    expect(renderer.root.findAll((node) => node.children.includes("Bring online"))).toHaveLength(0)
  })
})
