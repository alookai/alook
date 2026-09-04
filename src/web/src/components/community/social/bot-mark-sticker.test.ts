import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  result: {
    marks: [] as Array<any>,
    isLoading: false,
    isError: false,
    isNotFound: false,
  },
}))

vi.mock("@/hooks/community/use-bot-marks", () => ({
  useBotMarks: () => mocks.result,
}))
vi.mock("@/hooks/community/use-bot-audit-preview", () => ({
  useBotAuditPreview: () => ({
    events: [],
    isLoading: false,
    isError: false,
    isNotFound: false,
  }),
}))
vi.mock("../avatar", () => ({
  Avatar: ({ label }: { label: string }) => React.createElement("avatar", { label }),
}))
vi.mock("lucide-react", () => ({
  Activity: "activity-icon",
  ChevronRight: "chevron-icon",
  CircleStop: "stop-icon",
  ListTodo: "list-icon",
  LoaderCircle: "loader-icon",
  Lock: "lock-icon",
  Square: "square-icon",
}))

import { BotMarkSticker } from "./bot-mark-sticker"

const mark = (id: string, content = `Task ${id}`) => ({
  id,
  server: "Alook",
  serverId: "server_1",
  channel: "planning",
  channelId: "channel_1",
  m: {
    id: `message_${id}`,
    authorId: "author_1",
    authorName: "Gus",
    authorAvatar: "G",
    content,
    createdAt: "2026-09-04T00:00:00.000Z",
  },
})

function render(overrides: Partial<React.ComponentProps<typeof BotMarkSticker>> = {}) {
  let renderer!: TestRenderer.ReactTestRenderer
  const props = {
    botId: "bot_1",
    active: false,
    showStop: false,
    stopPending: false,
    onStop: vi.fn(),
    onOpenActivity: vi.fn(),
    ...overrides,
  }
  act(() => {
    renderer = TestRenderer.create(React.createElement(BotMarkSticker, props))
  })
  return { renderer, props }
}

describe("BotMarkSticker", () => {
  beforeEach(() => {
    mocks.result = { marks: [], isLoading: false, isError: false, isNotFound: false }
  })

  it("defaults to recent activity inside a stable note shell", () => {
    const { renderer } = render()
    expect(renderer.toJSON()).not.toBeNull()
    const activityTab = renderer.root.findByProps({ role: "tab", "aria-selected": true })
    expect(activityTab.children).toContainEqual(expect.objectContaining({ type: "activity-icon" }))
    expect(JSON.stringify(renderer.toJSON())).toContain("Recent activity")
    expect(JSON.stringify(renderer.toJSON())).toContain("Ready when you are")
  })

  it("shows up to three rich todo rows and a quiet overflow indicator", () => {
    mocks.result.marks = [
      mark("1", "**First** task"),
      mark("2"),
      mark("3"),
      mark("4"),
    ]
    const { renderer } = render()
    const marksTab = renderer.root.findAllByProps({ role: "tab" })[1]!
    act(() => marksTab.props.onClick())
    const rows = renderer.root.findAll((node) =>
      typeof node.props["data-testid"] === "string"
      && node.props["data-testid"].startsWith("community-bot-mark-sticker-row-"))

    expect(rows).toHaveLength(3)
    expect(JSON.stringify(renderer.toJSON())).toContain("First")
    expect(JSON.stringify(renderer.toJSON())).not.toContain("**First**")
    expect(JSON.stringify(renderer.toJSON())).toContain("Alook · #planning")
    expect(JSON.stringify(renderer.toJSON())).toContain("Gus")
    const overflow = renderer.root.findByProps({
      "data-testid": "community-bot-mark-sticker-overflow",
    })
    expect(overflow.props.role).toBe("status")
    expect(overflow.findByProps({ className: "sr-only" }).children).toEqual(["More marked work"])
    expect(renderer.root.findAllByType("square-icon")).toHaveLength(3)
  })

  it("keeps only the Stop footer visible while running with no marks", () => {
    const onStop = vi.fn()
    const { renderer } = render({ showStop: true, onStop })
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Marked work")
    const stop = renderer.root.findByProps({
      "data-testid": "community-bot-mark-sticker-stop",
    })
    expect(stop.props.disabled).toBe(false)
    act(() => stop.props.onClick())
    expect(onStop).toHaveBeenCalledOnce()
  })

  it("preserves only Stop during loading and disables it while pending", () => {
    mocks.result.isLoading = true
    const { renderer } = render({ showStop: true, stopPending: true })
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Loading marked work")
    const stop = renderer.root.findByProps({
      "data-testid": "community-bot-mark-sticker-stop",
    })
    expect(stop.props.disabled).toBe(true)
    expect(stop.props["aria-label"]).toBe("Stopping current agent turn")
    expect(JSON.stringify(renderer.toJSON())).toContain("Stopping…")
  })

  it("keeps the shell stable across mark errors and preserves Stop", () => {
    mocks.result.isError = true
    expect(render().renderer.toJSON()).not.toBeNull()

    mocks.result.isNotFound = true
    const missing = render({ showStop: true }).renderer
    expect(JSON.stringify(missing.toJSON())).toContain("Recent activity")
    expect(missing.root.findByProps({
      "data-testid": "community-bot-mark-sticker-stop",
    })).toBeDefined()
  })
})
