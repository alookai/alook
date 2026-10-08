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
    hasNextPage: false,
    isFetchingNextPage: false,
    loadedPageCount: 1,
  },
  auditHook: vi.fn(),
  profileHook: vi.fn(),
  fetchNextPage: vi.fn(),
  sheetProps: { current: null as Record<string, unknown> | null },
}))
let scrollDescriptor: PropertyDescriptor | undefined
let bodyHeight = 300
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
  act(() => vi.advanceTimersByTime(500))
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

function resizeBody(height: number) {
  bodyHeight = height
  act(() => {
    for (const observer of bodyResizeObservers) {
      const entries = [...observer.elements].filter(element => element.isConnected).map(target => ({
        target,
        borderBoxSize: [{ blockSize: (target as HTMLElement).offsetHeight, inlineSize: 672 }],
      } as unknown as ResizeObserverEntry))
      if (entries.length) observer.callback(entries, {} as ResizeObserver)
    }
    vi.advanceTimersByTime(500)
  })
}

describe("BotActivityModal CommunitySheet contract", () => {
  beforeEach(() => {
    auditState.events = []
    auditState.isLoading = false
    auditState.hasNextPage = false
    auditState.isFetchingNextPage = false
    auditState.loadedPageCount = 1
    auditHook.mockReset()
    profileHook.mockReset()
    fetchNextPage.mockReset()
    fetchNextPage.mockResolvedValue({ isError: false, data: { pages: [{ events: [] }] } })
    sheetProps.current = null
    bodyHeight = 300
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
    const rowHeight = (node: HTMLElement) => node.closest<HTMLElement>("[data-activity-row-key]")?.dataset.activityRowKey?.includes(":date:") ? 24 : 44
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
    const { renderer, onOpenChange } = renderModal()
    const root = scrollBody(renderer, offset)
    const id = offset < 100 ? "event-0" : "event-1"
    const top = eventTop(renderer, id)
    const completePage = prepareOlderPage()
    fireEvent.click(renderer.getByRole("button", { name: "Load older" }))
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

  it("does not restore a completed request from before the modal reopened", async () => {
    auditState.events = events(30)
    auditState.hasNextPage = true
    const completePage = prepareOlderPage()
    const { renderer } = renderModal()
    scrollBody(renderer, 0)
    fireEvent.click(renderer.getByRole("button", { name: "Load older" }))
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
    const { renderer } = renderModal()
    scrollBody(renderer, offset)
    const id = offset < 100 ? "event-0" : "event-2"
    const top = eventTop(renderer, id)
    const completePage = prepareOlderPage()
    fireEvent.click(renderer.getByRole("button", { name: "Load older" }))
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
    const { renderer } = renderModal()
    scrollBody(renderer, 0)
    const completePage = prepareOlderPage()
    fireEvent.click(renderer.getByRole("button", { name: "Load older" }))
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
    const root = scrollBody(renderer, 0)
    await act(async () => { fireEvent.click(renderer.getByRole("button", { name: "Load older" })) })
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
    fireEvent.click(renderer.getByRole("button", { name: "Load older" }))
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
    fireEvent.click(renderer.getByRole("button", { name: "Load older" }))
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
})
