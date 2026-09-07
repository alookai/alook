import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BotTokenUsage, BotUsageDay } from "@/hooks/community/use-bots"
import { fireEvent, render as rtlRender } from "@/test/react-dom-harness"

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

function renderUsage(usage?: BotTokenUsage) {
  return rtlRender(React.createElement(BotTokenUsageHeatmap, { botId: "bot_1", usage }))
}

function text(node: Node): string {
  return Array.from(node.childNodes)
    .map((child) => child.nodeType === Node.TEXT_NODE ? child.textContent : text(child))
    .join(" ")
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
    const renderer = renderUsage(usage)
    const heatmap = renderer.getByTestId("community-bot-usage-bot_1")
    expect(heatmap).toHaveClass("grid-flow-col")
    expect(heatmap.className).toContain("grid-template-rows:repeat(3")
    expect(heatmap).toHaveAttribute("aria-label", expect.stringContaining("610,000,001 known tokens total"))

    const cells = Array.from(renderer.container.querySelectorAll<HTMLElement>("[data-cell]"))
    expect(cells).toHaveLength(30)
    expect(cells[0]).toHaveAttribute("data-testid", "community-bot-usage-day-bot_1-2026-08-01")
    expect(cells[29]).toHaveAttribute("data-testid", "community-bot-usage-day-bot_1-2026-08-30")
    expect(cells.every((cell) => cell.className.includes("size-3 rounded-[2px]")))
      .toBe(true)
    expect(cells[0]).toHaveClass("bg-muted-foreground/15")
    expect(cells[26]).toHaveClass("bg-status-online/30")
    expect(cells[27]).toHaveClass("bg-status-online/55")
    expect(cells[28]).toHaveClass("bg-status-online/80")
    expect(cells[29]).toHaveClass("bg-status-online")
    expect(Array.from(renderer.container.querySelectorAll<HTMLElement>("*"))
      .filter((node) => node.style.height)).toHaveLength(0)
    expect(renderer.container.querySelectorAll("[aria-pressed]")).toHaveLength(0)
  })

  it("shows the date and all three token totals for every day", () => {
    const usage: BotTokenUsage = {
      capability: "supported",
      days: thirtyDays({
        30: { input: 8, output: 2, cache: unavailable },
      }),
    }
    const renderer = renderUsage(usage)
    const today = renderer.getByTestId("community-bot-usage-day-bot_1-2026-08-30")
    expect(today.getAttribute("aria-label")).toContain("Aug 30")
    expect(today.getAttribute("aria-label")).toContain("Input 8")
    expect(today.getAttribute("aria-label")).toContain("Output 2")
    expect(today.getAttribute("aria-label")).toContain("Cache Unavailable")
    expect(text(renderer.container)).toContain("Input 8")
    expect(text(renderer.container)).toContain("Output 2")
    expect(text(renderer.container)).toContain("Cache Unavailable")
  })

  it("omits missing and unsupported usage without reserving a heatmap slot", () => {
    expect(renderUsage({ capability: "unsupported", days: [] }).container.firstChild).toBeNull()
    expect(renderUsage().container.firstChild).toBeNull()
  })

  it("turns the whole mobile heatmap into one 44px dialog trigger", () => {
    mocks.breakpoint = "mobile"
    const usage: BotTokenUsage = { capability: "supported", days: thirtyDays() }
    const renderer = renderUsage(usage)
    const trigger = renderer.getByTestId("community-bot-usage-trigger-bot_1")
    expect(trigger).toHaveAttribute("aria-label", "Open token usage details")
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog")
    expect(trigger).toHaveClass("min-h-11")
    expect(renderer.container.querySelectorAll("[data-cell]")).toHaveLength(0)
    expect(renderer.container.querySelectorAll('[data-testid^="community-bot-usage-day-bot_1-"]'))
      .toHaveLength(30)
  })

  it("opens mobile details on the newest day with Total and all metric values", () => {
    mocks.breakpoint = "mobile"
    const usage: BotTokenUsage = {
      capability: "supported",
      days: thirtyDays({
        30: { input: 8, output: 2, cache: 10 },
      }),
    }
    const renderer = renderUsage(usage)
    const dateButtons = Array.from(renderer.container.querySelectorAll(
      '[data-testid^="community-bot-usage-dialog-day-bot_1-"]',
    ))
    expect(dateButtons[0]).toHaveAttribute("data-testid",
      "community-bot-usage-dialog-day-bot_1-2026-08-30",
    )
    expect(dateButtons[29]).toHaveAttribute("data-testid",
      "community-bot-usage-dialog-day-bot_1-2026-08-01",
    )
    const newest = renderer.getByTestId("community-bot-usage-dialog-day-bot_1-2026-08-30")
    expect(newest).toHaveAttribute("aria-pressed", "true")
    expect(newest).toHaveClass("font-medium")
    const summary = renderer.getByTestId("community-bot-usage-dialog-summary-bot_1")
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
    const renderer = renderUsage(usage)
    const older = renderer.getByTestId("community-bot-usage-dialog-day-bot_1-2026-08-28")
    fireEvent.click(older)
    expect(older).toHaveAttribute("aria-pressed", "true")
    expect(renderer.getByTestId("community-bot-usage-dialog-day-bot_1-2026-08-30"))
      .toHaveAttribute("aria-pressed", "false")
    const summary = renderer.getByTestId("community-bot-usage-dialog-summary-bot_1")
    expect(text(summary)).toContain("Aug 28")
    expect(text(summary)).toContain("Total 9,000,000")
    expect(text(summary)).toContain("Cache Unavailable")
  })

  it("shows unavailable rather than fabricating a zero total for an unknown day", () => {
    mocks.breakpoint = "mobile"
    const renderer = renderUsage({ capability: "supported", days: thirtyDays() })
    fireEvent.click(renderer.getByTestId("community-bot-usage-dialog-day-bot_1-2026-08-25"))
    const summary = renderer.getByTestId("community-bot-usage-dialog-summary-bot_1")
    expect(text(summary)).toContain("Total Unavailable")
    expect(text(summary).match(/Unavailable/g)).toHaveLength(4)
  })
})
