import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import { renderCommunity as renderDom } from "@/test/community-owner-harness"

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
vi.mock("lucide-react", async (importOriginal) => ({
  ...await importOriginal<typeof import("lucide-react")>(),
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

  it("defaults to Thoughts and has no separate Load more control", () => {
    const { renderer, props } = render()
    expect(renderer.container.textContent).toContain("Bot log")
    expect(renderer.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Thoughts")
    expect(renderer.container.querySelector('[aria-label="Recent thoughts"]')).not.toBeNull()
    expect(renderer.container.textContent).toContain("No recent thoughts")
    expect(renderer.container.textContent).toContain("Ready when you are")
    expect(renderer.container.textContent).not.toContain("Load more")
    expect(props.onOpenActivity).not.toHaveBeenCalled()
  })

  it("renders literal Unicode/newlines and retention metadata; the timestamp opens the audit", () => {
    const body = "一页正文🙂\n<b>Literal</b>"
    mocks.activity.events = [{ id: "text", kind: "text", payload: { text: body, truncated: true, chars: 200 }, createdAt: "2026-09-04T00:00:00.000Z" }]
    const { renderer, props } = render()
    const row = renderer.container.querySelector('[data-testid="community-bot-audit-preview-row-text"]')!
    const content = row.querySelector("[data-community-message-body]")!
    expect(content).toHaveTextContent("一页正文🙂")
    expect(content).toHaveTextContent("<b>Literal</b>…")
    expect(content.querySelector("br")).not.toBeNull()
    expect(row.querySelector("b")).toBeNull()
    expect(row.querySelector("button")).toHaveAccessibleName(row.querySelector("time")!.textContent!)
    expect(row.querySelector("button")).toHaveAccessibleDescription("Open full audit log")
    expect(row.textContent).not.toContain("Truncated")
    expect(row.querySelector("time")?.dateTime).toBe("2026-09-04T00:00:00.000Z")
    fireEvent.click(row.querySelector("button")!)
    expect(props.onOpenActivity).toHaveBeenCalledOnce()
    fireEvent.click(content)
    expect(props.onOpenActivity).toHaveBeenCalledTimes(2)
  })

  it("renders message Markdown and syntax without making inner controls open the audit", () => {
    const text = "**Bold** and *emphasis* with `inline`\n\n- First item\n\n```ts\nconst value = 1\n```\n\n[Docs](https://example.com/docs) ||secret|| @Gus#1813"
    mocks.activity.events = [{ id: "rich", kind: "text", payload: { text, truncated: false, chars: text.length }, createdAt: "2026-09-04T00:00:00.000Z" }]
    const { renderer, props } = render()
    const row = renderer.container.querySelector('[data-testid="community-bot-audit-preview-row-rich"]')!
    const content = row.querySelector("[data-community-message-body]")!
    expect(content.querySelector('[data-streamdown="strong"]')).toHaveTextContent("Bold")
    expect(content.querySelector("em")).toHaveTextContent("emphasis")
    expect(content.querySelector("li")).toHaveTextContent("First item")
    expect(content.querySelector("code")).toHaveTextContent("inline")
    expect(content.querySelector("pre")).toHaveTextContent("const value = 1")
    expect(content.querySelector('[title="@Gus"]')).toHaveTextContent("@Gus")
    expect(row.querySelector("button button, button a, button [data-community-message-body]")).toBeNull()

    const link = content.querySelector("a")!
    expect(link).toHaveAttribute("href", "https://example.com/docs")
    expect(link).toHaveAttribute("data-message-external-link", "true")
    link.addEventListener("click", (event) => event.preventDefault(), { once: true })
    fireEvent.click(link)
    fireEvent.click(renderer.getByRole("button", { name: "secret" }))
    expect(props.onOpenActivity).not.toHaveBeenCalled()
    fireEvent.click(row.querySelector('[title="Open full audit log"]')!)
    expect(props.onOpenActivity).toHaveBeenCalledOnce()
    fireEvent.click(content.querySelector("em")!)
    expect(props.onOpenActivity).toHaveBeenCalledTimes(2)
    const selection = window.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(content)
    selection.addRange(range)
    fireEvent.click(content)
    expect(props.onOpenActivity).toHaveBeenCalledTimes(2)
    selection.removeAllRanges()
  })

  it("uses message HTML and link safety for thought text", () => {
    const text = "<img src=x onerror=alert(1)> [bad](javascript:alert(1))"
    mocks.activity.events = [{ id: "unsafe", kind: "text", payload: { text, truncated: false, chars: text.length }, createdAt: "2026-09-04T00:00:00.000Z" }]
    const { renderer } = render()
    const content = renderer.container.querySelector("[data-community-message-body]")!
    expect(content).toHaveTextContent("<img src=x onerror=alert(1)>")
    expect(content.querySelector("img, script, [onerror], a[href^='javascript:']")).toBeNull()
  })

  it("does not expose cached text after an authoritative ownership404", () => {
    mocks.activity.events = [{ id: "stale", kind: "text", payload: { text: "private cached body", truncated: false, chars: 19 }, createdAt: "2026-09-04T00:00:00.000Z" }]
    mocks.activity.isNotFound = true
    const { renderer } = render()
    expect(renderer.container).toBeEmptyDOMElement()
  })

  it("keeps malformed text inspectable without inserting payload markup", () => {
    mocks.activity.events = [{ id: "bad", kind: "text", payload: { text: { html: "<script>bad</script>" } }, createdAt: "2026-09-04T00:00:00.000Z" }]
    const { renderer, props } = render()
    expect(renderer.container.textContent).toContain("Text unavailable")
    expect(renderer.container.querySelector("script")).toBeNull()
    fireEvent.click(renderer.container.querySelector('[title="Open full audit log"]')!)
    expect(props.onOpenActivity).toHaveBeenCalledOnce()
  })

  it.each(["isLoading", "isError"] as const)("holds the Thoughts panel during %s", (state) => {
    mocks.activity[state] = true
    const { renderer } = render()
    expect(renderer.container.querySelector('[aria-label="Recent thoughts"]')).not.toBeNull()
    expect(renderer.container.textContent).toContain(state === "isLoading" ? "Loading thoughts" : "Thoughts unavailable")
  })

  it.each(["content", "empty", "error"] as const)("replaces the loading skeleton with %s", (state) => {
    mocks.activity.isLoading = true
    const { renderer, props } = render()
    const loading = renderer.container.querySelector('[role="status"][aria-label="Loading thoughts"]')
    expect(loading).not.toBeNull()
    expect(loading?.querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect(loading?.querySelector("button, a")).toBeNull()
    expect(renderer.container.textContent).not.toContain("No recent thoughts")

    mocks.activity.isLoading = false
    mocks.activity.isError = state === "error"
    if (state === "content") mocks.activity.events = [{
      id: "loaded-thought",
      kind: "text",
      payload: { text: "The report is ready", truncated: false, chars: 19 },
      createdAt: "2026-09-04T00:00:00.000Z",
    }]
    renderer.rerender(React.createElement(BotMarkSticker, props))
    expect(renderer.container.querySelector('[aria-label="Loading thoughts"]')).toBeNull()
    expect(renderer.container.textContent).toContain(state === "content" ? "The report is ready" : state === "error" ? "Thoughts unavailable" : "No recent thoughts")
  })

  it("anchors initial rows at the tail and only follows live rows when already near it", () => {
    const events = (start: number) => Array.from({ length: 10 }, (_, index) => ({
      id: `event_${start + index}`,
      kind: "text",
      payload: { text: `Thought ${start + index}`, truncated: false, chars: 10 },
      createdAt: `2026-09-04T00:00:${String(start + index).padStart(2, "0")}.000Z`,
    }))
    mocks.activity.events = events(0)
    mocks.activity.hasEarlierEvents = true
    const { renderer, props } = render()

    expect(mocks.bottomAnchor.scrollIntoView).not.toHaveBeenCalled()
    expect(mocks.scrollNode.scrollTop).toBe(300)

    const scroller = renderer.container.querySelector('[data-testid="community-bot-audit-preview-scroll"]')!
    mocks.scrollNode.scrollTop = 0
    fireEvent.scroll(scroller)
    mocks.scrollNode.scrollHeight = 500
    mocks.activity.events = events(1)
    renderer.rerender(React.createElement(BotMarkSticker, props))
    expect(mocks.scrollNode.scrollTop).toBe(0)
    expect(renderer.container.querySelectorAll('[data-testid^="community-bot-audit-preview-row-"]'))
      .toHaveLength(10)
    expect(renderer.container.querySelectorAll(
      '[data-testid="community-bot-audit-preview-row-event_0"]',
    )).toHaveLength(0)

    mocks.scrollNode.scrollTop = 330
    fireEvent.scroll(scroller)
    mocks.scrollNode.scrollHeight = 800
    mocks.activity.events = events(2)
    renderer.rerender(React.createElement(BotMarkSticker, props))
    expect(mocks.scrollNode.scrollTop).toBe(800)
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
      kind: "text",
      payload: { text: "Thought 1", truncated: false, chars: 9 },
      createdAt: "2026-09-04T00:00:01.000Z",
    }]
    const { renderer, props } = render()

    mocks.activity.events = [{
      id: "event_2",
      kind: "text",
      payload: { text: "Thought 2", truncated: false, chars: 9 },
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

    expect(mocks.bottomAnchor.scrollIntoView).not.toHaveBeenCalled()
    expect(mocks.scrollNode.scrollTop).toBe(300)
  })

  it("shows up to three rich todo rows and a quiet overflow indicator", () => {
    mocks.result.marks = [
      mark("1", "**First** task with `code` and [Docs](https://example.com/marks) ||marked secret|| @Gus#1813"),
      mark("2", "    const kept = true"),
      mark("3", "   "),
      mark("4"),
    ]
    const { renderer, props } = render()
    const marksTab = renderer.container.querySelectorAll('[role="tab"]')[1]!
    fireEvent.click(marksTab)
    const rows = renderer.container.querySelectorAll(
      '[data-testid^="community-bot-mark-sticker-row-"]',
    )

    expect(rows).toHaveLength(3)
    expect(rows[1]!.querySelector("pre")).toHaveTextContent("const kept = true")
    expect(rows[2]).toHaveTextContent("Empty message")
    expect(renderer.container.textContent).toContain("First")
    expect(renderer.container.textContent).not.toContain("**First**")
    expect(renderer.container.textContent).toContain("Gus")
    const authorLine = rows[0]!.querySelector("[data-message-author-line]")!
    expect(authorLine.querySelector("button")).toBeNull()
    expect(authorLine.querySelector('[title="Gus"]')).toHaveTextContent("Gus")
    expect(authorLine.querySelector("time")).toHaveAttribute("datetime", "2026-09-04T00:00:00.000Z")
    const messageContent = rows[0]!.querySelector("[data-community-message-body]")!
    expect(messageContent.querySelector('[data-streamdown="strong"]')).toHaveTextContent("First")
    expect(messageContent.querySelector("code")).toHaveTextContent("code")
    expect(messageContent.querySelector('[title="@Gus"]')).toHaveTextContent("@Gus")
    const link = messageContent.querySelector("a")!
    expect(link).toHaveAttribute("href", "https://example.com/marks")
    link.addEventListener("click", (event) => event.preventDefault(), { once: true })
    fireEvent.click(link)
    fireEvent.click(renderer.getByRole("button", { name: "marked secret" }))
    expect(props.onOpenActivity).not.toHaveBeenCalled()
    expect(rows[0]!.querySelector("button button, button a, button [data-community-message-body]")).toBeNull()
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
    const footer = renderer.container.querySelector("footer")!
    expect(footer.textContent).not.toContain("running")
    expect(renderer.getByRole("status")).toHaveAccessibleName("Bot activity in progress")
    expect(footer.querySelector("time")).toBeNull()
    fireEvent.click(renderer.container.querySelectorAll('[role="tab"]')[1]!)
    expect(renderer.container.querySelector("footer")).toBe(footer)
    expect(footer.textContent).not.toContain("running")
    expect(footer.querySelector('[data-testid="community-bot-mark-sticker-stop"]')).toBe(stop)
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
    expect(missing.container.querySelector('[aria-label="Recent thoughts"]')).not.toBeNull()
    expect(missing.container.querySelector(
      '[data-testid="community-bot-mark-sticker-stop"]',
    )).not.toBeNull()
  })
})
