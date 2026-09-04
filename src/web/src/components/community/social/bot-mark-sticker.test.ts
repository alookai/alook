import { readFileSync } from "node:fs"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  result: {
    marks: [] as Array<any>,
    isLoading: false,
    isError: false,
    isNotFound: false,
  },
  activity: {
    events: [] as Array<any>,
    isLoading: false,
    isError: false,
    isNotFound: false,
    hasEarlierEvents: false,
  },
  scrollNode: { scrollHeight: 300, scrollTop: 0, clientHeight: 100 },
  bottomAnchor: { scrollIntoView: vi.fn() },
}))

vi.mock("@/hooks/community/use-bot-marks", () => ({
  useBotMarks: () => mocks.result,
}))
vi.mock("@/hooks/community/use-bot-audit-preview", () => ({
  useBotAuditPreview: () => mocks.activity,
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

const globalCss = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8")

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
    renderer = TestRenderer.create(React.createElement(BotMarkSticker, props), {
      createNodeMock: (element) => {
        if (element.props["data-testid"] === "community-bot-audit-preview-scroll") {
          return mocks.scrollNode
        }
        if (element.props["data-testid"] === "community-bot-audit-preview-bottom") {
          return mocks.bottomAnchor
        }
        return null
      },
    })
  })
  return { renderer, props }
}

describe("BotMarkSticker", () => {
  beforeEach(() => {
    mocks.result = { marks: [], isLoading: false, isError: false, isNotFound: false }
    mocks.activity = {
      events: [],
      isLoading: false,
      isError: false,
      isNotFound: false,
      hasEarlierEvents: false,
    }
    mocks.scrollNode.scrollHeight = 300
    mocks.scrollNode.scrollTop = 0
    mocks.scrollNode.clientHeight = 100
    mocks.bottomAnchor.scrollIntoView.mockReset()
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
  })

  afterEach(() => vi.unstubAllGlobals())

  it("defaults to recent activity inside a stable note shell", () => {
    const { renderer, props } = render()
    expect(renderer.toJSON()).not.toBeNull()
    expect(JSON.stringify(renderer.toJSON())).toContain("Bot log")
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Bot note")
    const title = renderer.root.find((node) => node.children.includes("Bot log"))
    expect(title.props.className).toContain("font-bold")
    expect(title.props.className).toContain("font-brand")
    const activityTab = renderer.root.findByProps({ role: "tab", "aria-selected": true })
    const tablist = renderer.root.findByProps({ role: "tablist" })
    expect(tablist.props.className).toContain("h-12")
    expect(activityTab.props.className).toContain("h-11")
    expect(activityTab.children).toContainEqual(expect.objectContaining({ type: "activity-icon" }))
    expect(JSON.stringify(renderer.toJSON())).toContain("Recent activity")
    expect(JSON.stringify(renderer.toJSON())).toContain("Ready when you are")
    const activityPanel = renderer.root.findByProps({
      "aria-label": "Recent activity log",
    })
    expect(activityPanel.type).toBe("div")
    expect(activityPanel.props.onClick).toBeUndefined()
    expect(activityPanel.props.className).not.toContain("overflow-hidden")
    expect(activityPanel.props.className).not.toContain("rounded-xl")
    expect(activityPanel.props.className).not.toContain("overflow-y-auto")
    expect(activityPanel.props.className).not.toContain("px-1")
    const activityScroller = activityPanel.find((node) =>
      node.props.className?.includes("bot-note-scrollbar"))
    expect(activityScroller.props.className).toContain("overflow-x-hidden")
    expect(activityScroller.props.className).toContain("overflow-y-auto")
    const stream = renderer.root.findByProps({
      "data-testid": "community-bot-audit-preview-bottom",
    })
    expect(stream.props.className).toContain("min-h-full")
    expect(stream.props.className).toContain("justify-end")
    const loadMore = renderer.root.findByProps({
      "aria-label": "Load more activity in the full audit log",
    })
    expect(loadMore.type).toBe("button")
    expect(loadMore.children).toContain("Load more")
    expect(loadMore.props.className).toContain("min-h-11")
    expect(loadMore.props.className).not.toContain("border")
    expect(loadMore.props.className).not.toContain("shadow")
    expect(loadMore.props.className).toContain("hover:bg-black/10")
    act(() => loadMore.props.onClick())
    expect(props.onOpenActivity).toHaveBeenCalledOnce()
    expect(globalCss).toContain(".bot-note-scrollbar")
    expect(globalCss).toContain("scrollbar-color: #8a6116 transparent")
    expect(globalCss).toMatch(
      /\.bot-note-scrollbar:hover\s*\{\s*scrollbar-color: #5f410c transparent;/,
    )
  })

  it("uses regular black ink for activity log content", () => {
    mocks.activity.events = [{
      id: "event_1",
      kind: "cli_invocation",
      payload: { subcommand: "inboxPull" },
      createdAt: "2026-09-04T00:00:00.000Z",
    }]
    mocks.activity.hasEarlierEvents = true
    const { renderer } = render()
    const row = renderer.root.findByProps({
      "data-testid": "community-bot-audit-preview-row-event_1",
    })
    expect(row.props.className).toContain("min-h-5")
    expect(row.props.className).toContain("grid-cols-[3.25rem_minmax(0,1fr)]")
    expect(row.props.className).toContain("leading-5")
    expect(row.props.className).toContain("px-[2px]")
    expect(row.findByType("time").props.className).toContain("text-[10px]")
    expect(row.findByType("time").props.className).toContain("text-black")
    expect(row.findByType("time").props.className).toContain("whitespace-nowrap")
    const content = row.findByType("span")
    expect(content?.props.className).toContain("text-black")
    expect(content?.props.className).toContain("font-mono")
    expect(content?.props.className).toContain("text-xs")
    expect(content?.props.className).not.toContain("font-semibold")
    const earlier = renderer.root.findByProps({
      "data-testid": "community-bot-audit-preview-earlier",
    })
    expect(earlier.children).toEqual(["…"])
    expect(earlier.props.className).toContain("min-h-5")
    expect(earlier.props.className).toContain("leading-5")
    expect(earlier.props.className).toContain("px-[2px]")
  })

  it("anchors initial rows at the tail and only follows live rows when already near it", () => {
    const events = (start: number) => Array.from({ length: 10 }, (_, index) => ({
      id: `event_${start + index}`,
      kind: "tool_call",
      payload: { name: `Tool ${start + index}` },
      createdAt: `2026-09-04T00:00:${String(start + index).padStart(2, "0")}.000Z`,
    }))
    mocks.activity.events = events(0)
    mocks.activity.hasEarlierEvents = true
    const { renderer, props } = render()

    expect(mocks.bottomAnchor.scrollIntoView).toHaveBeenCalledWith({ block: "end" })
    expect(mocks.scrollNode.scrollTop).toBe(300)

    mocks.scrollNode.scrollTop = 0
    mocks.activity.events = events(1)
    act(() => renderer.update(React.createElement(BotMarkSticker, props)))
    expect(mocks.scrollNode.scrollTop).toBe(0)
    expect(renderer.root.findAll((node) =>
      node.props["data-testid"]?.startsWith("community-bot-audit-preview-row-")))
      .toHaveLength(10)
    expect(renderer.root.findAllByProps({
      "data-testid": "community-bot-audit-preview-row-event_0",
    })).toHaveLength(0)

    mocks.scrollNode.scrollTop = 130
    mocks.activity.events = events(2)
    act(() => renderer.update(React.createElement(BotMarkSticker, props)))
    expect(mocks.scrollNode.scrollTop).toBe(300)
  })

  it("retries initial tail anchoring when a data update cancels the first frame", () => {
    let frameId = 0
    const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frameId += 1
      frames.set(frameId, callback)
      return frameId
    })
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))

    mocks.activity.events = [{
      id: "event_1",
      kind: "tool_call",
      payload: { name: "Tool 1" },
      createdAt: "2026-09-04T00:00:01.000Z",
    }]
    const { renderer, props } = render()

    mocks.activity.events = [{
      id: "event_2",
      kind: "tool_call",
      payload: { name: "Tool 2" },
      createdAt: "2026-09-04T00:00:02.000Z",
    }]
    act(() => renderer.update(React.createElement(BotMarkSticker, props)))

    const flushFrames = () => {
      const pending = [...frames.entries()]
      frames.clear()
      pending.forEach(([, callback]) => callback(0))
    }
    act(flushFrames)
    act(flushFrames)

    expect(mocks.bottomAnchor.scrollIntoView).toHaveBeenCalledOnce()
    expect(mocks.scrollNode.scrollTop).toBe(300)
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
    const messageContent = renderer.root.findAllByType("p")[0]!
    expect(messageContent.props.className).toContain("text-xs")
    expect(messageContent.props.className).toContain("leading-4")
    const overflow = renderer.root.findByProps({
      "data-testid": "community-bot-mark-sticker-overflow",
    })
    expect(overflow.props.role).toBe("status")
    expect(overflow.findByProps({ className: "sr-only" }).children).toEqual(["More marked work"])
    expect(renderer.root.findAllByType("square-icon")).toHaveLength(3)
    const location = renderer.root.findAllByProps({ title: "Alook · #planning" })[0]!
    expect(location.props.className).toContain("w-fit")
    expect(location.props.className).toContain("max-w-full")
    const locationParts = location.findAllByType("span")
    expect(locationParts[0]?.props.className).not.toContain("flex-1")
    expect(locationParts[0]?.props.className).toContain("truncate")
    expect(locationParts[1]?.props.className).toBe("shrink-0")
    expect(locationParts[2]?.props.className).not.toContain("flex-1")
    expect(locationParts[2]?.props.className).toContain("truncate")
  })

  it("keeps the DM label fixed while truncating its channel independently", () => {
    mocks.result.marks = [{
      ...mark("dm"),
      server: "",
      serverId: null,
      channel: "a-very-long-direct-message-channel",
    }]
    const { renderer } = render()
    act(() => renderer.root.findAllByProps({ role: "tab" })[1]!.props.onClick())
    const location = renderer.root.findByProps({
      title: "DM · a-very-long-direct-message-channel",
    })
    const parts = location.findAllByType("span")
    expect(parts[0]?.props.className).toBe("shrink-0")
    expect(parts[2]?.props.className).not.toContain("flex-1")
    expect(parts[2]?.props.className).toContain("truncate")
  })

  it("shows only DM when the direct-message location has no suffix", () => {
    mocks.result.marks = [{
      ...mark("dm-empty"),
      server: "",
      serverId: null,
      channel: "Unknown",
    }]
    const { renderer } = render()
    act(() => renderer.root.findAllByProps({ role: "tab" })[1]!.props.onClick())
    const location = renderer.root.findByProps({ title: "DM" })
    const parts = location.findAllByType("span")
    expect(parts).toHaveLength(1)
    expect(parts[0]?.children).toEqual(["DM"])
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Unknown")
    expect(JSON.stringify(renderer.toJSON())).not.toContain("·")
  })

  it("keeps only the Stop footer visible while running with no marks", () => {
    const onStop = vi.fn()
    const { renderer } = render({ active: true, showStop: true, onStop })
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Marked work")
    const stop = renderer.root.findByProps({
      "data-testid": "community-bot-mark-sticker-stop",
    })
    expect(stop.props.disabled).toBe(false)
    expect(stop.props.className).toContain("bg-[#dc2626]")
    expect(stop.props.className).toContain("text-white")
    expect(stop.props.className).toContain("min-h-11")
    const activeRow = renderer.root.findByProps({
      "data-testid": "community-bot-audit-preview-active",
    })
    expect(activeRow.props.className).toContain("grid-cols-[3.25rem_minmax(0,1fr)]")
    expect(activeRow.props.className).toContain("px-[2px]")
    expect(activeRow.findByType("time").props.className).toContain("text-black")
    expect(activeRow.findAll((node) => node.props.className?.includes("bg-black")))
      .toHaveLength(3)
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
