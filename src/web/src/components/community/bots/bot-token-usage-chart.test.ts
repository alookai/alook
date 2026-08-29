import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import type { BotTokenUsage, BotUsageDay } from "@/hooks/community/use-bots"

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ render }: { render: React.ReactElement }) => React.cloneElement(render),
  TooltipContent: ({ children }: React.PropsWithChildren) =>
    React.createElement("tooltip-content", null, children),
}))
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
  PopoverTrigger: ({ render }: { render: React.ReactElement }) => React.cloneElement(render),
  PopoverContent: ({ children, className }: React.PropsWithChildren<{ className?: string }>) =>
    React.createElement("popover-content", { className }, children),
}))

import {
  BotTokenUsageChart,
  normalizedBarHeight,
  usageDayPresentation,
} from "./bot-token-usage-chart"

const unavailable = null
const complete = (tokens: number) => tokens

function usageDay(
  day: string,
  metrics: BotUsageDay["metrics"],
  period: BotUsageDay["period"] = "closed",
): BotUsageDay {
  return { day, period, metrics }
}

const sevenDays = (last: BotUsageDay): BotUsageDay[] => [
  usageDay("2026-08-23", { input: complete(5), output: complete(5), cache: complete(0) }),
  usageDay("2026-08-24", { input: complete(10), output: complete(10), cache: complete(0) }),
  usageDay("2026-08-25", { input: unavailable, output: unavailable, cache: unavailable }),
  usageDay("2026-08-26", { input: complete(20), output: complete(10), cache: unavailable }),
  usageDay("2026-08-27", { input: complete(0), output: complete(0), cache: complete(0) }),
  usageDay("2026-08-28", { input: complete(40), output: complete(40), cache: complete(20) }),
  last,
]

function render(usage?: BotTokenUsage) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(BotTokenUsageChart, { botId: "bot_1", usage }),
    )
  })
  return renderer
}

function text(node: TestRenderer.ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : text(child)).join(" ")
}

describe("usage chart normalization", () => {
  it("keeps exact zero and unavailable distinct without projecting coverage labels", () => {
    expect(usageDayPresentation(usageDay("2026-08-29", {
      input: complete(0), output: complete(0), cache: complete(0),
    }))).toEqual({ knownTotal: 0, unavailable: false })

    expect(usageDayPresentation(usageDay("2026-08-29", {
      input: complete(12), output: complete(3), cache: unavailable,
    }))).toEqual({ knownTotal: 15, unavailable: false })

    expect(usageDayPresentation(usageDay("2026-08-29", {
      input: unavailable, output: unavailable, cache: unavailable,
    }))).toEqual({ knownTotal: 0, unavailable: true })
  })

  it("normalizes all-zero, one-nonzero, and extreme differences to the seven-day maximum", () => {
    expect(normalizedBarHeight(0, 0)).toBe(0)
    expect(normalizedBarHeight(0, 900)).toBe(0)
    expect(normalizedBarHeight(900, 900)).toBe(100)
    expect(normalizedBarHeight(1, 1_000_000)).toBeCloseTo(0.0001, 8)
  })
})

describe("BotTokenUsageChart", () => {
  it("renders seven keyboard/tap targets oldest-to-newest without a persistent x-axis", () => {
    const usage: BotTokenUsage = {
      capability: "supported",
      days: sevenDays(usageDay(
        "2026-08-29",
        { input: complete(8), output: complete(2), cache: complete(0) },
        "in_progress",
      )),
    }
    const renderer = render(usage)
    const targets = renderer.root.findAll((node) => (
      node.props.role === "listitem" && node.props["data-testid"]
    ))
    expect(targets).toHaveLength(7)
    expect(targets[0]!.props["data-testid"]).toBe("community-bot-usage-day-bot_1-2026-08-23")
    expect(targets[6]!.props["data-testid"]).toBe("community-bot-usage-day-bot_1-2026-08-29")
    expect(targets[6]!.props["aria-label"]).toContain("Input 8")
    expect(targets[6]!.props["aria-label"]).toContain("Output 2")
    expect(renderer.root.findAll((node) => String(node.props.className).includes("h-10.5")))
      .not.toHaveLength(0)
    const desktopTargetText = targets.map(text).join(" ")
    expect(desktopTargetText).not.toContain("8/23")
    expect(desktopTargetText).not.toContain("Today")
    expect(text(renderer.root)).not.toContain("Tokens")
  })

  it("shares one proportional seven-day scale without coverage annotations or background pipes", () => {
    const usage: BotTokenUsage = {
      capability: "supported",
      days: sevenDays(usageDay(
        "2026-08-29",
        { input: complete(50), output: complete(0), cache: complete(0) },
        "in_progress",
      )),
    }
    const renderer = render(usage)
    const heightNodes = renderer.root.findAll((node) => typeof node.props.style?.height === "string")
    expect(heightNodes.map((node) => node.props.style.height)).toContain("100%")
    expect(heightNodes.map((node) => node.props.style.height)).toContain("50%")
    expect(renderer.root.findAll((node) => String(node.props.className).includes("ring-inset")))
      .toHaveLength(0)
  })

  it("groups seven mobile days into a four-column selector with one pressed 44px target", () => {
    const usage: BotTokenUsage = {
      capability: "supported",
      days: sevenDays(usageDay(
        "2026-08-29",
        { input: complete(8), output: complete(2), cache: complete(0) },
        "in_progress",
      )),
    }
    const renderer = render(usage)
    const mobileTargets = renderer.root.findAll((node) => node.props["aria-pressed"] !== undefined)
    expect(mobileTargets).toHaveLength(7)
    expect(mobileTargets.filter((node) => node.props["aria-pressed"])).toHaveLength(1)
    expect(mobileTargets[6]!.props["aria-pressed"]).toBe(true)
    expect(mobileTargets.every((node) => String(node.props.className).includes("h-11"))).toBe(true)
    expect(String(mobileTargets[0]!.parent?.props.className)).toContain("grid-cols-4")

    act(() => mobileTargets[2]!.props.onClick())
    const updatedTargets = renderer.root.findAll((node) => node.props["aria-pressed"] !== undefined)
    expect(updatedTargets[2]!.props["aria-pressed"]).toBe(true)
    expect(updatedTargets.filter((node) => node.props["aria-pressed"])).toHaveLength(1)
  })

  it("omits missing and unsupported usage without reserving a chart slot", () => {
    const unsupported = render({ capability: "unsupported", days: [] })
    expect(unsupported.toJSON()).toBeNull()

    const unknown = render()
    expect(unknown.toJSON()).toBeNull()
  })
})
