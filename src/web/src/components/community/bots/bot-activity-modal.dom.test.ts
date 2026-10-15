import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render } from "@/test/react-dom-harness"

const {
  auditState,
  auditHook,
  profileHook,
  fetchNextPage,
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
    isFetching: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    loadedPageCount: 1,
  },
  auditHook: vi.fn(),
  profileHook: vi.fn(),
  fetchNextPage: vi.fn(),
  sheetProps: { current: null as Record<string, unknown> | null },
}))
let scrollDescriptor: PropertyDescriptor | undefined
let bodyHeight = 300
let deferScrollEvents = false
let rowHeights = new Map<string, number>()
let bodyResizeObservers: Array<{ callback: ResizeObserverCallback; elements: Set<Element> }> = []

vi.mock("@/components/community/shell/community-sheet", () => ({
  CommunitySheet: ({
    children,
    bodyRef,
    footer,
    ...props
  }: React.PropsWithChildren<Record<string, unknown>>) => {
    sheetProps.current = props
    return React.createElement("community-sheet", props,
      React.createElement("div", { ref: bodyRef as React.Ref<HTMLDivElement>, "data-testid": "activity-body" }, children),
      footer as React.ReactNode,
    )
  },
}))

vi.mock("@/components/avatar", () => ({
  AgentAvatar: (props: Record<string, unknown>) => React.createElement("agent-avatar", props),
}))

vi.mock("@/lib/community-db/projections", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/community-db/projections")>(),
  useCanonicalCommunityProfile: (botId: string | undefined) => {
    profileHook(botId)
    return { presence: "online" }
  },
}))

vi.mock("@/hooks/community/use-bot-audit-log", () => ({
  useBotAuditLog: (botId: string | null) => {
    auditHook(botId)
    return { ...auditState, isFetching: auditState.isFetching || auditState.isFetchingNextPage, fetchNextPage }
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
  bot?: typeof bot
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onOpenChangeComplete?: (open: boolean) => void
}

function renderModal({
  bot: selectedBot = bot,
  open = true,
  onOpenChange = vi.fn(),
  onOpenChangeComplete = vi.fn(),
}: ModalOptions = {}) {
  const renderer = render(
    React.createElement(BotActivityModal, {
      bot: selectedBot,
      open,
      onOpenChange,
      onOpenChangeComplete,
    }),
  )
  return { renderer, onOpenChange, onOpenChangeComplete }
}

function updateModal(renderer: ReturnType<typeof render>, {
  bot: selectedBot = bot,
  open = true,
  onOpenChange = vi.fn(),
  onOpenChangeComplete = vi.fn(),
}: ModalOptions = {}, settle = true) {
  act(() => renderer.rerender(
    React.createElement(BotActivityModal, {
      bot: selectedBot,
      open,
      onOpenChange,
      onOpenChangeComplete,
    }),
  ))
  if (settle) act(() => vi.advanceTimersByTime(500))
}

function scrollBody(renderer: ReturnType<typeof render>, offset: number) {
  const root = renderer.getByTestId("activity-body")
  fireEvent.wheel(root, { deltaY: offset < root.scrollTop ? -20 : 20 })
  act(() => root.scrollTo({ top: offset }))
  act(() => vi.advanceTimersByTime(500))
  return root
}

function eventTop(renderer: ReturnType<typeof render>, id: string) {
  return renderer.container.querySelector<HTMLElement>(`[data-activity-event-id="${id}"] activity-row`)!.getBoundingClientRect().top
}

function events(count: number, day = "2026-08-27") {
  const start = Date.parse(`${day}T12:00:00.000Z`)
  return Array.from({ length: count }, (_, index) => event(`event-${index}`, new Date(start + index * 60_000).toISOString()))
}

function prepareOlderPage() {
  const initialPage = { events: [...auditState.events] }
  let finish!: (result: unknown) => void
  fetchNextPage.mockImplementationOnce(() => new Promise(resolvePage => { finish = resolvePage }))
  return async (pageEvents: ReturnType<typeof events>, failed = false) => {
    auditState.loadedPageCount = failed ? 1 : 2
    await act(async () => {
      finish({ isError: failed, data: { pages: failed ? [initialPage] : [initialPage, { events: pageEvents }] } })
    })
    act(() => vi.advanceTimersByTime(500))
  }
}

function resizeBody(height: number, settle = true) {
  bodyHeight = height
  act(() => {
    for (const observer of bodyResizeObservers) {
      const entries = [...observer.elements].filter(element => element.isConnected).map(target => ({
        target,
        borderBoxSize: [{ blockSize: (target as HTMLElement).offsetHeight, inlineSize: 672 }],
      } as unknown as ResizeObserverEntry))
      if (entries.length) observer.callback(entries, {} as ResizeObserver)
    }
    if (settle) vi.advanceTimersByTime(500)
  })
}

describe("BotActivityModal CommunitySheet contract", () => {
  beforeEach(() => {
    auditState.events = []
    auditState.isLoading = false
    auditState.isFetching = false
    auditState.hasNextPage = false
    auditState.isFetchingNextPage = false
    auditState.isFetchNextPageError = false
    auditState.loadedPageCount = 1
    auditHook.mockReset()
    profileHook.mockReset()
    fetchNextPage.mockReset()
    fetchNextPage.mockResolvedValue({ isError: false, data: { pages: [{ events: [] }] } })
    sheetProps.current = null
    bodyHeight = 300
    deferScrollEvents = false
    rowHeights = new Map()
    bodyResizeObservers = []
    vi.useFakeTimers()
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16))
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id))
    vi.stubGlobal("ResizeObserver", class {
      private record: typeof bodyResizeObservers[number]
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, elements: new Set() }
        bodyResizeObservers.push(this.record)
      }
      observe(element: Element) { this.record.elements.add(element) }
      unobserve(element: Element) { this.record.elements.delete(element) }
      disconnect() { this.record.elements.clear() }
    })
    const isRoot = (node: HTMLElement) => node.dataset.testid === "activity-body"
    const rowHeight = (node: HTMLElement) => {
      if (node.closest("[data-activity-date]")) return 33
      const row = node.closest<HTMLElement>("[data-activity-row-key]")
      const body = rowHeights.get(row?.dataset.activityEventId ?? "") ?? 44
      return body + (node === row && row.querySelector("[data-activity-date]") ? 33 : 0)
    }
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return isRoot(this) ? bodyHeight : rowHeight(this) })
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.clientHeight })
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => 672)
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => 672)
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return isRoot(this) ? Math.max(bodyHeight, Number.parseFloat(this.firstElementChild?.getAttribute("style")?.match(/height: ([\d.]+)px/)?.[1] ?? "0")) : rowHeight(this)
    })
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const row = this.closest<HTMLElement>("[data-activity-row-key]")
      const root = this.closest<HTMLElement>('[data-testid="activity-body"]')
      const transform = row?.style.transform ?? ""
      const start = transform.startsWith("translate3d(")
        ? Number.parseFloat(transform.split(",")[1])
        : Number.parseFloat(transform.match(/translateY\((-?[\d.]+)px\)/)?.[1] ?? "0")
      const suffix = row && this.closest("[data-activity-date]") ? rowHeights.get(row.dataset.activityEventId ?? "") ?? 44 : 0
      const sticky = this.closest("[data-activity-sticky-date]")
      return DOMRect.fromRect({ width: 672, height: this.clientHeight, y: isRoot(this) || sticky ? 0 : start + suffix - (root?.scrollTop ?? 0) })
    })
    scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo")
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: function (this: HTMLElement, options: ScrollToOptions | number) {
      if (typeof options === "number") return
      this.scrollTop = Math.max(0, Math.min(options.top ?? this.scrollTop, this.scrollHeight - this.clientHeight))
      if (deferScrollEvents) window.setTimeout(() => this.dispatchEvent(new Event("scroll")), 0)
      else this.dispatchEvent(new Event("scroll"))
    } })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollDescriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo")
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
    expect(populated.container.querySelectorAll("[data-activity-date]")).toHaveLength(2)
    expect(populated.container.querySelectorAll("[data-activity-row-key]")).toHaveLength(2)
    expect(populated.container.querySelector('[data-activity-row-key*="date:"]')).toBeNull()
    expect([...populated.container.querySelectorAll("activity-row")]
      .map((row) => row.getAttribute("data-event-id")))
      .toEqual(["old", "new"])
  })

  it.each([50, 100])("preserves the visible event at offset %i when a same-day older page prepends", async offset => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer, onOpenChange } = renderModal()
    const root = scrollBody(renderer, offset)
    const id = offset < 100 ? "event-0" : "event-1"
    const top = eventTop(renderer, id)
    expect(fetchNextPage).toHaveBeenCalledOnce()
    auditState.isFetchingNextPage = true
    updateModal(renderer, { onOpenChange })
    auditState.events = [
      ...auditState.events,
      event("old", "2026-08-27T11:00:00.000Z"),
    ]
    auditState.isFetchingNextPage = false
    updateModal(renderer, { onOpenChange })
    await completePage([event("old", "2026-08-27T11:00:00.000Z")])
    expect(eventTop(renderer, id)).toBe(top)
    expect(root.scrollTop).toBe(offset + 44)
  })

  it("pins a new live row only while the reader is near the tail", () => {
    auditState.events = events(30)
    const { renderer, onOpenChange } = renderModal()
    const root = scrollBody(renderer, 10_000)
    expect(root.scrollTop).toBe(root.scrollHeight - root.clientHeight)
    auditState.events = [
      ...auditState.events,
      event("two", "2026-08-27T13:01:00.000Z"),
    ]
    updateModal(renderer, { onOpenChange })
    expect(root.scrollTop).toBe(root.scrollHeight - root.clientHeight)
    scrollBody(renderer, 100)
    auditState.events = [
      ...auditState.events,
      event("three", "2026-08-27T12:02:00.000Z"),
    ]
    updateModal(renderer, { onOpenChange })
    expect(root.scrollTop).toBe(100)
  })

  it("windows a long log and reopens at its actual latest event", () => {
    auditState.events = events(120)
    const { renderer } = renderModal()
    act(() => vi.advanceTimersByTime(500))
    const root = renderer.getByTestId("activity-body")
    expect(root.scrollTop).toBe(root.scrollHeight - root.clientHeight)
    expect(renderer.container.querySelectorAll("activity-row").length).toBeLessThan(30)
    expect(renderer.container.querySelector('[data-event-id="event-119"]')).toBeInTheDocument()
    expect(renderer.container.querySelector('[data-event-id="event-0"]')).toBeNull()
    scrollBody(renderer, 100)
    updateModal(renderer, { open: false })
    updateModal(renderer, { open: true })
    expect(root.scrollTop).toBe(root.scrollHeight - root.clientHeight)
    expect(renderer.container.querySelector('[data-event-id="event-119"]')).toBeInTheDocument()
  })

  it("opens at the latest event after the body changes from zero to positive height", () => {
    auditState.events = events(120)
    bodyHeight = 0
    const { renderer } = renderModal()
    const root = renderer.getByTestId("activity-body")
    act(() => vi.advanceTimersByTime(500))
    expect(root.scrollTop).toBe(0)
    resizeBody(300)
    expect(root.scrollTop).toBe(root.scrollHeight - root.clientHeight)
    expect(renderer.container.querySelector('[data-event-id="event-119"]')).toBeInTheDocument()
  })

  it("selects the new bot's latest event when the mounted modal switches identity", () => {
    auditState.events = events(120)
    const { renderer } = renderModal()
    scrollBody(renderer, 100)
    auditState.events = events(80).map(item => ({ ...item, id: `other-${item.id}` }))
    updateModal(renderer, { bot: { ...bot, id: "bot-2", name: "Other Bot" } })
    const root = renderer.getByTestId("activity-body")
    expect(auditHook).toHaveBeenLastCalledWith("bot-2")
    expect(root.scrollTop).toBe(root.scrollHeight - root.clientHeight)
    expect(renderer.container.querySelector('[data-event-id="other-event-79"]')).toBeInTheDocument()
    expect(renderer.container.querySelector('[data-activity-row-key^="bot-1:"]')).toBeNull()
    expect(renderer.container.querySelector('[data-event-id="event-0"]')).toBeNull()
  })

  it("keeps a reading event through viewport resize and a cross-day live append", () => {
    auditState.events = events(120)
    const { renderer } = renderModal()
    scrollBody(renderer, 600)
    const top = eventTop(renderer, "event-15")
    const date = renderer.container.querySelector("[data-activity-sticky-date]")!.getAttribute("data-activity-sticky-date")
    resizeBody(240)
    expect(eventTop(renderer, "event-15")).toBe(top)
    auditState.events = [...auditState.events, event("next-day", "2026-08-28T12:00:00.000Z")]
    updateModal(renderer)
    expect(eventTop(renderer, "event-15")).toBe(top)
    expect(renderer.container.querySelector("[data-activity-sticky-date]")!.getAttribute("data-activity-sticky-date")).toBe(date)
    scrollBody(renderer, 10_000)
    expect(renderer.container.querySelector('[data-event-id="next-day"]')).toBeInTheDocument()
  })

  it("does not restore a completed request from before the modal reopened", async () => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    scrollBody(renderer, 0)
    auditState.isFetchingNextPage = true
    updateModal(renderer)
    updateModal(renderer, { open: false })
    updateModal(renderer, { open: true })
    scrollBody(renderer, 600)
    const top = eventTop(renderer, "event-15")
    auditState.events = [...auditState.events, event("old", "2026-08-27T11:00:00.000Z")]
    auditState.isFetchingNextPage = false
    updateModal(renderer)
    await completePage([event("old", "2026-08-27T11:00:00.000Z")])
    expect(eventTop(renderer, "event-15")).toBe(top)
  })

  it("keeps a reader's event when a late live event inserts in the middle", () => {
    auditState.events = events(30)
    const { renderer } = renderModal()
    scrollBody(renderer, 600)
    const top = eventTop(renderer, "event-15")
    auditState.events = [...auditState.events, event("late", "2026-08-27T12:01:30.000Z")]
    updateModal(renderer)
    expect(eventTop(renderer, "event-15")).toBe(top)
    expect(renderer.container.querySelector('[data-event-id="event-29"]')).toBeNull()
  })

  it("does not restore an old page anchor after the reader takes over", async () => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    scrollBody(renderer, 0)
    auditState.isFetchingNextPage = true
    updateModal(renderer)
    scrollBody(renderer, 600)
    const top = eventTop(renderer, "event-15")
    auditState.events = [...auditState.events, event("old", "2026-08-27T11:00:00.000Z")]
    auditState.isFetchingNextPage = false
    updateModal(renderer)
    await completePage([event("old", "2026-08-27T11:00:00.000Z")])
    expect(eventTop(renderer, "event-15")).toBe(top)
  })

  it("lets a wheel gesture cancel the native target without a current-offset write", () => {
    auditState.events = events(120)
    const { renderer } = renderModal()
    const root = renderer.getByTestId("activity-body")
    const scrollTo = vi.spyOn(root, "scrollTo")
    fireEvent.wheel(root, { deltaY: -20 })
    expect(scrollTo).not.toHaveBeenCalled()
    act(() => root.scrollTo({ top: 100 }))
    act(() => vi.advanceTimersByTime(500))
    expect(root.scrollTop).toBe(100)
    expect(scrollTo).toHaveBeenCalledOnce()
  })

  it("keeps the reader's event when a measured earlier row grows", () => {
    auditState.events = events(30)
    const { renderer } = renderModal()
    const root = scrollBody(renderer, 600)
    const top = eventTop(renderer, "event-15")
    rowHeights.set("event-10", 72)
    resizeBody(300)
    expect(eventTop(renderer, "event-15")).toBe(top)
    expect(root.scrollTop).toBe(628)
  })


  it("pages from the native overscan before physical top, without an input classifier or sticky-date demand", () => {
    auditState.events = events(50)
    auditState.hasNextPage = true
    const { renderer } = renderModal()
    act(() => vi.advanceTimersByTime(500))
    expect(fetchNextPage).not.toHaveBeenCalled()
    const root = renderer.getByTestId("activity-body")
    expect(renderer.container.querySelector("[data-activity-sticky-date]")).toBeInTheDocument()
    act(() => root.scrollTo({ top: 340 }))
    expect(root.scrollTop).toBeGreaterThan(160)
    expect(fetchNextPage).toHaveBeenCalledOnce()
    expect(fetchNextPage).toHaveBeenCalledWith({ cancelRefetch: false })
    expect(renderer.queryByText("Scroll up for older")).not.toBeInTheDocument()
    expect(renderer.queryByText("Loading older")).not.toBeInTheDocument()
    expect(renderer.queryByText("Beginning of log")).not.toBeInTheDocument()
  })

  it("fills a short native window without requiring a reader gesture and gates busy, error and exhausted cursors", () => {
    auditState.events = events(3)
    auditState.hasNextPage = true
    auditState.isFetching = true
    const { renderer } = renderModal()
    expect(fetchNextPage).not.toHaveBeenCalled()
    auditState.isFetching = false
    updateModal(renderer)
    expect(fetchNextPage).toHaveBeenCalledOnce()
    auditState.isFetchingNextPage = true
    updateModal(renderer)
    expect(fetchNextPage).toHaveBeenCalledOnce()
    auditState.isFetchingNextPage = false
    auditState.isFetchNextPageError = true
    updateModal(renderer)
    expect(fetchNextPage).toHaveBeenCalledOnce()
    const retry = renderer.getByRole("button", { name: "Retry older" })
    expect(renderer.getByTestId("activity-body").contains(retry)).toBe(false)
    fireEvent.click(retry)
    expect(fetchNextPage).toHaveBeenCalledTimes(2)
    auditState.isFetchNextPageError = false
    auditState.hasNextPage = false
    updateModal(renderer)
    expect(fetchNextPage).toHaveBeenCalledTimes(2)
    expect(renderer.queryByRole("button", { name: "Retry older" })).not.toBeInTheDocument()
  })

  it.each([
    { crossDay: false, offset: 0, measuredHeight: 44 },
    { crossDay: false, offset: 80, measuredHeight: 44 },
    { crossDay: true, offset: 0, measuredHeight: 44 },
    { crossDay: true, offset: 80, measuredHeight: 44 },
    { crossDay: false, offset: 0, measuredHeight: 33 },
    { crossDay: false, offset: 80, measuredHeight: 33 },
    { crossDay: true, offset: 0, measuredHeight: 33 },
    { crossDay: true, offset: 80, measuredHeight: 33 },
  ])("keeps actual event content through two older pages at $offset, cross-day $crossDay, measured $measuredHeight", async ({ crossDay, offset, measuredHeight }) => {
    auditState.events = events(50)
    for (const item of auditState.events) rowHeights.set(item.id, measuredHeight)
    auditState.hasNextPage = true
    const { renderer } = renderModal()
    for (const [index, target] of [offset, 80].entries()) {
      const completePage = prepareOlderPage()
      const root = scrollBody(renderer, target)
      const anchor = [...renderer.container.querySelectorAll<HTMLElement>("activity-row")].find(row => {
        const rect = row.getBoundingClientRect()
        return rect.top >= 33 && rect.bottom <= root.clientHeight
      })!
      const id = anchor.closest<HTMLElement>("[data-activity-event-id]")!.dataset.activityEventId!
      const top = anchor.getBoundingClientRect().top
      const visibleDate = renderer.container.querySelector("[data-activity-sticky-date]")!.getAttribute("data-activity-sticky-date")
      expect(fetchNextPage).toHaveBeenCalledTimes(index + 1)
      auditState.isFetchingNextPage = true
      updateModal(renderer)
      const start = Date.parse(crossDay ? `2026-08-${26 - index}T12:00:00.000Z` : `2026-08-27T${11 - index}:00:00.000Z`)
      const page = Array.from({ length: 50 }, (_, ordinal) => event(`older-${index}-${ordinal}`, new Date(start + ordinal * 60_000).toISOString()))
      for (const item of page) rowHeights.set(item.id, measuredHeight)
      auditState.events = [...auditState.events, ...page]
      auditState.isFetchingNextPage = false
      updateModal(renderer)
      await completePage(page)
      expect(eventTop(renderer, id)).toBe(top)
      expect(root.scrollTop).toBeGreaterThan(target)
      expect(fetchNextPage).toHaveBeenCalledTimes(index + 1)
      expect(renderer.container.querySelector("[data-activity-sticky-date]")).toHaveAttribute("data-activity-sticky-date", visibleDate)
      for (const row of renderer.container.querySelectorAll<HTMLElement>("[data-activity-row-key]")) {
        expect(row.dataset.activityEventId).toBeTruthy()
        expect(row.dataset.activityRowKey).toBe(`bot-1:event:${row.dataset.activityEventId}`)
      }
    }
  })

  it.each([
    { crossDay: false, offset: 0, measuredHeight: 44 },
    { crossDay: false, offset: 80, measuredHeight: 44 },
    { crossDay: true, offset: 0, measuredHeight: 44 },
    { crossDay: true, offset: 80, measuredHeight: 44 },
    { crossDay: false, offset: 0, measuredHeight: 33 },
    { crossDay: false, offset: 80, measuredHeight: 33 },
    { crossDay: true, offset: 0, measuredHeight: 33 },
    { crossDay: true, offset: 80, measuredHeight: 33 },
  ])("keeps event Y with deferred scroll events at $offset, cross-day $crossDay, measured $measuredHeight", ({ crossDay, offset, measuredHeight }) => {
    deferScrollEvents = true
    auditState.events = events(50)
    for (const item of auditState.events) rowHeights.set(item.id, measuredHeight)
    const { renderer } = renderModal()
    act(() => vi.advanceTimersByTime(500))
    for (const [index, target] of [offset, 80].entries()) {
      const root = scrollBody(renderer, target)
      expect(root.scrollTop).toBe(target)
      const anchor = [...renderer.container.querySelectorAll<HTMLElement>("activity-row")].find(row => {
        const rect = row.getBoundingClientRect()
        return rect.top >= 33 && rect.bottom <= root.clientHeight
      })!
      const id = anchor.closest<HTMLElement>("[data-activity-event-id]")!.dataset.activityEventId!
      const top = anchor.getBoundingClientRect().top
      const start = Date.parse(crossDay ? `2026-08-${26 - index}T12:00:00.000Z` : `2026-08-27T${11 - index}:00:00.000Z`)
      const page = Array.from({ length: 50 }, (_, ordinal) => event(`deferred-${index}-${ordinal}`, new Date(start + ordinal * 60_000).toISOString()))
      for (const item of page) rowHeights.set(item.id, measuredHeight)
      auditState.events = [...auditState.events, ...page]
      auditState.loadedPageCount += 1
      updateModal(renderer)
      expect(eventTop(renderer, id)).toBe(top)
      expect(root.scrollTop).toBeGreaterThan(target)
      expect(fetchNextPage).not.toHaveBeenCalled()
    }
  })


  it("updates the visible date at a payload boundary before the native range changes", () => {
    deferScrollEvents = true
    auditState.events = [...events(10), ...events(40, "2026-08-28").map(item => ({ ...item, id: `next-${item.id}` }))]
    const { renderer } = renderModal()
    act(() => vi.advanceTimersByTime(500))
    const root = renderer.getByTestId("activity-body")
    fireEvent.wheel(root, { deltaY: 434 })
    act(() => { root.scrollTo({ top: 434 }); vi.advanceTimersByTime(0) })
    expect(root.scrollTop).toBe(434)
    expect(renderer.container.querySelector("[data-activity-sticky-date]")).toHaveAttribute("data-activity-sticky-date", "2026-7-27")
    act(() => { root.scrollTo({ top: 444 }); vi.advanceTimersByTime(0) })
    expect(root.scrollTop).toBe(444)
    expect(renderer.container.querySelector("[data-activity-sticky-date]")).toHaveAttribute("data-activity-sticky-date", "2026-7-28")
  })

})
