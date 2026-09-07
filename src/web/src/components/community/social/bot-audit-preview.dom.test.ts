import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  result: {
    events: [] as Array<Record<string, unknown>>,
    isLoading: false,
    isError: false,
    isNotFound: false,
  },
}))

vi.mock("@/hooks/community/use-bot-audit-preview", () => ({
  useBotAuditPreview: () => mocks.result,
}))
vi.mock("lucide-react", () => ({
  Activity: "activity-icon",
  ChevronRight: "chevron-icon",
  Lock: "lock-icon",
}))

import {
  BotAuditPreview,
  isBotActivityActive,
  isBotActivityRunning,
} from "./bot-audit-preview"

const globalCss = readFileSync(resolve(
  process.cwd(),
  process.cwd().endsWith("/src/web") ? "" : "src/web",
  "src/app/globals.css",
), "utf8")

const event = (id: string, kind: "tool_call" | "cli_invocation" = "tool_call") => ({
  id,
  kind,
  payload: kind === "tool_call"
    ? { name: `Tool ${id.slice(1)}`, target: `/private/${id}` }
    : { subcommand: "inboxPull" },
  sessionId: null,
  launchId: null,
  createdAt: `2026-01-01T00:00:0${id.slice(1)}.000Z`,
})

describe("BotAuditPreview", () => {
  beforeEach(() => {
    mocks.result = {
      events: [],
      isLoading: false,
      isError: false,
      isNotFound: false,
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("uses exact system status pairs for active state", () => {
    expect(isBotActivityActive("🌀", "Waking up")).toBe(true)
    expect(isBotActivityActive("⚡", "Working on it")).toBe(true)
    expect(isBotActivityActive("🌙", "Wrapping up")).toBe(true)
    expect(isBotActivityActive("💤", "Idle")).toBe(false)
    expect(isBotActivityActive("⚡", "Custom status")).toBe(false)
  })

  it("uses only true running presets for interrupt visibility", () => {
    expect(isBotActivityRunning("⚡", "Working on it")).toBe(true)
    expect(isBotActivityRunning("🌀", "Waking up")).toBe(false)
    expect(isBotActivityRunning("🌙", "Wrapping up")).toBe(false)
    expect(isBotActivityRunning("💤", "Idle")).toBe(false)
  })

  it("defines an opacity-only double-beat with a static reduced-motion ring", () => {
    expect(globalCss).toContain(".bot-audit-active-heartbeat::before")
    expect(globalCss).toContain("animation: bot-audit-heartbeat 2s ease-in-out infinite")
    expect(globalCss).toMatch(/8%\s*\{\s*opacity: 0\.9;/)
    expect(globalCss).toMatch(/26%\s*\{\s*opacity: 0\.62;/)
    expect(globalCss).toMatch(/36%,\s*100%\s*\{\s*opacity: 0\.28;/)
    expect(globalCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none;[\s\S]*opacity: 0\.55;/,
    )
  })

  it("keeps one keyboard target, a synthetic active row, and four persisted rows", () => {
    mocks.result.events = ["e5", "e4", "e3", "e2", "e1"].map((id) => event(id))
    const onOpen = vi.fn()
    const renderer = render(
      React.createElement(BotAuditPreview, { botId: "b1", active: true, onOpen }),
    )

    const button = renderer.container.querySelector<HTMLButtonElement>(
      '[data-testid="community-bot-audit-preview"]',
    )!
    expect(button.tagName).toBe("BUTTON")
    expect(button.getAttribute("data-active")).toBe("true")
    expect(button.getAttribute("aria-label")).toBe(
      "Bot activity in progress. Open full bot activity log",
    )
    expect(button.className).toContain("duration-150")
    expect(button.className).not.toContain("h-40")
    expect(button.className).not.toContain("hover:bg-accent")
    expect(button.className).toContain("hover:after:opacity-100")
    expect(button.className).toContain("after:ring-inset")
    expect(button.className).toContain("bot-audit-active-heartbeat")
    expect(button.className).toContain("before:ring-primary/60")
    expect(button.className).toContain("before:z-20")
    expect(button.className).toContain("after:z-10")
    expect(button.textContent).toContain("Only you can see this")
    expect(button.querySelectorAll("lock-icon")).toHaveLength(1)
    expect(renderer.container.querySelectorAll(
      '[data-testid="community-bot-audit-preview-active"]',
    )).toHaveLength(1)
    expect(renderer.container.querySelectorAll('[data-testid^="community-bot-audit-preview-row-"]'))
      .toHaveLength(4)
    expect(renderer.container.querySelectorAll("button")).toHaveLength(1)
    const timeline = button.querySelector('.flex.flex-col.py-1')!
    expect(timeline.className).not.toContain("overflow-y-auto")
    expect(timeline.className).not.toContain("thin-scrollbar")
    const rows = [...renderer.container.querySelectorAll('[data-testid^="community-bot-audit-preview-row-"]')]
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "community-bot-audit-preview-row-e2",
      "community-bot-audit-preview-row-e3",
      "community-bot-audit-preview-row-e4",
      "community-bot-audit-preview-row-e5",
    ])
    const activeRow = renderer.container.querySelector(
      '[data-testid="community-bot-audit-preview-active"]',
    )!
    expect(activeRow.className).toContain("motion-safe:duration-200")
    expect(activeRow.textContent).toContain("running")
    const activeTime = activeRow.querySelector("time")!
    expect(activeTime.dateTime).toBeTypeOf("string")
    expect(Math.abs(Date.now() - Date.parse(activeTime.dateTime))).toBeLessThan(5_000)
    expect(activeTime.textContent).not.toContain("running")
    expect(activeRow.querySelectorAll('[class*="rounded-full"]'))
      .toHaveLength(3)
    expect(activeRow.querySelectorAll('[class*="bg-linear-to-r"]'))
      .toHaveLength(0)
    const timelineRows = renderer.container.querySelectorAll(
      '[data-testid="community-bot-audit-preview-active"], [data-testid^="community-bot-audit-preview-row-"]',
    )
    expect(timelineRows.item(timelineRows.length - 1).getAttribute("data-testid")).toBe(
      "community-bot-audit-preview-active",
    )
    button.click()
    expect(onOpen).toHaveBeenCalledOnce()
    renderer.unmount()
  })

  it("keeps the running time current and never earlier than the latest event", () => {
    vi.useFakeTimers()
    vi.setSystemTime("2026-01-01T00:00:30.000Z")
    mocks.result.events = [{
      ...event("e1"),
      createdAt: "2026-01-01T00:00:05.000Z",
    }]
    const props = { botId: "b1", active: true, onOpen: vi.fn() }
    const renderer = render(React.createElement(BotAuditPreview, props))

    const activeTime = () => renderer.container.querySelector<HTMLTimeElement>(
      '[data-testid="community-bot-audit-preview-active"] time',
    )!
    expect(activeTime().dateTime).toBe("2026-01-01T00:00:30.000Z")

    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(activeTime().dateTime).toBe("2026-01-01T00:01:00.000Z")

    mocks.result.events = [{
      ...event("e2"),
      createdAt: "2026-01-01T00:05:00.000Z",
    }]
    renderer.rerender(React.createElement(BotAuditPreview, props))
    expect(activeTime().dateTime).toBe("2026-01-01T00:05:00.000Z")

    renderer.unmount()
  })

  it("renders five static rows while idle and disappears on authoritative 404", () => {
    mocks.result.events = ["e5", "e4", "e3", "e2", "e1"].map((id) => event(id))
    const props = { botId: "b1", active: false, onOpen: vi.fn() }
    const renderer = render(React.createElement(BotAuditPreview, props))
    expect(renderer.container.querySelectorAll('[data-testid^="community-bot-audit-preview-row-"]'))
      .toHaveLength(5)
    const button = renderer.container.querySelector(
      '[data-testid="community-bot-audit-preview"]',
    )!
    expect(button.getAttribute("aria-label")).toBe(
      "Bot at rest. Open full bot activity log",
    )
    expect(button.className).toContain("hover:after:opacity-100")
    expect(button.className).not.toContain("bot-audit-active-heartbeat")
    expect(button.className).not.toContain("before:ring-primary/60")

    mocks.result.isNotFound = true
    renderer.rerender(React.createElement(BotAuditPreview, props))
    expect(renderer.container).toBeEmptyDOMElement()
  })

  it("shows concrete command and tool names without tool parameters", () => {
    mocks.result.events = [
      event("e2", "tool_call"),
      event("e1", "cli_invocation"),
    ]
    const { container } = render(
      React.createElement(BotAuditPreview, { botId: "b1", active: false, onOpen: vi.fn() }),
    )
    const text = [...container.querySelectorAll("span")]
      .map((node) => node.textContent)
      .join(" ")
    expect(text).toContain("alook inbox pull")
    expect(text).toContain("tool 2")
    expect(text).not.toContain("/private/")
  })

  it("keeps the active row visible while persisted rows load or fail", () => {
    mocks.result.isLoading = true
    const props = { botId: "b1", active: true, onOpen: vi.fn() }
    const renderer = render(React.createElement(BotAuditPreview, props))
    expect(renderer.container.querySelectorAll(
      '[data-testid="community-bot-audit-preview-active"]',
    )).toHaveLength(1)
    expect(renderer.container.querySelectorAll('[aria-label="Loading recent activity"]'))
      .toHaveLength(1)

    mocks.result.isLoading = false
    mocks.result.isError = true
    renderer.rerender(React.createElement(BotAuditPreview, props))
    expect(renderer.container.querySelectorAll(
      '[data-testid="community-bot-audit-preview-active"]',
    )).toHaveLength(1)
    expect(renderer.container.textContent).toContain("Activity unavailable")
    renderer.unmount()
  })
})
