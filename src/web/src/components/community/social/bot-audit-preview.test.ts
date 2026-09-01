import { readFileSync } from "node:fs"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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

const globalCss = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8")

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
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(BotAuditPreview, { botId: "b1", active: true, onOpen }),
      )
    })

    const button = renderer.root.findByProps({
      "data-testid": "community-bot-audit-preview",
    })
    expect(button.type).toBe("button")
    expect(button.props["data-active"]).toBe(true)
    expect(button.props["aria-label"]).toBe(
      "Bot activity in progress. Open full bot activity log",
    )
    expect(button.props.className).toContain("duration-150")
    expect(button.props.className).not.toContain("h-40")
    expect(button.props.className).not.toContain("hover:bg-accent")
    expect(button.props.className).toContain("hover:after:opacity-100")
    expect(button.props.className).toContain("after:ring-inset")
    expect(button.props.className).toContain("bot-audit-active-heartbeat")
    expect(button.props.className).toContain("before:ring-primary/60")
    expect(button.props.className).toContain("before:z-20")
    expect(button.props.className).toContain("after:z-10")
    expect(button.findAll((node) => node.children.includes("Only you can see this")))
      .toHaveLength(1)
    expect(button.findAllByType("lock-icon")).toHaveLength(1)
    expect(renderer.root.findAllByProps({
      "data-testid": "community-bot-audit-preview-active",
    })).toHaveLength(1)
    expect(renderer.root.findAll((node) =>
      typeof node.props["data-testid"] === "string"
      && node.props["data-testid"].startsWith("community-bot-audit-preview-row-")))
      .toHaveLength(4)
    expect(renderer.root.findAllByType("button")).toHaveLength(1)
    const timeline = button.find((node) => node.props.className === "flex flex-col py-1")
    expect(timeline.props.className).not.toContain("overflow-y-auto")
    expect(timeline.props.className).not.toContain("thin-scrollbar")
    const rows = renderer.root.findAll((node) =>
      typeof node.props["data-testid"] === "string"
      && node.props["data-testid"].startsWith("community-bot-audit-preview-row-"))
    expect(rows.map((row) => row.props["data-testid"])).toEqual([
      "community-bot-audit-preview-row-e2",
      "community-bot-audit-preview-row-e3",
      "community-bot-audit-preview-row-e4",
      "community-bot-audit-preview-row-e5",
    ])
    const activeRow = renderer.root.findByProps({
      "data-testid": "community-bot-audit-preview-active",
    })
    expect(activeRow.props.className).toContain("motion-safe:duration-200")
    expect(activeRow.findAll((node) => node.children.includes("running"))).not.toHaveLength(0)
    const activeTime = activeRow.findByType("time")
    expect(activeTime.props.dateTime).toBeTypeOf("string")
    expect(Math.abs(Date.now() - Date.parse(activeTime.props.dateTime))).toBeLessThan(5_000)
    expect(activeTime.children).not.toContain("running")
    expect(activeRow.findAll((node) => node.props.className?.includes("rounded-full")))
      .toHaveLength(3)
    expect(activeRow.findAll((node) => node.props.className?.includes("bg-linear-to-r")))
      .toHaveLength(0)
    const timelineRows = renderer.root.findAll((node) => {
      const testid = node.props["data-testid"]
      return testid === "community-bot-audit-preview-active"
        || (typeof testid === "string" && testid.startsWith("community-bot-audit-preview-row-"))
    })
    expect(timelineRows.at(-1)?.props["data-testid"]).toBe(
      "community-bot-audit-preview-active",
    )
    act(() => button.props.onClick())
    expect(onOpen).toHaveBeenCalledOnce()
    act(() => renderer.unmount())
  })

  it("keeps the running time current and never earlier than the latest event", () => {
    vi.useFakeTimers()
    vi.setSystemTime("2026-01-01T00:00:30.000Z")
    mocks.result.events = [{
      ...event("e1"),
      createdAt: "2026-01-01T00:00:05.000Z",
    }]
    const props = { botId: "b1", active: true, onOpen: vi.fn() }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAuditPreview, props))
    })

    const activeTime = () => renderer.root.findByProps({
      "data-testid": "community-bot-audit-preview-active",
    }).findByType("time")
    expect(activeTime().props.dateTime).toBe("2026-01-01T00:00:30.000Z")

    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(activeTime().props.dateTime).toBe("2026-01-01T00:01:00.000Z")

    mocks.result.events = [{
      ...event("e2"),
      createdAt: "2026-01-01T00:05:00.000Z",
    }]
    act(() => {
      renderer.update(React.createElement(BotAuditPreview, props))
    })
    expect(activeTime().props.dateTime).toBe("2026-01-01T00:05:00.000Z")

    act(() => renderer.unmount())
  })

  it("renders five static rows while idle and disappears on authoritative 404", () => {
    mocks.result.events = ["e5", "e4", "e3", "e2", "e1"].map((id) => event(id))
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(BotAuditPreview, { botId: "b1", active: false, onOpen: vi.fn() }),
      )
    })
    expect(renderer.root.findAll((node) =>
      typeof node.props["data-testid"] === "string"
      && node.props["data-testid"].startsWith("community-bot-audit-preview-row-")))
      .toHaveLength(5)
    const button = renderer.root.findByProps({
      "data-testid": "community-bot-audit-preview",
    })
    expect(button.props["aria-label"]).toBe(
      "Bot at rest. Open full bot activity log",
    )
    expect(button.props.className).toContain("hover:after:opacity-100")
    expect(button.props.className).not.toContain("bot-audit-active-heartbeat")
    expect(button.props.className).not.toContain("before:ring-primary/60")

    mocks.result.isNotFound = true
    act(() => renderer.update(
      React.createElement(BotAuditPreview, { botId: "b1", active: false, onOpen: vi.fn() }),
    ))
    expect(renderer.toJSON()).toBeNull()
  })

  it("shows concrete command and tool names without tool parameters", () => {
    mocks.result.events = [
      event("e2", "tool_call"),
      event("e1", "cli_invocation"),
    ]
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(BotAuditPreview, { botId: "b1", active: false, onOpen: vi.fn() }),
      )
    })
    const text = renderer.root.findAllByType("span")
      .flatMap((node) => node.children)
      .filter((child): child is string => typeof child === "string")
      .join(" ")
    expect(text).toContain("alook inbox pull")
    expect(text).toContain("tool 2")
    expect(text).not.toContain("/private/")
  })

  it("keeps the active row visible while persisted rows load or fail", () => {
    mocks.result.isLoading = true
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(BotAuditPreview, { botId: "b1", active: true, onOpen: vi.fn() }),
      )
    })
    expect(renderer.root.findAllByProps({
      "data-testid": "community-bot-audit-preview-active",
    })).toHaveLength(1)
    expect(renderer.root.findAllByProps({
      "aria-label": "Loading recent activity",
    })).toHaveLength(1)

    mocks.result.isLoading = false
    mocks.result.isError = true
    act(() => renderer.update(
      React.createElement(BotAuditPreview, { botId: "b1", active: true, onOpen: vi.fn() }),
    ))
    expect(renderer.root.findAllByProps({
      "data-testid": "community-bot-audit-preview-active",
    })).toHaveLength(1)
    expect(renderer.root.findAll((node) => node.children.includes("Activity unavailable")))
      .not.toHaveLength(0)
    act(() => renderer.unmount())
  })
})
