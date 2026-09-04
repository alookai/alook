import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BotTokenUsage, BotUsageDay } from "@/hooks/community/use-bots"

const mocks = vi.hoisted(() => ({ breakpoint: "desktop" as "unknown" | "desktop" | "mobile" }))

vi.mock("@/hooks/use-mobile", () => ({
  useBreakpoint: () => mocks.breakpoint,
}))

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ render }: { render: React.ReactElement }) =>
    React.cloneElement(render, { "data-cell": true }),
  TooltipContent: ({ children }: React.PropsWithChildren) =>
    React.createElement("tooltip-content", null, children),
}))

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("mock-dialog", props, children),
  DialogTrigger: ({ render, children }: { render: React.ReactElement; children?: React.ReactNode }) =>
    React.cloneElement(render, {}, children),
  DialogContent: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("dialog-content", props, children),
  DialogDescription: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("dialog-description", props, children),
  DialogHeader: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("dialog-header", props, children),
  DialogTitle: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("dialog-title", props, children),
}))

import {
  BotTokenUsageHeatmap,
  tokenHeatBucket,
  usageDayPresentation,
} from "./bot-token-usage-chart"

const unavailable = null

function usageDay(
  day: string,
  metrics: BotUsageDay["metrics"],
  period: BotUsageDay["period"] = "closed",
): BotUsageDay {
  return { day, period, metrics }
}

function thirtyDays(overrides: Partial<Record<number, BotUsageDay["metrics"]>> = {}): BotUsageDay[] {
  return Array.from({ length: 30 }, (_, index) => usageDay(
    `2026-08-${String(index + 1).padStart(2, "0")}`,
    overrides[index + 1] ?? { input: unavailable, output: unavailable, cache: unavailable },
    index === 29 ? "in_progress" : "closed",
  ))
}

function render(usage?: BotTokenUsage) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(BotTokenUsageHeatmap, { botId: "bot_1", usage }),
    )
  })
  return renderer
}

function text(node: TestRenderer.ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : text(child)).join(" ")
}

describe("daily token heat presentation", () => {
  it("sums every known metric while preserving exact zero and unavailable", () => {
    expect(usageDayPresentation(usageDay("2026-08-30", {
      input: 0, output: 0, cache: 0,
    }))).toEqual({ knownTotal: 0, unavailable: false })

    expect(usageDayPresentation(usageDay("2026-08-30", {
      input: 12, output: 3, cache: unavailable,
    }))).toEqual({ knownTotal: 15, unavailable: false })

    expect(usageDayPresentation(usageDay("2026-08-30", {
      input: unavailable, output: unavailable, cache: unavailable,
    }))).toEqual({ knownTotal: 0, unavailable: true })
  })

  it("uses the four fixed token bands with an empty zero state", () => {
    const bucket = (knownTotal: number, unavailable = false) =>
      tokenHeatBucket({ knownTotal, unavailable })

    expect(bucket(0)).toBe(0)
    expect(bucket(1)).toBe(1)
    expect(bucket(9_999_999)).toBe(1)
    expect(bucket(10_000_000)).toBe(2)
    expect(bucket(99_999_999)).toBe(2)
    expect(bucket(100_000_000)).toBe(3)
    expect(bucket(499_999_999)).toBe(3)
    expect(bucket(500_000_000)).toBe(4)
    expect(bucket(900_000_000)).toBe(4)
    expect(bucket(500_000_000, true)).toBe(0)
  })
})

describe("BotTokenUsageHeatmap", () => {
  beforeEach(() => {
    mocks.breakpoint = "desktop"
  })

  it("renders the original 30-cell 3-by-10 shell oldest to newest", () => {
    const usage: BotTokenUsage = {
      capability: "supported",
      days: thirtyDays({
        27: { input: 1, output: 0, cache: 0 },
        28: { input: 10_000_000, output: 0, cache: 0 },
        29: { input: 100_000_000, output: 0, cache: 0 },
        30: { input: 500_000_000, output: 0, cache: 0 },
      }),
    }
    const renderer = render(usage)
    const heatmap = renderer.root.findByProps({
      "data-testid": "community-bot-usage-bot_1",
    })
    expect(heatmap.props.className).toContain("grid-flow-col")
    expect(heatmap.props.className).toContain("grid-template-rows:repeat(3")
    expect(heatmap.props["aria-label"]).toContain("610,000,001 known tokens total")

    const cells = renderer.root.findAllByProps({ "data-cell": true })
    expect(cells).toHaveLength(30)
    expect(cells[0]!.props["data-testid"]).toBe("community-bot-usage-day-bot_1-2026-08-01")
    expect(cells[29]!.props["data-testid"]).toBe("community-bot-usage-day-bot_1-2026-08-30")
    expect(cells.every((cell) => String(cell.props.className).includes("size-3 rounded-[2px]")))
      .toBe(true)
    expect(cells[0]!.props.className).toContain("bg-muted-foreground/15")
    expect(cells[26]!.props.className).toContain("bg-status-online/30")
    expect(cells[27]!.props.className).toContain("bg-status-online/55")
    expect(cells[28]!.props.className).toContain("bg-status-online/80")
    expect(cells[29]!.props.className.split(/\s+/)).toContain("bg-status-online")
    expect(renderer.root.findAll((node) => node.props.style?.height !== undefined)).toHaveLength(0)
    expect(renderer.root.findAll((node) => node.props["aria-pressed"] !== undefined)).toHaveLength(0)
  })

  it("shows the date and all three token totals for every day", () => {
    const usage: BotTokenUsage = {
      capability: "supported",
      days: thirtyDays({
        30: { input: 8, output: 2, cache: unavailable },
      }),
    }
    const renderer = render(usage)
    const today = renderer.root.findByProps({
      "data-testid": "community-bot-usage-day-bot_1-2026-08-30",
    })
    expect(today.props["aria-label"]).toContain("Aug 30")
    expect(today.props["aria-label"]).toContain("Input 8")
    expect(today.props["aria-label"]).toContain("Output 2")
    expect(today.props["aria-label"]).toContain("Cache Unavailable")
    expect(text(renderer.root)).toContain("Input 8")
    expect(text(renderer.root)).toContain("Output 2")
    expect(text(renderer.root)).toContain("Cache Unavailable")
  })

  it("omits missing and unsupported usage without reserving a heatmap slot", () => {
    expect(render({ capability: "unsupported", days: [] }).toJSON()).toBeNull()
    expect(render().toJSON()).toBeNull()
  })

  it("turns the whole mobile heatmap into one 44px dialog trigger", () => {
    mocks.breakpoint = "mobile"
    const usage: BotTokenUsage = { capability: "supported", days: thirtyDays() }
    const renderer = render(usage)
    const trigger = renderer.root.findByProps({
      "data-testid": "community-bot-usage-trigger-bot_1",
    })
    expect(trigger.props["aria-label"]).toBe("Open token usage details")
    expect(trigger.props["aria-haspopup"]).toBe("dialog")
    expect(trigger.props.className).toContain("min-h-11")
    expect(renderer.root.findAllByProps({ "data-cell": true })).toHaveLength(0)
    expect(renderer.root.findAll((node) => String(node.props["data-testid"] ?? "")
      .startsWith("community-bot-usage-day-bot_1-"))).toHaveLength(30)
  })

  it("opens mobile details on the newest day with Total and all metric values", () => {
    mocks.breakpoint = "mobile"
    const usage: BotTokenUsage = {
      capability: "supported",
      days: thirtyDays({
        30: { input: 8, output: 2, cache: 10 },
      }),
    }
    const renderer = render(usage)
    const dateButtons = renderer.root.findAll((node) => (
      typeof node.props["data-testid"] === "string"
      && node.props["data-testid"].startsWith("community-bot-usage-dialog-day-bot_1-")
    ))
    expect(dateButtons[0]!.props["data-testid"]).toBe(
      "community-bot-usage-dialog-day-bot_1-2026-08-30",
    )
    expect(dateButtons[29]!.props["data-testid"]).toBe(
      "community-bot-usage-dialog-day-bot_1-2026-08-01",
    )
    const newest = renderer.root.findByProps({
      "data-testid": "community-bot-usage-dialog-day-bot_1-2026-08-30",
    })
    expect(newest.props["aria-pressed"]).toBe(true)
    expect(newest.props.className).toContain("font-medium")
    const summary = renderer.root.findByProps({
      "data-testid": "community-bot-usage-dialog-summary-bot_1",
    })
    expect(text(summary)).toContain("Aug 30")
    expect(text(summary)).toContain("Total 20")
    expect(text(summary)).toContain("Input 8")
    expect(text(summary)).toContain("Output 2")
    expect(text(summary)).toContain("Cache 10")
  })

  it("updates mobile values and pressed state when an older date is selected", () => {
    mocks.breakpoint = "mobile"
    const usage: BotTokenUsage = {
      capability: "supported",
      days: thirtyDays({
        28: { input: 6_000_000, output: 3_000_000, cache: unavailable },
        30: { input: 8, output: 2, cache: 10 },
      }),
    }
    const renderer = render(usage)
    const older = renderer.root.findByProps({
      "data-testid": "community-bot-usage-dialog-day-bot_1-2026-08-28",
    })
    act(() => older.props.onClick())
    expect(older.props["aria-pressed"]).toBe(true)
    expect(renderer.root.findByProps({
      "data-testid": "community-bot-usage-dialog-day-bot_1-2026-08-30",
    }).props["aria-pressed"]).toBe(false)
    const summary = renderer.root.findByProps({
      "data-testid": "community-bot-usage-dialog-summary-bot_1",
    })
    expect(text(summary)).toContain("Aug 28")
    expect(text(summary)).toContain("Total 9,000,000")
    expect(text(summary)).toContain("Cache Unavailable")
  })

  it("shows unavailable rather than fabricating a zero total for an unknown day", () => {
    mocks.breakpoint = "mobile"
    const renderer = render({ capability: "supported", days: thirtyDays() })
    const unknown = renderer.root.findByProps({
      "data-testid": "community-bot-usage-dialog-day-bot_1-2026-08-25",
    })
    act(() => unknown.props.onClick())
    const summary = renderer.root.findByProps({
      "data-testid": "community-bot-usage-dialog-summary-bot_1",
    })
    expect(text(summary)).toContain("Total Unavailable")
    expect(text(summary).match(/Unavailable/g)).toHaveLength(4)
  })
})
