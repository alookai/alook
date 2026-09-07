import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BotSummary } from "@/hooks/community/use-bots"
import { tid } from "@/lib/community/testids"
import type { BotListController, BotMachineGroup } from "./bot-list-types"
import { act, fireEvent, render } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  avatar: vi.fn(),
  provider: vi.fn(),
  quota: vi.fn(),
  usage: vi.fn(),
}))

vi.mock("lucide-react", () => ({
  Activity: "activity-icon",
  ChevronDown: "chevron-icon",
  Monitor: "monitor-icon",
  MoreVertical: "more-icon",
  RotateCcw: "reset-icon",
}))
vi.mock("@/components/avatar", () => ({
  AgentAvatar: (props: unknown) => {
    mocks.avatar(props)
    return React.createElement("avatar")
  },
}))
vi.mock("@/components/provider-logo", () => ({
  ProviderLogo: (props: unknown) => {
    mocks.provider(props)
    return React.createElement("provider")
  },
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
  DropdownMenu: ({ children }: React.PropsWithChildren) => React.createElement("div", null, children),
  DropdownMenuContent: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("div", props, children),
  DropdownMenuItem: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("button", {
      ...props,
      "data-host": "menu-item",
      "data-variant": props.variant,
    }, children),
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

const text = (node: Node): string => node.textContent ?? ""

function withExactClass(container: HTMLElement, className: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("*"))
    .filter((node) => node.className === className)
}

describe("renderBotMachineGroup", () => {
  beforeEach(() => vi.clearAllMocks())

  it("keeps the keyed/ref-owned group, card projection, status, and reconnect action", () => {
    const bringMachineOnline = vi.fn()
    const state = controller({ bringMachineOnline })
    const element = renderBotMachineGroup(group(), state)
    expect(element.key).toBe("mac1")
    const renderer = render(element)
    const groupNode = renderer.container.firstElementChild
    expect(state.groupRefs.current.mac1).toBe(groupNode)
    expect(element.props.className).toBe(
      "flex flex-col gap-3 rounded-lg p-1 transition-colors duration-500 ",
    )
    expect(withExactClass(renderer.container, "flex flex-col gap-1 px-1")).toHaveLength(1)
    expect(withExactClass(renderer.container, "flex flex-col gap-3")).toHaveLength(1)
    expect(renderer.container.querySelector("card")).toHaveClass("flex", "flex-col", "gap-3", "p-4")
    expect(withExactClass(renderer.container,
      "flex items-start justify-between gap-3")).toHaveLength(1)
    expect(withExactClass(renderer.container,
      "flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-2.5")).toHaveLength(1)
    expect(withExactClass(renderer.container,
      "basis-full sm:ml-auto sm:basis-auto")).toHaveLength(0)
    expect(renderer.getByRole("button", { name: "Collapse My Mac" }))
      .toHaveAttribute("aria-expanded", "true")
    expect(mocks.avatar).toHaveBeenCalledWith(expect.objectContaining({
      name: "Blake",
      avatarUrl: null,
      seed: "b1",
      size: 40,
    }))
    expect(mocks.provider).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude" }))
    expect(renderer.getByTestId(tid.botCardModel)).toHaveTextContent("opus-4-6")
    expect(mocks.usage).not.toHaveBeenCalled()
    expect(mocks.quota).toHaveBeenCalledWith({ machineId: "mac1", entries: undefined })

    const reconnect = renderer.getByRole("button", { name: "Bring online" })
    const stopPropagation = vi.fn()
    const click = new MouseEvent("click", { bubbles: true })
    Object.defineProperty(click, "stopPropagation", { value: stopPropagation })
    act(() => reconnect.dispatchEvent(click))
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(bringMachineOnline).toHaveBeenCalledWith("mac1")
  })

  it("keeps machine presence independent from bot presence and projects Reset all", () => {
    const setConfirmResetMachine = vi.fn()
    const renderer = render(renderBotMachineGroup(
      group({ machine: { id: "mac1", displayName: "My Mac", status: "online" } as BotMachineGroup["machine"] }),
      controller({ profilesByUserId: new Map(), setConfirmResetMachine }),
    ))
    expect(withExactClass(renderer.container,
      "inline-block size-1.5 shrink-0 rounded-full bg-status-online"))
      .toHaveLength(1)
    expect(renderer.getByText("Offline")).toBeInTheDocument()
    fireEvent.click(renderer.getByRole("button", { name: "Reset all" }))
    expect(setConfirmResetMachine).toHaveBeenCalledWith("mac1")

    renderer.rerender(renderBotMachineGroup(
      group({ machine: { id: "mac1", displayName: "My Mac", status: "offline" } as BotMachineGroup["machine"] }),
      controller({ profilesByUserId: new Map(), setConfirmResetMachine }),
    ))
    expect(withExactClass(renderer.container,
      "inline-block size-1.5 shrink-0 rounded-full bg-muted-foreground"))
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
    const renderer = render(renderBotMachineGroup(
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
    expect(renderer.container.querySelectorAll("usage-heatmap")).toHaveLength(2)
    expect(mocks.quota).toHaveBeenCalledTimes(1)
    expect(mocks.quota).toHaveBeenCalledWith({
      machineId: "mac1",
      entries: [codexQuota, claudeQuota],
    })
  })

  it("omits reconnect for an online bot even when its machine resolves", () => {
    const renderer = render(renderBotMachineGroup(
      group(),
      controller({ profilesByUserId: new Map([["b1", { id: "b1", presence: "online" }]]) }),
    ))
    expect(renderer.getByText("Online")).toBeInTheDocument()
    expect(renderer.queryAllByText("Bring online")).toHaveLength(0)
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

    const renderer = render(highlighted)
    expect(renderer.getByText("Awake 1h")).toBeInTheDocument()
  })

  it("keeps hidden collapse semantics and exact copied-Set toggling", () => {
    let nextSet: Set<string> | undefined
    const initial = new Set<string>()
    const setCollapsedMachines = vi.fn((updater: (value: Set<string>) => Set<string>) => {
      nextSet = updater(initial)
    })
    const state = controller({ collapsedMachines: initial, setCollapsedMachines })
    const renderer = render(renderBotMachineGroup(group(), state))
    fireEvent.click(renderer.getByRole("button", { name: "Collapse My Mac" }))
    expect(nextSet).toEqual(new Set(["mac1"]))
    expect(nextSet).not.toBe(initial)
    expect(initial).toEqual(new Set())

    let expandedSet: Set<string> | undefined
    const collapsed = new Set(["mac1"])
    const expandMachines = vi.fn((updater: (value: Set<string>) => Set<string>) => {
      expandedSet = updater(collapsed)
    })
    renderer.rerender(renderBotMachineGroup(group(), controller({
      collapsedMachines: collapsed,
      setCollapsedMachines: expandMachines,
    })))
    const expand = renderer.getByRole("button", { name: "Expand My Mac" })
    expect(expand).toHaveAttribute("aria-expanded", "false")
    expect(renderer.container.querySelectorAll("[hidden]")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("card")).toHaveLength(1)
    fireEvent.click(expand)
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
    const renderer = render(renderBotMachineGroup(group({ bots: [item] }), controller({
      openActivity,
      setEditingBot,
      setEditOpen,
      setConfirmReset,
      setBugReportBot,
      setBugReportOpen,
      setConfirmDelete,
      chatWithBot,
    })))
    const items = Array.from(renderer.container.querySelectorAll<HTMLButtonElement>(
      '[data-host="menu-item"]',
    ))
    expect(items.map(text)).toEqual([
      " Chat",
      " View activity",
      " Edit",
      " Reset",
      " Report a problem",
      " Delete",
    ])
    expect(items[3]).toHaveAttribute("data-testid", "bot-reset-session-item")
    expect(items[4]).toHaveAttribute("data-testid", "bot-report-problem-item")
    expect(items[0]!.firstElementChild).toHaveClass("size-4")
    expect(items[2]!.firstElementChild).toHaveClass("size-4")
    expect(items[4]!.firstElementChild).toHaveClass("size-4")
    expect([0, 2, 4, 5].map((index) => items[index]!.firstElementChild?.localName))
      .toEqual(["span", "span", "span", "span"])
    expect(items[1]!.querySelectorAll("activity-icon")).toHaveLength(1)
    expect(items[3]!.querySelectorAll("reset-icon")).toHaveLength(1)
    expect(items[5]).toHaveAttribute("data-variant", "destructive")
    for (const item of items) fireEvent.click(item)
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
    const renderer = render(renderBotMachineGroup(
      group({ machine: null }),
      controller({
        profilesByUserId: new Map([["b1", { id: "b1", presence: "online" }]]),
        machineName: () => "Unknown machine",
      }),
    ))
    expect(renderer.getByText("Online")).toBeInTheDocument()
    expect(renderer.queryAllByText("Bring online")).toHaveLength(0)
  })
})
