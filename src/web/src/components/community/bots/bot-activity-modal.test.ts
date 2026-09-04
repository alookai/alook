import { readFileSync } from "node:fs"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { auditState, fetchNextPage, scrollNode, bottomAnchor } = vi.hoisted(() => ({
  auditState: {
    events: [] as Array<{
      id: string
      kind: "tool_call"
      payload: unknown
      sessionId: string | null
      launchId: string | null
      createdAt: string
    }>,
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
  },
  fetchNextPage: vi.fn(),
  scrollNode: { scrollHeight: 600, scrollTop: 0, clientHeight: 300 },
  bottomAnchor: { scrollIntoView: vi.fn() },
}))

vi.mock("@/components/community/shell/community-sheet", () => ({
  CommunitySheet: ({
    children,
    bodyRef,
    ...props
  }: React.PropsWithChildren<Record<string, unknown>>) => {
    if (bodyRef && typeof bodyRef === "object" && "current" in bodyRef) {
      bodyRef.current = scrollNode
    }
    return React.createElement("community-sheet", props, children)
  },
}))

vi.mock("@/components/avatar", () => ({
  AgentAvatar: (props: Record<string, unknown>) => React.createElement("agent-avatar", props),
}))

vi.mock("@/stores/community/ws", () => ({
  useCommunityProfile: () => ({ presence: "online" }),
}))

vi.mock("@/hooks/community/use-bot-audit-log", () => ({
  useBotAuditLog: () => ({ ...auditState, fetchNextPage }),
}))

vi.mock("./bot-activity-row", () => ({
  BotActivityRow: ({ event }: { event: { id: string } }) =>
    React.createElement("activity-row", { eventId: event.id }),
}))

import { BotActivityModal } from "./bot-activity-modal"

const bot = {
  id: "bot-1",
  name: "Build Bot",
  description: "",
  image: null,
  machineId: "machine-1",
  runtime: "codex",
  modelName: null,
  lastRefreshContextAt: null,
  dailyActivity: [],
}

function event(id: string, createdAt: string) {
  return {
    id,
    kind: "tool_call" as const,
    payload: { name: "Read" },
    sessionId: null,
    launchId: null,
    createdAt,
  }
}

function renderModal(onOpenChange = vi.fn()) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(BotActivityModal, { bot, open: true, onOpenChange }),
      { createNodeMock: () => bottomAnchor },
    )
  })
  return { renderer, onOpenChange }
}

function updateModal(renderer: TestRenderer.ReactTestRenderer, onOpenChange: (open: boolean) => void) {
  act(() => renderer.update(
    React.createElement(BotActivityModal, { bot, open: true, onOpenChange }),
  ))
}

describe("BotActivityModal CommunitySheet contract", () => {
  beforeEach(() => {
    auditState.events = []
    auditState.isLoading = false
    auditState.hasNextPage = false
    auditState.isFetchingNextPage = false
    fetchNextPage.mockReset()
    bottomAnchor.scrollIntoView.mockReset()
    scrollNode.scrollHeight = 600
    scrollNode.scrollTop = 0
    scrollNode.clientHeight = 300
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
  })

  it("uses the resizable 672px shared shell and its one dismissal callback", () => {
    const { renderer, onOpenChange } = renderModal()
    const sheet = renderer.root.findByType("community-sheet")

    expect(sheet.props.desktopWidth).toBe(672)
    expect(sheet.props.resizable).toBe(true)
    expect(sheet.props.contentTestId).toBe("bot-activity-modal")
    expect(sheet.props.bodyClassName).toContain("p-0")
    expect(sheet.props.title).toBe("Build Bot")
    expect(sheet.props.headerLeading.props).toMatchObject({
      name: "Build Bot",
      seed: "bot-1",
      size: 32,
    })
    expect(sheet.props.description.props.className).toBe("flex items-center gap-1.5")
    expect(sheet.props.description.props.children[1].props.children).toBe("Live")

    act(() => sheet.props.onOpenChange(false))
    expect(onOpenChange).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)

    const source = readFileSync(new URL("./bot-activity-modal.tsx", import.meta.url), "utf8")
    expect(source).not.toContain("@/components/ui/dialog")
    expect(source).not.toContain("@/components/ui/sheet")
    expect(source).not.toMatch(/>\s*Close\s*</)
    expect(source).not.toContain("truncate text-sm font-medium")
    expect(source).not.toContain("gap-1.5 text-[11px]")
    expect(source).toContain("min-h-11 rounded-md")
  })

  it("keeps loading, empty, chronological day groups, and rows in the shared body", () => {
    auditState.isLoading = true
    const loading = renderModal().renderer
    expect(loading.root.findAllByProps({ className: "h-3 w-16 animate-pulse rounded bg-muted/40" }))
      .toHaveLength(8)
    loading.unmount()

    auditState.isLoading = false
    const empty = renderModal().renderer
    expect(empty.root.findByProps({ children: "No activity yet" })).toBeTruthy()
    empty.unmount()

    auditState.events = [
      event("new", "2026-08-27T12:00:00.000Z"),
      event("old", "2026-08-26T12:00:00.000Z"),
    ]
    const populated = renderModal().renderer
    expect(populated.root.findAllByType("section")).toHaveLength(2)
    expect(populated.root.findAllByType("activity-row").map((row) => row.props.eventId))
      .toEqual(["old", "new"])
  })

  it("preserves the visible row when an older page prepends", () => {
    auditState.events = [event("new", "2026-08-27T12:00:00.000Z")]
    auditState.hasNextPage = true
    const { renderer, onOpenChange } = renderModal()

    scrollNode.scrollHeight = 600
    scrollNode.scrollTop = 120
    act(() => renderer.root.findByProps({ children: "Load older" }).props.onClick())
    expect(fetchNextPage).toHaveBeenCalledOnce()

    auditState.events = [
      event("new", "2026-08-27T12:00:00.000Z"),
      event("old", "2026-08-26T12:00:00.000Z"),
    ]
    scrollNode.scrollHeight = 850
    updateModal(renderer, onOpenChange)
    expect(scrollNode.scrollTop).toBe(370)
  })

  it("pins a new live row only while the reader is near the tail", () => {
    auditState.events = [event("one", "2026-08-27T12:00:00.000Z")]
    const { renderer, onOpenChange } = renderModal()

    scrollNode.scrollHeight = 1_100
    scrollNode.scrollTop = 800
    scrollNode.clientHeight = 250
    auditState.events = [
      event("one", "2026-08-27T12:00:00.000Z"),
      event("two", "2026-08-27T12:01:00.000Z"),
    ]
    updateModal(renderer, onOpenChange)
    expect(scrollNode.scrollTop).toBe(1_100)

    scrollNode.scrollHeight = 1_300
    scrollNode.scrollTop = 100
    auditState.events = [
      ...auditState.events,
      event("three", "2026-08-27T12:02:00.000Z"),
    ]
    updateModal(renderer, onOpenChange)
    expect(scrollNode.scrollTop).toBe(100)
  })
})
