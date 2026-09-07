import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render as renderDom } from "@/test/react-dom-harness"

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
  Avatar: ({ label }: { label: string }) => React.createElement("div", {
    "data-avatar-label": label,
  }),
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

const globalCss = readFileSync(resolve(
  process.cwd(),
  process.cwd().endsWith("/src/web") ? "" : "src/web",
  "src/app/globals.css",
), "utf8")

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
  const props = {
    botId: "bot_1",
    active: false,
    showStop: false,
    stopPending: false,
    onStop: vi.fn(),
    onOpenActivity: vi.fn(),
    ...overrides,
  }
  const renderer = renderDom(React.createElement(BotMarkSticker, props))
  return { renderer, props }
}

const scrollDescriptors = new Map<string, PropertyDescriptor | undefined>()

function installScrollMocks() {
  for (const property of ["scrollHeight", "scrollTop", "clientHeight", "scrollIntoView"]) {
    scrollDescriptors.set(property, Object.getOwnPropertyDescriptor(HTMLElement.prototype, property))
  }
  const isActivityScroll = (element: HTMLElement) => (
    element.dataset.testid === "community-bot-audit-preview-scroll"
  )
  Object.defineProperties(HTMLElement.prototype, {
    scrollHeight: {
      configurable: true,
      get() { return isActivityScroll(this) ? mocks.scrollNode.scrollHeight : 0 },
    },
    clientHeight: {
      configurable: true,
      get() { return isActivityScroll(this) ? mocks.scrollNode.clientHeight : 0 },
    },
    scrollTop: {
      configurable: true,
      get() { return isActivityScroll(this) ? mocks.scrollNode.scrollTop : 0 },
      set(value: number) { if (isActivityScroll(this)) mocks.scrollNode.scrollTop = value },
    },
    scrollIntoView: {
      configurable: true,
      value(options?: ScrollIntoViewOptions) {
        if (this.dataset.testid === "community-bot-audit-preview-bottom") {
          mocks.bottomAnchor.scrollIntoView(options)
        }
      },
    },
  })
}

function restoreScrollMocks() {
  for (const [property, descriptor] of scrollDescriptors) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[property]
  }
  scrollDescriptors.clear()
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
    installScrollMocks()
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
  })

  afterEach(() => {
    restoreScrollMocks()
    vi.unstubAllGlobals()
  })

  it("defaults to recent activity inside a stable note shell", () => {
    const { renderer, props } = render()
    expect(renderer.container).not.toBeEmptyDOMElement()
    expect(renderer.container.textContent).toContain("Bot log")
    expect(renderer.container.textContent).not.toContain("Bot note")
    const title = [...renderer.container.querySelectorAll("span")]
      .find((node) => node.textContent === "Bot log")!
    expect(title.className).toContain("font-bold")
    expect(title.className).toContain("font-brand")
    const activityTab = renderer.container.querySelector('[role="tab"][aria-selected="true"]')!
    const tablist = renderer.container.querySelector('[role="tablist"]')!
    expect(tablist.className).toContain("h-12")
    expect(activityTab.className).toContain("h-11")
    expect(activityTab.querySelector("activity-icon")).not.toBeNull()
    expect(renderer.container.querySelector('[aria-label="Recent activity log"]')).not.toBeNull()
    expect(renderer.container.textContent).toContain("Ready when you are")
    const activityPanel = renderer.container.querySelector('[aria-label="Recent activity log"]')!
    expect(activityPanel.tagName).toBe("DIV")
    expect(activityPanel.className).not.toContain("overflow-hidden")
    expect(activityPanel.className).not.toContain("rounded-xl")
    expect(activityPanel.className).not.toContain("overflow-y-auto")
    expect(activityPanel.className).not.toContain("px-1")
    const activityScroller = activityPanel.querySelector('[class*="bot-note-scrollbar"]')!
    expect(activityScroller.className).toContain("overflow-x-hidden")
    expect(activityScroller.className).toContain("overflow-y-auto")
    const stream = renderer.container.querySelector(
      '[data-testid="community-bot-audit-preview-bottom"]',
    )!
    expect(stream.className).toContain("min-h-full")
    expect(stream.className).toContain("justify-end")
    const loadMore = renderer.container.querySelector<HTMLButtonElement>(
      '[aria-label="Load more activity in the full audit log"]',
    )!
    expect(loadMore.tagName).toBe("BUTTON")
    expect(loadMore.textContent).toContain("Load more")
    expect(loadMore.className).toContain("min-h-11")
    expect(loadMore.className).not.toContain("border")
    expect(loadMore.className).not.toContain("shadow")
    expect(loadMore.className).toContain("hover:bg-black/10")
    fireEvent.click(loadMore)
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
    const row = renderer.container.querySelector(
      '[data-testid="community-bot-audit-preview-row-event_1"]',
    )!
    expect(row.className).toContain("min-h-5")
    expect(row.className).toContain("grid-cols-[3.25rem_minmax(0,1fr)]")
    expect(row.className).toContain("leading-5")
    expect(row.className).toContain("px-[2px]")
    expect(row.querySelector("time")?.className).toContain("text-[10px]")
    expect(row.querySelector("time")?.className).toContain("text-black")
    expect(row.querySelector("time")?.className).toContain("whitespace-nowrap")
    const content = row.querySelector("span")
    expect(content?.className).toContain("text-black")
    expect(content?.className).toContain("font-mono")
    expect(content?.className).toContain("text-xs")
    expect(content?.className).not.toContain("font-semibold")
    const earlier = renderer.container.querySelector(
      '[data-testid="community-bot-audit-preview-earlier"]',
    )!
    expect(earlier.textContent).toBe("…")
    expect(earlier.className).toContain("min-h-5")
    expect(earlier.className).toContain("leading-5")
    expect(earlier.className).toContain("px-[2px]")
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
    renderer.rerender(React.createElement(BotMarkSticker, props))
    expect(mocks.scrollNode.scrollTop).toBe(0)
    expect(renderer.container.querySelectorAll('[data-testid^="community-bot-audit-preview-row-"]'))
      .toHaveLength(10)
    expect(renderer.container.querySelectorAll(
      '[data-testid="community-bot-audit-preview-row-event_0"]',
    )).toHaveLength(0)

    mocks.scrollNode.scrollTop = 130
    mocks.activity.events = events(2)
    renderer.rerender(React.createElement(BotMarkSticker, props))
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
    renderer.rerender(React.createElement(BotMarkSticker, props))

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
    const marksTab = renderer.container.querySelectorAll('[role="tab"]')[1]!
    fireEvent.click(marksTab)
    const rows = renderer.container.querySelectorAll(
      '[data-testid^="community-bot-mark-sticker-row-"]',
    )

    expect(rows).toHaveLength(3)
    expect(renderer.container.textContent).toContain("First")
    expect(renderer.container.textContent).not.toContain("**First**")
    expect(renderer.container.textContent).toContain("Gus")
    const messageContent = renderer.container.querySelector("p")!
    expect(messageContent.className).toContain("text-xs")
    expect(messageContent.className).toContain("leading-4")
    const overflow = renderer.container.querySelector(
      '[data-testid="community-bot-mark-sticker-overflow"]',
    )!
    expect(overflow.getAttribute("role")).toBe("status")
    expect(overflow.querySelector(".sr-only")?.textContent).toBe("More marked work")
    expect(renderer.container.querySelectorAll("square-icon")).toHaveLength(3)
    const location = renderer.container.querySelector('[title="Alook · #planning"]')!
    expect(location.className).toContain("w-fit")
    expect(location.className).toContain("max-w-full")
    const locationParts = location.querySelectorAll("span")
    expect(locationParts[0]?.className).not.toContain("flex-1")
    expect(locationParts[0]?.className).toContain("truncate")
    expect(locationParts[1]?.className).toBe("shrink-0")
    expect(locationParts[2]?.className).not.toContain("flex-1")
    expect(locationParts[2]?.className).toContain("truncate")
  })

  it("keeps the DM label fixed while truncating its channel independently", () => {
    mocks.result.marks = [{
      ...mark("dm"),
      server: "",
      serverId: null,
      channel: "a-very-long-direct-message-channel",
    }]
    const { renderer } = render()
    fireEvent.click(renderer.container.querySelectorAll('[role="tab"]')[1]!)
    const location = renderer.container.querySelector(
      '[title="DM · a-very-long-direct-message-channel"]',
    )!
    const parts = location.querySelectorAll("span")
    expect(parts[0]?.className).toBe("shrink-0")
    expect(parts[2]?.className).not.toContain("flex-1")
    expect(parts[2]?.className).toContain("truncate")
  })

  it("shows only DM when the direct-message location has no suffix", () => {
    mocks.result.marks = [{
      ...mark("dm-empty"),
      server: "",
      serverId: null,
      channel: "Unknown",
    }]
    const { renderer } = render()
    fireEvent.click(renderer.container.querySelectorAll('[role="tab"]')[1]!)
    const location = renderer.container.querySelector('[title="DM"]')!
    const parts = location.querySelectorAll("span")
    expect(parts).toHaveLength(1)
    expect(parts[0]?.textContent).toBe("DM")
    expect(renderer.container.textContent).not.toContain("Unknown")
    expect(renderer.container.textContent).not.toContain("·")
  })

  it("keeps only the Stop footer visible while running with no marks", () => {
    const onStop = vi.fn()
    const { renderer } = render({ active: true, showStop: true, onStop })
    expect(renderer.container.textContent).not.toContain("Marked work")
    const stop = renderer.container.querySelector<HTMLButtonElement>(
      '[data-testid="community-bot-mark-sticker-stop"]',
    )!
    expect(stop.disabled).toBe(false)
    expect(stop.className).toContain("bg-[#dc2626]")
    expect(stop.className).toContain("text-white")
    expect(stop.className).toContain("min-h-11")
    const activeRow = renderer.container.querySelector(
      '[data-testid="community-bot-audit-preview-active"]',
    )!
    expect(activeRow.className).toContain("grid-cols-[3.25rem_minmax(0,1fr)]")
    expect(activeRow.className).toContain("px-[2px]")
    expect(activeRow.querySelector("time")?.className).toContain("text-black")
    expect(activeRow.querySelectorAll('[class*="bg-black"]'))
      .toHaveLength(3)
    fireEvent.click(stop)
    expect(onStop).toHaveBeenCalledOnce()
  })

  it("preserves only Stop during loading and disables it while pending", () => {
    mocks.result.isLoading = true
    const { renderer } = render({ showStop: true, stopPending: true })
    expect(renderer.container.textContent).not.toContain("Loading marked work")
    const stop = renderer.container.querySelector<HTMLButtonElement>(
      '[data-testid="community-bot-mark-sticker-stop"]',
    )!
    expect(stop.disabled).toBe(true)
    expect(stop.getAttribute("aria-label")).toBe("Stopping current agent turn")
    expect(renderer.container.textContent).toContain("Stopping…")
  })

  it("keeps the shell stable across mark errors and preserves Stop", () => {
    mocks.result.isError = true
    expect(render().renderer.container).not.toBeEmptyDOMElement()

    mocks.result.isNotFound = true
    const missing = render({ showStop: true }).renderer
    expect(missing.container.querySelector('[aria-label="Recent activity log"]')).not.toBeNull()
    expect(missing.container.querySelector(
      '[data-testid="community-bot-mark-sticker-stop"]',
    )).not.toBeNull()
  })
})
