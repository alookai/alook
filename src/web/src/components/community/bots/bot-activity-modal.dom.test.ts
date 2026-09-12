import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render } from "@/test/react-dom-harness"

const {
  auditState,
  auditHook,
  profileHook,
  fetchNextPage,
  scrollNode,
  bottomAnchor,
  sheetProps,
} = vi.hoisted(() => ({
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
  auditHook: vi.fn(),
  profileHook: vi.fn(),
  fetchNextPage: vi.fn(),
  scrollNode: { scrollHeight: 600, scrollTop: 0, clientHeight: 300 },
  bottomAnchor: { scrollIntoView: vi.fn() },
  sheetProps: { current: null as Record<string, unknown> | null },
}))

vi.mock("@/components/community/shell/community-sheet", () => ({
  CommunitySheet: ({
    children,
    bodyRef,
    ...props
  }: React.PropsWithChildren<Record<string, unknown>>) => {
    sheetProps.current = props
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
  useCommunityProfile: (botId: string | undefined) => {
    profileHook(botId)
    return { presence: "online" }
  },
}))

vi.mock("@/hooks/community/use-bot-audit-log", () => ({
  useBotAuditLog: (botId: string | null) => {
    auditHook(botId)
    return { ...auditState, fetchNextPage }
  },
}))

vi.mock("./bot-activity-row", () => ({
  BotActivityRow: ({ event }: { event: { id: string } }) =>
    React.createElement("activity-row", { "data-event-id": event.id }),
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

type ModalOptions = {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onOpenChangeComplete?: (open: boolean) => void
}

function renderModal({
  open = true,
  onOpenChange = vi.fn(),
  onOpenChangeComplete = vi.fn(),
}: ModalOptions = {}) {
  const renderer = render(
    React.createElement(BotActivityModal, {
      bot,
      open,
      onOpenChange,
      onOpenChangeComplete,
    }),
  )
  return { renderer, onOpenChange, onOpenChangeComplete }
}

function updateModal(renderer: ReturnType<typeof render>, {
  open = true,
  onOpenChange = vi.fn(),
  onOpenChangeComplete = vi.fn(),
}: ModalOptions = {}) {
  act(() => renderer.rerender(
    React.createElement(BotActivityModal, {
      bot,
      open,
      onOpenChange,
      onOpenChangeComplete,
    }),
  ))
}

describe("BotActivityModal CommunitySheet contract", () => {
  beforeEach(() => {
    auditState.events = []
    auditState.isLoading = false
    auditState.hasNextPage = false
    auditState.isFetchingNextPage = false
    auditHook.mockReset()
    profileHook.mockReset()
    fetchNextPage.mockReset()
    bottomAnchor.scrollIntoView.mockReset()
    sheetProps.current = null
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: bottomAnchor.scrollIntoView,
    })
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
    expect(renderer.container.querySelector("community-sheet")).toBeInTheDocument()
    const sheet = sheetProps.current!

    expect(sheet.desktopWidth).toBe(672)
    expect(sheet.resizable).toBe(true)
    expect(sheet.contentTestId).toBe("bot-activity-modal")
    expect(sheet.bodyClassName).toContain("p-0")
    expect(sheet.title).toBe("Build Bot")
    expect((sheet.headerLeading as React.ReactElement).props).toMatchObject({
      name: "Build Bot",
      seed: "bot-1",
      size: 32,
    })
    const description = sheet.description as React.ReactElement<{ className: string; children: React.ReactElement[] }>
    expect(description.props.className).toBe("flex items-center gap-1.5")
    expect(description.props.children[1].props.children).toBe("Live")

    act(() => (sheet.onOpenChange as (open: boolean) => void)(false))
    expect(onOpenChange).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)

    const source = readFileSync(resolve(
      process.cwd(),
      process.cwd().endsWith("/src/web") ? "" : "src/web",
      "src/components/community/bots/bot-activity-modal.tsx",
    ), "utf8")
    expect(source).not.toContain("@/components/ui/dialog")
    expect(source).not.toContain("@/components/ui/sheet")
    expect(source).not.toMatch(/>\s*Close\s*</)
    expect(source).not.toContain("truncate text-sm font-medium")
    expect(source).not.toContain("gap-1.5 text-[11px]")
    expect(source).toContain("min-h-11 rounded-md")
  })

  it("keeps bot identity and the audit key through the closed ending frame", () => {
    auditState.events = [event("kept", "2026-08-27T12:00:00.000Z")]
    const { renderer, onOpenChange, onOpenChangeComplete } = renderModal()

    updateModal(renderer, { open: false, onOpenChange, onOpenChangeComplete })
    const sheet = sheetProps.current!
    expect(sheet.open).toBe(false)
    expect(sheet.title).toBe("Build Bot")
    expect((sheet.headerLeading as React.ReactElement).props).toMatchObject({
      name: "Build Bot",
      seed: "bot-1",
      size: 32,
    })
    const description = sheet.description as React.ReactElement<{
      children: React.ReactElement[]
    }>
    expect(description.props.children[1].props.children).toBe("Live")
    expect(profileHook).toHaveBeenLastCalledWith("bot-1")
    expect(auditHook).toHaveBeenLastCalledWith("bot-1")
    expect(renderer.container.querySelector('activity-row[data-event-id="kept"]'))
      .toBeInTheDocument()
    expect(sheet.onOpenChangeComplete).toBe(onOpenChangeComplete)

    act(() => (sheet.onOpenChangeComplete as (open: boolean) => void)(false))
    expect(onOpenChangeComplete).toHaveBeenCalledWith(false)
  })

  it("keeps loading, empty, chronological day groups, and rows in the shared body", () => {
    auditState.isLoading = true
    const loading = renderModal().renderer
    expect(loading.container.querySelectorAll('[class="h-3 w-16 animate-pulse rounded bg-muted/40"]'))
      .toHaveLength(8)
    loading.unmount()

    auditState.isLoading = false
    const empty = renderModal().renderer
    expect(empty.getByText("No activity yet")).toBeInTheDocument()
    empty.unmount()

    auditState.events = [
      event("new", "2026-08-27T12:00:00.000Z"),
      event("old", "2026-08-26T12:00:00.000Z"),
    ]
    const populated = renderModal().renderer
    expect(populated.container.querySelectorAll("section")).toHaveLength(2)
    expect([...populated.container.querySelectorAll("activity-row")]
      .map((row) => row.getAttribute("data-event-id")))
      .toEqual(["old", "new"])
  })

  it("preserves the visible row when an older page prepends", () => {
    auditState.events = [event("new", "2026-08-27T12:00:00.000Z")]
    auditState.hasNextPage = true
    const { renderer, onOpenChange } = renderModal()

    scrollNode.scrollHeight = 600
    scrollNode.scrollTop = 120
    fireEvent.click(renderer.getByRole("button", { name: "Load older" }))
    expect(fetchNextPage).toHaveBeenCalledOnce()

    auditState.events = [
      event("new", "2026-08-27T12:00:00.000Z"),
      event("old", "2026-08-26T12:00:00.000Z"),
    ]
    scrollNode.scrollHeight = 850
    updateModal(renderer, { onOpenChange })
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
    updateModal(renderer, { onOpenChange })
    expect(scrollNode.scrollTop).toBe(1_100)

    scrollNode.scrollHeight = 1_300
    scrollNode.scrollTop = 100
    auditState.events = [
      ...auditState.events,
      event("three", "2026-08-27T12:02:00.000Z"),
    ]
    updateModal(renderer, { onOpenChange })
    expect(scrollNode.scrollTop).toBe(100)
  })
})
