import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

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
vi.mock("lucide-react", () => ({ Activity: "activity-icon", ChevronRight: "chevron-icon" }))

import { BotAuditPreview, isBotActivityActive } from "./bot-audit-preview"

const event = (id: string) => ({
  id,
  kind: "tool_call",
  payload: { private: id },
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

  it("uses exact system status pairs for active state", () => {
    expect(isBotActivityActive("🌀", "Waking up")).toBe(true)
    expect(isBotActivityActive("⚡", "Working on it")).toBe(true)
    expect(isBotActivityActive("🌙", "Wrapping up")).toBe(true)
    expect(isBotActivityActive("💤", "Idle")).toBe(false)
    expect(isBotActivityActive("⚡", "Custom status")).toBe(false)
  })

  it("keeps one keyboard target, a synthetic active row, and four persisted rows", () => {
    mocks.result.events = ["e1", "e2", "e3", "e4", "e5"].map(event)
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
    expect(button.props.className).toContain("hover:bg-accent/40")
    expect(button.props.className).toContain("active:bg-accent/60")
    expect(renderer.root.findAllByProps({
      "data-testid": "community-bot-audit-preview-active",
    })).toHaveLength(1)
    expect(renderer.root.findAll((node) =>
      typeof node.props["data-testid"] === "string"
      && node.props["data-testid"].startsWith("community-bot-audit-preview-row-")))
      .toHaveLength(4)
    expect(renderer.root.findAllByType("button")).toHaveLength(1)
    act(() => button.props.onClick())
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it("renders five static rows while idle and disappears on authoritative 404", () => {
    mocks.result.events = ["e1", "e2", "e3", "e4", "e5"].map(event)
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
    expect(renderer.root.findByProps({
      "data-testid": "community-bot-audit-preview",
    }).props["aria-label"]).toBe(
      "Bot at rest. Open full bot activity log",
    )

    mocks.result.isNotFound = true
    act(() => renderer.update(
      React.createElement(BotAuditPreview, { botId: "b1", active: false, onOpen: vi.fn() }),
    ))
    expect(renderer.toJSON()).toBeNull()
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
  })
})
