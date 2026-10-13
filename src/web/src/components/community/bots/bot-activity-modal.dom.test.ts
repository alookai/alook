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
let rowHeights = new Map<string, number>()
let bodyResizeObservers: Array<{ callback: ResizeObserverCallback; elements: Set<Element> }> = []

vi.mock("@/components/community/shell/community-sheet", () => ({
  CommunitySheet: ({
    children,
    bodyRef,
    ...props
  }: React.PropsWithChildren<Record<string, unknown>>) => {
    sheetProps.current = props
    return React.createElement("community-sheet", props,
      React.createElement("div", { ref: bodyRef as React.Ref<HTMLDivElement>, "data-testid": "activity-body" }, children),
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
  return renderer.container.querySelector<HTMLElement>(`[data-activity-event-id="${id}"]`)!.getBoundingClientRect().top
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
      const row = node.closest<HTMLElement>("[data-activity-row-key]")
      return row?.dataset.activityRowKey?.includes(":date:") ? 24 : rowHeights.get(row?.dataset.activityEventId ?? "") ?? 44
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
      const start = Number.parseFloat(row?.style.transform.match(/translateY\((-?[\d.]+)px\)/)?.[1] ?? "0")
      return DOMRect.fromRect({ width: 672, height: this.clientHeight, y: isRoot(this) ? 0 : start - (root?.scrollTop ?? 0) })
    })
    scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo")
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: function (this: HTMLElement, options: ScrollToOptions | number) {
      if (typeof options === "number") return
      this.scrollTop = Math.max(0, Math.min(options.top ?? this.scrollTop, this.scrollHeight - this.clientHeight))
      this.dispatchEvent(new Event("scroll"))
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
    expect(populated.container.querySelectorAll('[data-activity-row-key*="date:"]')).toHaveLength(2)
    expect([...populated.container.querySelectorAll("activity-row")]
      .map((row) => row.getAttribute("data-event-id")))
      .toEqual(["old", "new"])
  })

  it.each([0, 50, 100])("preserves the visible event at offset %i when a same-day older page prepends", async offset => {
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

  it.each(["2026-08-27", "2026-08-26"])("keeps a single Home reader when its pending page crosses into the header before a %s prepend", async day => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer, onOpenChange } = renderModal()
    const root = scrollBody(renderer, 200)
    root.focus()
    expect(document.activeElement).toBe(root)
    fireEvent.keyDown(document.activeElement!, { key: "Home" })
    act(() => {
      root.scrollTop = 100
      fireEvent.scroll(root)
      vi.advanceTimersByTime(16)
    })
    expect(fetchNextPage).toHaveBeenCalledOnce()
    auditState.isFetchingNextPage = true
    updateModal(renderer, { onOpenChange }, false)
    act(() => {
      root.scrollTop = 0
      fireEvent.scroll(root)
      vi.advanceTimersByTime(16)
    })
    const top = eventTop(renderer, "event-0")
    expect(root.scrollTop).toBe(0)
    const start = Date.parse(`${day}T11:00:00.000Z`)
    const older = Array.from({ length: 50 }, (_, index) => event(`older-${index}`, new Date(start + index * 60_000).toISOString()))
    auditState.events = [...auditState.events, ...older]
    auditState.loadedPageCount = 2
    auditState.isFetchingNextPage = false
    updateModal(renderer, { onOpenChange }, false)
    await completePage(older)
    expect(renderer.container.querySelector('[data-activity-event-id="event-0"]')).toBeInTheDocument()
    expect(eventTop(renderer, "event-0")).toBe(top)
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })

  it("uses the measured header when one pending Home continues across its size change", async () => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer, onOpenChange } = renderModal()
    const root = scrollBody(renderer, 200)
    root.focus()
    fireEvent.keyDown(document.activeElement!, { key: "Home" })
    act(() => {
      root.scrollTop = 100
      fireEvent.scroll(root)
      vi.advanceTimersByTime(16)
    })
    auditState.isFetchingNextPage = true
    updateModal(renderer, { onOpenChange }, false)
    rowHeights.set("", 60)
    act(() => {
      for (const observer of bodyResizeObservers) {
        const entries = [...observer.elements].filter(element => element.isConnected).map(target => ({
          target,
          borderBoxSize: [{ blockSize: (target as HTMLElement).offsetHeight, inlineSize: 672 }],
        } as unknown as ResizeObserverEntry))
        if (entries.length) observer.callback(entries, {} as ResizeObserver)
      }
      vi.advanceTimersByTime(16)
      root.scrollTop = 0
      fireEvent.scroll(root)
      vi.advanceTimersByTime(16)
    })
    const top = eventTop(renderer, "event-0")
    expect(top).toBe(84)
    const older = Array.from({ length: 50 }, (_, index) => event(`older-${index}`, new Date(Date.parse("2026-08-27T11:00:00.000Z") + index * 60_000).toISOString()))
    auditState.events = [...auditState.events, ...older]
    auditState.loadedPageCount = 2
    auditState.isFetchingNextPage = false
    updateModal(renderer, { onOpenChange }, false)
    await completePage(older)
    expect(renderer.container.querySelector('[data-activity-event-id="event-0"]')).toBeInTheDocument()
    expect(eventTop(renderer, "event-0")).toBe(top)
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })

  it("keeps an accepted old event across live arrivals before and after late Home qualification", async () => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer, onOpenChange } = renderModal()
    const root = scrollBody(renderer, 200)
    root.focus()
    fireEvent.keyDown(document.activeElement!, { key: "Home" })
    act(() => {
      root.scrollTop = 100
      fireEvent.scroll(root)
      vi.advanceTimersByTime(16)
    })
    auditState.isFetchingNextPage = true
    auditState.events = [...auditState.events, event("first-live", "2026-08-27T11:59:00.000Z")]
    updateModal(renderer, { onOpenChange }, false)
    act(() => {
      root.scrollTop = 0
      fireEvent.scroll(root)
      vi.advanceTimersByTime(16)
    })
    const top = eventTop(renderer, "event-0")
    auditState.events = [...auditState.events, event("second-live", "2026-08-27T11:59:30.000Z")]
    updateModal(renderer, { onOpenChange }, false)
    const older = Array.from({ length: 50 }, (_, index) => event(`older-${index}`, new Date(Date.parse("2026-08-27T11:00:00.000Z") + index * 60_000).toISOString()))
    auditState.events = [...auditState.events, ...older]
    auditState.loadedPageCount = 2
    auditState.isFetchingNextPage = false
    updateModal(renderer, { onOpenChange }, false)
    await completePage(older)
    expect(renderer.container.querySelector('[data-activity-event-id="event-0"]')).toBeInTheDocument()
    expect(eventTop(renderer, "event-0")).toBe(top)
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })

  it("yields a late Home header qualification to a new reader input before the old reply", async () => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer, onOpenChange } = renderModal()
    const root = scrollBody(renderer, 200)
    root.focus()
    fireEvent.keyDown(document.activeElement!, { key: "Home" })
    act(() => {
      root.scrollTop = 100
      fireEvent.scroll(root)
      vi.advanceTimersByTime(16)
    })
    auditState.isFetchingNextPage = true
    updateModal(renderer, { onOpenChange }, false)
    act(() => {
      root.scrollTop = 0
      fireEvent.scroll(root)
      vi.advanceTimersByTime(16)
    })
    scrollBody(renderer, 600)
    const top = eventTop(renderer, "event-15")
    const older = Array.from({ length: 50 }, (_, index) => event(`older-${index}`, new Date(Date.parse("2026-08-27T11:00:00.000Z") + index * 60_000).toISOString()))
    auditState.events = [...auditState.events, ...older]
    auditState.loadedPageCount = 2
    auditState.isFetchingNextPage = false
    updateModal(renderer, { onOpenChange }, false)
    await completePage(older)
    expect(eventTop(renderer, "event-15")).toBe(top)
    expect(root.scrollTop).toBeGreaterThan(600)
    expect(fetchNextPage).toHaveBeenCalledOnce()
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

  it.each([0, 50, 150])("keeps the event at offset %i when an older day and its divider prepend", async offset => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    scrollBody(renderer, offset)
    const id = offset < 100 ? "event-0" : "event-2"
    const top = eventTop(renderer, id)
    auditState.isFetchingNextPage = true
    updateModal(renderer)
    auditState.events = [...auditState.events, event("previous-day", "2026-08-26T12:00:00.000Z")]
    auditState.isFetchingNextPage = false
    updateModal(renderer)
    await completePage([event("previous-day", "2026-08-26T12:00:00.000Z")])
    expect(eventTop(renderer, id)).toBe(top)
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

  it("retires a zero-row older response before a later live event", async () => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    fetchNextPage.mockResolvedValue({ isError: false, data: { pages: [{ events: auditState.events }, { events: [] }] } })
    const { renderer } = renderModal()
    const root = renderer.getByTestId("activity-body")
    await act(async () => {
      fireEvent.wheel(root, { deltaY: -20 })
      root.scrollTo({ top: 0 })
      vi.advanceTimersByTime(500)
    })
    auditState.events = [...auditState.events, event("late-earlier", "2026-08-27T11:00:00.000Z")]
    updateModal(renderer)
    expect(root.scrollTop).toBe(0)
  })

  it.each([
    { offset: 0, liveAt: "2026-08-27T11:00:00.000Z", pageAt: "2026-08-27T10:00:00.000Z" },
    { offset: 50, liveAt: "2026-08-26T12:00:00.000Z", pageAt: "2026-08-27T11:00:00.000Z" },
  ])("keeps the header-fold anchor at $offset until its older request completes after an earlier live event", async ({ offset, liveAt, pageAt }) => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    const root = scrollBody(renderer, offset)
    const top = eventTop(renderer, "event-0")
    auditState.isFetchingNextPage = true
    updateModal(renderer)
    auditState.events = [...auditState.events, event("earlier-live", liveAt)]
    updateModal(renderer)
    auditState.events = [...auditState.events, event("older-page", pageAt)]
    auditState.isFetchingNextPage = false
    updateModal(renderer)
    await completePage([event("older-page", pageAt)])
    expect(eventTop(renderer, "event-0")).toBe(top)
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })

  it.each([false, true])("retires a completed older request without new rows after an earlier live event (failed: %s)", async failed => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    const root = scrollBody(renderer, 0)
    auditState.isFetchingNextPage = true
    updateModal(renderer)
    auditState.events = [...auditState.events, event("earlier-live", "2026-08-27T11:00:00.000Z")]
    updateModal(renderer)
    auditState.isFetchingNextPage = false
    updateModal(renderer)
    await completePage([], failed)
    expect(root.scrollTop).toBe(0)
    auditState.events = [...auditState.events, event("later-live", "2026-08-27T10:00:00.000Z")]
    updateModal(renderer)
    expect(root.scrollTop).toBe(0)
  })

  it("loads from the actual upward top band, not initial positioning or a retained sticky date", () => {
    auditState.events = events(120)
    auditState.hasNextPage = true
    const { renderer } = renderModal()
    act(() => vi.advanceTimersByTime(500))
    const root = renderer.getByTestId("activity-body")
    expect(root.scrollTop).toBe(root.scrollHeight - root.clientHeight)
    expect(fetchNextPage).not.toHaveBeenCalled()
    scrollBody(renderer, 600)
    expect(renderer.container.querySelector('[data-activity-row-key*="date:"]')).toBeInTheDocument()
    expect(fetchNextPage).not.toHaveBeenCalled()
    scrollBody(renderer, 161)
    expect(fetchNextPage).not.toHaveBeenCalled()
    scrollBody(renderer, 160)
    expect(fetchNextPage).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
    auditState.isFetchingNextPage = true
    updateModal(renderer)
    expect(renderer.getByText("Loading older")).toBeInTheDocument()
    scrollBody(renderer, 100)
    expect(fetchNextPage).toHaveBeenCalledOnce()
    auditState.isFetchingNextPage = false
    auditState.hasNextPage = false
    updateModal(renderer)
    scrollBody(renderer, 0)
    expect(renderer.getByText("Beginning of log")).toBeInTheDocument()
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })

  it("does not page at zero height or fill historical pages on a cached reopen", () => {
    auditState.events = events(120)
    auditState.hasNextPage = true
    bodyHeight = 0
    const { renderer } = renderModal()
    expect(fetchNextPage).not.toHaveBeenCalled()
    resizeBody(300)
    const root = renderer.getByTestId("activity-body")
    expect(root.scrollTop).toBe(root.scrollHeight - root.clientHeight)
    expect(fetchNextPage).not.toHaveBeenCalled()
    scrollBody(renderer, 600)
    updateModal(renderer, { open: false })
    updateModal(renderer)
    expect(root.scrollTop).toBe(root.scrollHeight - root.clientHeight)
    expect(fetchNextPage).not.toHaveBeenCalled()
  })

  it.each([false, true])("waits for an ongoing query fetch before the next upward action (older fetch: %s)", async older => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    auditState.isFetching = true
    auditState.isFetchingNextPage = older
    const { renderer } = renderModal()
    scrollBody(renderer, 0)
    expect(fetchNextPage).not.toHaveBeenCalled()
    auditState.isFetching = false
    auditState.isFetchingNextPage = false
    updateModal(renderer)
    expect(fetchNextPage).not.toHaveBeenCalled()
    scrollBody(renderer, 10)
    await act(async () => {
      const root = renderer.getByTestId("activity-body")
      fireEvent.wheel(root, { deltaY: -20 })
      root.scrollTo({ top: 0 })
    })
    expect(fetchNextPage).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
  })

  it.each(["wheel", "key", "touch"])("loads one short-list page only after an upward %s gesture", async gesture => {
    auditState.events = events(2)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    act(() => vi.advanceTimersByTime(500))
    expect(renderer.queryByText("Scroll up for older")).not.toBeInTheDocument()
    expect(renderer.queryByText("Loading older")).not.toBeInTheDocument()
    expect(renderer.queryByRole("button", { name: "Retry older" })).not.toBeInTheDocument()
    const root = renderer.getByTestId("activity-body")
    expect(root.scrollTop).toBe(0)
    expect(fetchNextPage).not.toHaveBeenCalled()
    if (gesture === "wheel") {
      fireEvent.wheel(root, { deltaY: 20 })
      expect(fetchNextPage).not.toHaveBeenCalled()
      fireEvent.wheel(root, { deltaY: -20 })
    } else if (gesture === "key") {
      const entry = renderer.getByRole("region", { name: "Activity log" })
      expect(entry).toHaveAttribute("tabindex", "0")
      act(() => entry.focus())
      expect(entry).toHaveFocus()
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" })
      expect(fetchNextPage).not.toHaveBeenCalled()
      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" })
    } else {
      fireEvent.touchStart(root, { touches: [{ clientY: 100 }] })
      fireEvent.touchMove(root, { touches: [{ clientY: 80 }] })
      expect(fetchNextPage).not.toHaveBeenCalled()
      fireEvent.touchMove(root, { touches: [{ clientY: 110 }] })
      fireEvent.touchEnd(root, { touches: [] })
    }
    expect(fetchNextPage).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
    const older = event("short-old", "2026-08-27T11:00:00.000Z")
    auditState.events = [...auditState.events, older]
    await completePage([older])
    updateModal(renderer)
    expect(fetchNextPage).toHaveBeenCalledOnce()
    expect(auditState.hasNextPage).toBe(true)
  })

  it("preserves failed-page data and retries only from the explicit action", async () => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const failPage = prepareOlderPage()
    const { renderer } = renderModal()
    const root = scrollBody(renderer, 0)
    auditState.isFetchNextPageError = true
    await failPage([], true)
    updateModal(renderer)
    expect(renderer.getByRole("button", { name: "Retry older" })).toBeEnabled()
    expect(renderer.container.querySelector('[data-event-id="event-0"]')).toBeInTheDocument()
    fireEvent.wheel(root, { deltaY: -20 })
    fireEvent.keyDown(root, { key: "Home" })
    updateModal(renderer)
    expect(fetchNextPage).toHaveBeenCalledOnce()
    const completePage = prepareOlderPage()
    fireEvent.click(renderer.getByRole("button", { name: "Retry older" }))
    expect(fetchNextPage).toHaveBeenCalledTimes(2)
    auditState.isFetchingNextPage = true
    updateModal(renderer)
    expect(renderer.getByRole("button", { name: "Loading older" })).toBeDisabled()
    const older = event("retry-old", "2026-08-27T11:00:00.000Z")
    auditState.events = [...auditState.events, older]
    auditState.isFetchingNextPage = false
    auditState.isFetchNextPageError = false
    await completePage([older])
    updateModal(renderer)
    expect(renderer.queryByRole("button", { name: "Retry older" })).not.toBeInTheDocument()
    expect(renderer.queryByText("Scroll up for older")).not.toBeInTheDocument()
    expect(renderer.container.querySelector('[data-event-id="event-0"]')).toBeInTheDocument()
    expect(fetchNextPage).toHaveBeenCalledTimes(2)
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

  it.each([false, true])("does not page from native row shrink without user scrolling (armed input: %s)", async armed => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const { renderer } = renderModal()
    const root = scrollBody(renderer, 190)
    const top = eventTop(renderer, "event-3")
    expect(fetchNextPage).not.toHaveBeenCalled()
    if (armed) fireEvent.wheel(root, { deltaY: -20 })

    rowHeights.set("event-0", 8)
    resizeBody(300)

    expect(root.scrollTop).toBe(154)
    expect(eventTop(renderer, "event-3")).toBe(top)
    expect(fetchNextPage).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.wheel(root, { deltaY: -20 })
      root.scrollTo({ top: 150 })
    })
    expect(fetchNextPage).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
  })

  it("requires input for raw offset movement and consumes one ongoing wheel gesture", async () => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const { renderer } = renderModal()
    const root = renderer.getByTestId("activity-body")
    act(() => vi.advanceTimersByTime(500))
    act(() => root.scrollTo({ top: 150 }))
    act(() => vi.advanceTimersByTime(500))
    expect(fetchNextPage).not.toHaveBeenCalled()
    scrollBody(renderer, 600)
    await act(async () => {
      fireEvent.wheel(root, { deltaY: -20 })
      root.scrollTo({ top: 300 })
      vi.advanceTimersByTime(50)
      root.scrollTo({ top: 150 })
    })
    expect(fetchNextPage).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
    act(() => root.scrollTo({ top: 100 }))
    act(() => vi.advanceTimersByTime(500))
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })

  it.each([0, 50].flatMap(offset => [32, 60].flatMap(height => ["before", "after", "batched"].map(order => ({ offset, height, order })))))
    ("keeps the net header target at $offset through height $height and live $order measurement", async ({ offset, height, order }) => {
      auditState.events = events(50)
      auditState.hasNextPage = true
      const completePage = prepareOlderPage()
      const { renderer } = renderModal()
      const root = scrollBody(renderer, offset)
      auditState.isFetchingNextPage = true
      updateModal(renderer, {}, false)
      act(() => vi.advanceTimersByTime(150))
      const original = eventTop(renderer, "event-0")
      expect(original).toBe(68 - offset)
      const addLive = () => {
        auditState.events = [...auditState.events, event("earlier-live", "2026-08-27T11:00:00.000Z")]
        updateModal(renderer, {}, false)
      }
      if (order === "before") addLive()
      rowHeights.set("", height)
      if (order === "batched") act(() => {
        addLive()
        resizeBody(300, false)
      })
      else resizeBody(300, false)
      if (order === "after") addLive()
      const expected = offset === 0 ? height + 24 : original
      expect(root.scrollTop).toBe(offset === 0 ? 0 : offset + height - 44)
      expect(eventTop(renderer, "event-0")).toBe(expected + 44)
      resizeBody(300, false)
      resizeBody(300, false)
      auditState.events = [...auditState.events]
      updateModal(renderer, {}, false)
      expect(fetchNextPage).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
      const older = event("older-page", "2026-08-27T11:30:00.000Z")
      auditState.events = [...auditState.events, older]
      auditState.isFetchingNextPage = false
      updateModal(renderer, {}, false)
      await completePage([older])
      updateModal(renderer)
      expect(eventTop(renderer, "event-0")).toBe(expected)
      expect(fetchNextPage).toHaveBeenCalledOnce()
    })

  it.each([0, 50])("keeps the captured target at %i when an earlier live day replaces the header band", async offset => {
    auditState.events = events(50)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    const root = scrollBody(renderer, offset)
    const top = eventTop(renderer, "event-0")
    auditState.isFetchingNextPage = true
    updateModal(renderer, {}, false)
    act(() => vi.advanceTimersByTime(150))
    auditState.events = [...auditState.events, event("earlier-day-live", "2026-08-26T12:00:00.000Z")]
    updateModal(renderer, {}, false)
    rowHeights.set("", 60)
    resizeBody(300, false)
    act(() => root.scrollTo({ top: 0 }))
    const older = event("older-page", "2026-08-27T11:00:00.000Z")
    auditState.events = [...auditState.events, older]
    auditState.isFetchingNextPage = false
    updateModal(renderer, {}, false)
    await completePage([older])
    updateModal(renderer)
    expect(eventTop(renderer, "event-0")).toBe(top)
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })

  it("rejects a changed prefix of the same later date band", async () => {
    auditState.events = events(50)
    const previousDay = new Date(auditState.events[0]!.createdAt)
    previousDay.setDate(previousDay.getDate() - 1)
    previousDay.setHours(12, 0, 0, 0)
    const liveAt = new Date(previousDay)
    liveAt.setHours(11)
    auditState.events = [event("prefix", previousDay.toISOString()), ...auditState.events]
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    const root = scrollBody(renderer, 120)
    const top = eventTop(renderer, "event-0")
    expect(top).toBe(16)
    auditState.isFetchingNextPage = true
    updateModal(renderer, {}, false)
    act(() => vi.advanceTimersByTime(150))
    auditState.events = [...auditState.events, event("prefix-live", liveAt.toISOString())]
    updateModal(renderer, {}, false)
    expect(root.scrollTop).toBe(164)
    expect(eventTop(renderer, "event-0")).toBe(top)
    act(() => root.scrollTo({ top: 160 }))
    expect(eventTop(renderer, "event-0")).toBe(20)
    const older = event("older-page", "2026-08-25T12:00:00.000Z")
    auditState.events = [...auditState.events, older]
    auditState.isFetchingNextPage = false
    updateModal(renderer, {}, false)
    await completePage([older])
    updateModal(renderer)
    expect(eventTop(renderer, "event-0")).toBe(top)
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })

  it("keeps the old target while its event is unmounted behind live rows", async () => {
    auditState.events = events(50)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    const root = scrollBody(renderer, 0)
    auditState.isFetchingNextPage = true
    updateModal(renderer, {}, false)
    const live = Array.from({ length: 40 }, (_, index) => event(
      `earlier-live-${index}`,
      new Date(Date.parse("2026-08-27T11:00:00.000Z") + index * 1000).toISOString(),
    ))
    auditState.events = [...auditState.events, ...live]
    updateModal(renderer, {}, false)
    expect(renderer.container.querySelector('[data-activity-event-id="event-0"]')).toBeNull()
    rowHeights.set("", 60)
    resizeBody(300, false)
    expect(root.scrollTop).toBe(0)
    const older = event("older-page", "2026-08-27T11:30:00.000Z")
    auditState.events = [...auditState.events, older]
    auditState.isFetchingNextPage = false
    updateModal(renderer, {}, false)
    await completePage([older])
    updateModal(renderer)
    expect(eventTop(renderer, "event-0")).toBe(84)
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })

  it("keeps the captured target when the header has no qualified public layout", async () => {
    auditState.events = events(50)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    const root = scrollBody(renderer, 0)
    const top = eventTop(renderer, "event-0")
    auditState.isFetchingNextPage = true
    updateModal(renderer, {}, false)
    act(() => root.scrollTo({ top: 600 }))
    expect(renderer.container.querySelector('[data-index="0"]')).toBeNull()
    rowHeights.set("", 60)
    resizeBody(300, false)
    const older = event("older-page", "2026-08-27T11:00:00.000Z")
    auditState.events = [...auditState.events, older]
    auditState.isFetchingNextPage = false
    updateModal(renderer, {}, false)
    await completePage([older])
    updateModal(renderer)
    expect(eventTop(renderer, "event-0")).toBe(top)
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })

  it.each(["input", "close", "bot", "body"])("retires the net header target on %s before its reply", async retirement => {
    auditState.events = events(50)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    let { renderer } = renderModal()
    scrollBody(renderer, 50)
    auditState.isFetchingNextPage = true
    updateModal(renderer, {}, false)
    act(() => vi.advanceTimersByTime(150))
    rowHeights.set("", 60)
    resizeBody(300, false)
    const options = retirement === "bot" ? { bot: { ...bot, id: "bot-2" } } : {}
    if (retirement === "close") {
      updateModal(renderer, { open: false }, false)
      updateModal(renderer, {}, false)
    } else if (retirement === "bot") updateModal(renderer, options, false)
    else if (retirement === "body") {
      renderer.unmount()
      renderer = renderModal().renderer
    }
    scrollBody(renderer, 600)
    const top = eventTop(renderer, "event-15")
    const older = event("older-page", "2026-08-27T11:00:00.000Z")
    auditState.events = [...auditState.events, older]
    auditState.isFetchingNextPage = false
    updateModal(renderer, options, false)
    await completePage([older])
    updateModal(renderer, options)
    expect(eventTop(renderer, "event-15")).toBe(top)
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })

  it("keeps the offset50 reader through idle header compensation and the older reply", async () => {
    auditState.events = events(50)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    const root = scrollBody(renderer, 50)
    auditState.isFetchingNextPage = true
    updateModal(renderer, {}, false)
    act(() => vi.advanceTimersByTime(150))
    const samples: Array<Record<string, unknown>> = []
    const sample = (phase: string) => {
      const reader = renderer.container.querySelector<HTMLElement>('[data-activity-event-id="event-0"]')!
      const control = renderer.container.querySelector<HTMLElement>('[data-index="0"]')
      samples.push({ phase, readerId: "event-0", viewportOffset: reader.getBoundingClientRect().top,
        readerStart: Number.parseFloat(reader.style.transform.match(/translateY\((-?[\d.]+)px\)/)?.[1] ?? "0"),
        scrollTop: root.scrollTop, controlHeight: control?.getBoundingClientRect().height ?? null,
        totalSize: root.scrollHeight, fetchCalls: fetchNextPage.mock.calls.length, dom: root.outerHTML })
      console.info("197_HEADER_COMPENSATION_PHASE", JSON.stringify(samples.at(-1)))
    }
    sample("pending-after-original-idle")
    const top = eventTop(renderer, "event-0")
    rowHeights.set("", 60)
    resizeBody(300, false)
    sample("same-header-after-resize-observer")
    const older = Array.from({ length: 50 }, (_, index) => event(
      `idle-old-${index}`,
      new Date(Date.parse("2026-08-27T11:10:00.000Z") + index * 60_000).toISOString(),
    ))
    auditState.events = [...auditState.events, ...older]
    auditState.isFetchingNextPage = false
    updateModal(renderer, {}, false)
    await completePage(older)
    updateModal(renderer)
    sample("after-original-older-reply")
    console.info("197_HEADER_COMPENSATION_ORIGINAL", JSON.stringify(samples))
    expect(top).toBe(18)
    expect(samples[0]).toMatchObject({ scrollTop: 50, controlHeight: 44, fetchCalls: 1 })
    expect(samples[1]).toMatchObject({ scrollTop: 66, controlHeight: 60, viewportOffset: top, fetchCalls: 1 })
    expect(eventTop(renderer, "event-0")).toBe(top)
    expect(fetchNextPage).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
  })

  it("keeps Home through a same-owner data commit", async () => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    const root = scrollBody(renderer, 600)
    act(() => root.focus())
    expect(root).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: "Home" })
    auditState.events = [...auditState.events]
    updateModal(renderer, {}, false)
    act(() => root.scrollTo({ top: 150 }))
    expect(fetchNextPage).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
    await completePage([])
  })

  it.each([false, true])("keeps Home through an unrelated row measurement and the Loading header (earlier live: %s)", async earlierLive => {
    auditState.events = events(50)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    const root = scrollBody(renderer, 200)
    act(() => root.focus())
    expect(root).toHaveFocus()
    const total = root.scrollHeight
    fireEvent.keyDown(document.activeElement!, { key: "Home" })
    rowHeights.set("event-12", 33)
    resizeBody(300, false)
    expect(root.scrollTop).toBe(200)
    expect(root.scrollHeight).toBe(total - 11)
    act(() => root.scrollTo({ top: 150 }))
    expect(fetchNextPage).not.toHaveBeenCalled()
    act(() => root.scrollTo({ top: 0 }))
    expect(fetchNextPage).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
    auditState.isFetchingNextPage = true
    updateModal(renderer, {}, false)
    rowHeights.set("", 60)
    resizeBody(300, false)
    const top = eventTop(renderer, "event-0")
    expect(top).toBe(84)
    if (earlierLive) {
      auditState.events = [...auditState.events, event("earlier-live", "2026-08-27T11:30:00.000Z")]
      updateModal(renderer, {}, false)
    }
    const older = event("measured-old", "2026-08-27T11:00:00.000Z")
    auditState.events = [...auditState.events, older]
    auditState.isFetchingNextPage = false
    await completePage([older])
    updateModal(renderer)
    expect(eventTop(renderer, "event-0")).toBe(top)
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })

  it("keeps the complete measured Home, prepend, live, failure, Retry and end journey", async () => {
    const seed = Array.from({ length: 101 }, (_, index) => event(
      `seed-${String(index).padStart(3, "0")}`,
      new Date(Date.parse("2026-08-27T12:00:00.000Z") + index * 60_000).toISOString(),
    ))
    const head = seed.slice(51)
    const older = seed.slice(1, 51)
    const live = event("live", "2026-08-27T13:41:00.000Z")
    const pages = [{ events: head }]
    let finish!: (result: unknown) => void
    fetchNextPage.mockImplementation(() => new Promise(resolvePage => { finish = resolvePage }))
    auditState.events = head
    auditState.hasNextPage = true
    const { renderer } = renderModal()
    const root = scrollBody(renderer, 200)
    act(() => root.focus())
    expect(root).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: "Home" })
    act(() => root.scrollTo({ top: 150 }))
    expect(fetchNextPage).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
    auditState.isFetchingNextPage = true
    updateModal(renderer, {}, false)
    act(() => root.scrollTo({ top: 0 }))
    rowHeights.set("", 60)
    resizeBody(300, false)
    const firstTop = eventTop(renderer, "seed-051")
    expect(firstTop).toBe(84)
    for (const item of older) rowHeights.set(item.id, 33)
    pages.push({ events: older })
    auditState.events = [...head, ...older]
    auditState.loadedPageCount = 2
    auditState.isFetchingNextPage = false
    updateModal(renderer, {}, false)
    await act(async () => { finish({ isError: false, data: { pages } }) })
    updateModal(renderer)
    expect(eventTop(renderer, "seed-051")).toBe(firstTop)
    expect(renderer.container.querySelector('[data-event-id="seed-050"]')).toBeInTheDocument()
    auditState.events = [...auditState.events, live]
    updateModal(renderer)
    expect(eventTop(renderer, "seed-051")).toBe(firstTop)
    expect(fetchNextPage).toHaveBeenCalledOnce()

    act(() => root.focus())
    fireEvent.keyDown(document.activeElement!, { key: "Home" })
    act(() => root.scrollTo({ top: 600 }))
    resizeBody(300, false)
    act(() => root.scrollTo({ top: 150 }))
    expect(fetchNextPage).toHaveBeenCalledOnce()
    act(() => root.scrollTo({ top: 0 }))
    expect(fetchNextPage).toHaveBeenCalledTimes(2)
    expect(fetchNextPage).toHaveBeenLastCalledWith({ cancelRefetch: false })
    auditState.isFetchingNextPage = true
    updateModal(renderer, {}, false)
    expect(renderer.getByText("Loading older")).toBeInTheDocument()
    auditState.isFetchingNextPage = false
    auditState.isFetchNextPageError = true
    updateModal(renderer, {}, false)
    await act(async () => { finish({ isError: true, data: { pages } }) })
    updateModal(renderer)
    expect(renderer.getByRole("button", { name: "Retry older" })).toBeEnabled()
    expect(auditState.loadedPageCount).toBe(2)
    expect(auditState.events).toHaveLength(101)
    fireEvent.keyDown(document.activeElement!, { key: "Home" })
    fireEvent.wheel(root, { deltaY: -20 })
    act(() => root.scrollTo({ top: 0 }))
    expect(fetchNextPage).toHaveBeenCalledTimes(2)

    fireEvent.click(renderer.getByRole("button", { name: "Retry older" }))
    expect(fetchNextPage).toHaveBeenCalledTimes(3)
    expect(fetchNextPage).toHaveBeenLastCalledWith({ cancelRefetch: false })
    auditState.isFetchingNextPage = true
    updateModal(renderer, {}, false)
    expect(renderer.getByRole("button", { name: "Loading older" })).toBeDisabled()
    rowHeights.set("", 80)
    resizeBody(300, false)
    const retryTop = eventTop(renderer, "seed-001")
    expect(retryTop).toBe(104)
    pages.push({ events: [seed[0]!] })
    auditState.events = [...auditState.events, seed[0]!]
    auditState.loadedPageCount = 3
    auditState.hasNextPage = false
    auditState.isFetchingNextPage = false
    auditState.isFetchNextPageError = false
    updateModal(renderer, {}, false)
    await act(async () => { finish({ isError: false, data: { pages } }) })
    updateModal(renderer)
    expect(eventTop(renderer, "seed-001")).toBe(retryTop)
    expect(renderer.getByText("Beginning of log")).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement!, { key: "Home" })
    act(() => root.scrollTo({ top: 0 }))
    expect(fetchNextPage).toHaveBeenCalledTimes(3)
    updateModal(renderer, { open: false })
    updateModal(renderer)
    expect(root.scrollTop).toBe(root.scrollHeight - root.clientHeight)
    expect(renderer.container.querySelector('[data-event-id="live"]')).toBeInTheDocument()
    expect(fetchNextPage).toHaveBeenCalledTimes(3)
  })

  it.each(["idle", "new-input", "close", "bot", "body", "height"])("retires Home's absolute target on %s", async retirement => {
    auditState.events = events(50)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    let { renderer } = renderModal()
    let root = scrollBody(renderer, 200)
    act(() => root.focus())
    fireEvent.keyDown(document.activeElement!, { key: "Home" })
    rowHeights.set("event-12", 33)
    resizeBody(300, false)
    act(() => root.scrollTo({ top: 150 }))
    expect(fetchNextPage).not.toHaveBeenCalled()
    if (retirement === "idle") act(() => vi.advanceTimersByTime(150))
    else if (retirement === "new-input") fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" })
    else if (retirement === "close") {
      updateModal(renderer, { open: false }, false)
      updateModal(renderer, {}, false)
    } else if (retirement === "bot") updateModal(renderer, { bot: { ...bot, id: "bot-2" } }, false)
    else if (retirement === "body") {
      const oldRoot = root
      renderer.unmount()
      renderer = renderModal().renderer
      root = renderer.getByTestId("activity-body")
      fireEvent.keyDown(oldRoot, { key: "Home" })
      act(() => oldRoot.scrollTo({ top: 0 }))
    } else resizeBody(400, false)
    act(() => root.scrollTo({ top: 0 }))
    act(() => vi.advanceTimersByTime(500))
    expect(fetchNextPage).not.toHaveBeenCalled()
    act(() => root.focus())
    fireEvent.keyDown(document.activeElement!, { key: "Home" })
    expect(fetchNextPage).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
    await completePage([])
  })

  it.each(["busy", "error", "exhausted"])("retires Home across a committed %s Query state without idle rearming", async rejected => {
    auditState.events = events(50)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    const root = scrollBody(renderer, 200)
    act(() => root.focus())
    fireEvent.keyDown(document.activeElement!, { key: "Home" })
    rowHeights.set("event-12", 33)
    resizeBody(300, false)
    act(() => root.scrollTo({ top: 150 }))
    auditState.isFetching = rejected === "busy"
    auditState.isFetchNextPageError = rejected === "error"
    auditState.hasNextPage = rejected !== "exhausted"
    updateModal(renderer, {}, false)
    fireEvent.keyDown(document.activeElement!, { key: "Home" })
    auditState.isFetching = false
    auditState.isFetchNextPageError = false
    auditState.hasNextPage = true
    updateModal(renderer, {}, false)
    act(() => root.scrollTo({ top: 0 }))
    expect(fetchNextPage).not.toHaveBeenCalled()
    fireEvent.keyDown(document.activeElement!, { key: "Home" })
    expect(fetchNextPage).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
    await completePage([])
  })

  it.each(["none", "wheel", "PageUp", "Home"])("accepts layout movement to zero only with the same owned Home (%s)", async input => {
    auditState.events = events(50)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    const root = scrollBody(renderer, 200)
    act(() => root.focus())
    if (input === "wheel") fireEvent.wheel(root, { deltaY: -20 })
    else if (input !== "none") fireEvent.keyDown(document.activeElement!, { key: input })
    rowHeights.set("", 0)
    for (let index = 0; index < 4; index++) rowHeights.set(`event-${index}`, 0)
    resizeBody(300, false)
    act(() => root.scrollTo({ top: 0 }))
    if (input === "Home") {
      expect(fetchNextPage).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
      act(() => root.scrollTo({ top: 0 }))
      expect(fetchNextPage).toHaveBeenCalledOnce()
      await completePage([])
    } else expect(fetchNextPage).not.toHaveBeenCalled()
  })

  it("keeps new Home qualification through the preceding wheel's idle callback", async () => {
    auditState.events = events(50)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    act(() => vi.advanceTimersByTime(500))
    const root = renderer.getByRole("region", { name: "Activity log" })
    act(() => {
      fireEvent.wheel(root, { deltaY: -20 })
      root.scrollTo({ top: 200 })
      vi.advanceTimersByTime(149)
      root.focus()
    })
    expect(root).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: "Home" })
    act(() => vi.advanceTimersByTime(1))
    expect(root.scrollTop).toBe(200)
    expect(fetchNextPage).not.toHaveBeenCalled()
    act(() => root.scrollTo({ top: 150 }))
    expect(fetchNextPage).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
    auditState.isFetchingNextPage = true
    updateModal(renderer, {}, false)
    act(() => {
      root.scrollTo({ top: 0 })
      vi.advanceTimersByTime(16)
    })
    const top = eventTop(renderer, "event-0")
    const older = Array.from({ length: 50 }, (_, index) => event(
      `input-old-${index}`,
      new Date(Date.parse("2026-08-27T11:00:00.000Z") + index * 60_000).toISOString(),
    ))
    auditState.events = [...auditState.events, ...older]
    auditState.isFetchingNextPage = false
    await completePage(older)
    updateModal(renderer)
    expect(eventTop(renderer, "event-0")).toBe(top)
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })

  it("retires moved input before later raw scrolling into the top band", async () => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const { renderer } = renderModal()
    const root = scrollBody(renderer, 600)
    act(() => root.focus())
    expect(root).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: "PageUp" })
    act(() => {
      root.scrollTo({ top: 300 })
      vi.advanceTimersByTime(150)
    })
    expect(fetchNextPage).not.toHaveBeenCalled()
    act(() => root.scrollTo({ top: 150 }))
    expect(fetchNextPage).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Home" })
      root.scrollTo({ top: 100 })
    })
    expect(fetchNextPage).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
  })

  it("resets movement ownership when a new Home replaces moving input", async () => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    const root = scrollBody(renderer, 600)
    act(() => root.focus())
    expect(root).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: "PageUp" })
    act(() => {
      root.scrollTo({ top: 300 })
      vi.advanceTimersByTime(149)
    })
    fireEvent.keyDown(document.activeElement!, { key: "Home" })
    act(() => vi.advanceTimersByTime(1))
    expect(root.scrollTop).toBe(300)
    act(() => root.scrollTo({ top: 150 }))
    expect(fetchNextPage).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
    await completePage([])
  })

  it.each(["key", "touch", "pointer"])("retains upward %s reading into the real top band", async gesture => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const { renderer } = renderModal()
    const root = scrollBody(renderer, 600)
    await act(async () => {
      if (gesture === "key") {
        const entry = renderer.getByRole("region", { name: "Activity log" })
        entry.focus()
        expect(entry).toHaveFocus()
        fireEvent.keyDown(document.activeElement!, { key: "PageUp" })
      } else if (gesture === "touch") {
        fireEvent.pointerDown(root, { pointerId: 1, button: 0, pointerType: "touch" })
        fireEvent.touchStart(root, { touches: [{ clientY: 100 }] })
        fireEvent.touchMove(root, { touches: [{ clientY: 140 }] })
      } else fireEvent.pointerDown(root, { pointerId: 1, button: 0, pointerType: "mouse" })
      root.scrollTo({ top: 300 })
      vi.advanceTimersByTime(50)
      if (gesture === "touch") {
        fireEvent.touchEnd(root, { touches: [] })
        fireEvent.pointerUp(window, { pointerId: 1, pointerType: "touch" })
      } else if (gesture === "pointer") fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse" })
      root.scrollTo({ top: 150 })
      if (gesture === "pointer") fireEvent.pointerUp(window, { pointerId: 1, pointerType: "mouse" })
    })
    expect(fetchNextPage).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
    act(() => root.scrollTo({ top: 100 }))
    act(() => vi.advanceTimersByTime(500))
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })

  it.each(["pointerup", "pointercancel"])("retires scrollbar input on %s before later offset movement", eventType => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const { renderer } = renderModal()
    const root = scrollBody(renderer, 600)
    fireEvent.pointerDown(root, { pointerId: 1, button: 0, pointerType: "mouse" })
    fireEvent(window, new PointerEvent(eventType, { pointerId: 1, pointerType: "mouse" }))
    act(() => root.scrollTo({ top: 150 }))
    act(() => vi.advanceTimersByTime(500))
    expect(fetchNextPage).not.toHaveBeenCalled()
  })

  it("does not restore a pending page's anchor after changing bots", async () => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    scrollBody(renderer, 0)
    const nextBot = { ...bot, id: "bot-2", name: "Next Bot" }
    auditState.hasNextPage = false
    updateModal(renderer, { bot: nextBot })
    const root = scrollBody(renderer, 600)
    const top = eventTop(renderer, "event-15")
    await completePage([event("old-bot-page", "2026-08-27T11:00:00.000Z")])
    updateModal(renderer, { bot: nextBot })
    expect(auditHook).toHaveBeenLastCalledWith("bot-2")
    expect(sheetProps.current!.title).toBe("Next Bot")
    expect(eventTop(renderer, "event-15")).toBe(top)
    expect(root.scrollTop).toBe(600)
    expect(fetchNextPage).toHaveBeenCalledOnce()
  })
})
