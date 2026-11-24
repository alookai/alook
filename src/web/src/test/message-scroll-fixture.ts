import { createElement, StrictMode, useLayoutEffect, useMemo } from "react"
import { vi } from "vitest"
import { act, render, fireEvent, type RenderOptions } from "@/test/react-dom-harness"
import { MESSAGE_ROW_VERTICAL_PADDING_PX, type FlatItem } from "@/lib/community/message-list-items"
import { MESSAGE_RAIL_TAIL_PADDING_END_PX } from "@/lib/community/conversation-layout"
import { useConversationScroll } from "@/hooks/community/use-conversation-scroll"

type FixtureMessage = Extract<FlatItem, { kind: "message" }> & { dateLabel?: string; newDivider?: boolean }
export const message = (id: string, authorId = "peer"): FixtureMessage => ({ kind: "message", key: `msg:${id}`, m: { id, type: "chat", authorId, grouped: false } })
type Input = Parameters<typeof useConversationScroll>[0] & { scrollRootKey?: string }
type Result = ReturnType<typeof useConversationScroll>
let latest: Result
let height: number
let width: number
let firstPrefix: number
let bodyHeights: Map<string, number>
let overflowHeights: Map<string, number>
let overflowModes: Map<string, "visible" | "hidden">
let frames: Map<number, FrameRequestCallback>
let frameId: number
let resizeObservers: Array<{
  callback: ResizeObserverCallback
  observer: ResizeObserver
  elements: Map<Element, { box: "content-box" | "border-box"; lastSize: ResizeObserverSize }>
}>
let scrollbarWidth: number
let scrollCalls: number[]
let pendingScrollEvents: Set<HTMLElement>
let scrollDescriptor: PropertyDescriptor | undefined
let domMetricsObserver: MutationObserver | null = null

const ROOT_SELECTOR = '[data-testid="scroll"], [data-testid="community-message-scroller"], [data-testid="community-forum-post-list"]'
function isScrollRoot(node: HTMLElement) {
  const testId = node.getAttribute("data-testid")
  return testId === "scroll" || testId === "community-message-scroller" || testId === "community-forum-post-list"
}
function findNativeRows(root: HTMLElement): HTMLElement | null {
  const content = root.firstElementChild as HTMLElement | null
  const rows = content?.firstElementChild as HTMLElement | null
  if (rows?.hasAttribute("data-message-rows")) return rows
  return root.querySelector<HTMLElement>("[data-message-rows]")
}
let cachedRootsVersion = -1
let cachedScrollRoots: HTMLElement[] = []
function currentScrollRoots(): HTMLElement[] {
  if (cachedRootsVersion !== metricsCacheVersion) {
    cachedScrollRoots = Array.from(document.querySelectorAll<HTMLElement>(ROOT_SELECTOR))
    cachedRootsVersion = metricsCacheVersion
  }
  return cachedScrollRoots
}
function rootFor(node: HTMLElement) {
  for (let cur: HTMLElement | null = node; cur; cur = cur.parentElement) {
    if (isScrollRoot(cur)) return cur
  }
  return null
}
function deliverScrollEvents() {
  for (const root of pendingScrollEvents) {
    if (root.isConnected) root.dispatchEvent(new Event("scroll"))
  }
  pendingScrollEvents.clear()
}
function measureRowWrapper(wrapper: HTMLElement) {
  const first = wrapper.firstElementChild as HTMLElement | null
  const actualRow = first?.hasAttribute("data-message-row-key")
    ? first
    : wrapper.querySelector<HTMLElement>("[data-message-row-key]")
  const inner = actualRow?.firstElementChild as HTMLElement | null
  const content = inner?.hasAttribute("data-msg-id")
    ? inner
    : actualRow
      ? (actualRow.dataset.fixtureKind === "message" || !actualRow.dataset.fixtureKind
        ? (actualRow.dataset.messageRowKey?.startsWith("rail:") || actualRow.dataset.messageRowKey?.startsWith("date:") || actualRow.dataset.messageRowKey?.startsWith("new:") || actualRow.dataset.messageRowKey?.startsWith("divider:")
          ? null
          : wrapper.querySelector<HTMLElement>("[data-msg-id]"))
        : null)
      : wrapper.querySelector<HTMLElement>("[data-msg-id]")
  if (!content && !actualRow) return { size: 0, decoration: 0, topPadding: 0, bottomPadding: 0, total: 0 }
  const size = content ? bodyHeights.get(content.dataset.msgId!) ?? 100 : 0
  const key = actualRow?.dataset.messageRowKey
  const kind = actualRow?.dataset.fixtureKind ?? (key === "rail:leading" ? "leading" : key === "rail:trailing" ? "trailing"
    : key?.startsWith("date:") || key?.startsWith("new:") ? "divider" : "message")
  const hasDate = kind === "divider" && (actualRow?.dataset.fixtureDate === "true" || !!actualRow?.querySelector("span.text-xs"))
  const decoration = kind === "leading" ? firstPrefix : kind === "trailing" ? 56
    : kind === "divider" ? hasDate ? 32 : 24 : 0
  const padding = kind === "message" ? (actualRow?.style.paddingBlock ?? "").split(/\s+/).map(Number.parseFloat) : [0]
  const topPadding = padding[0] || (actualRow?.classList.contains("py-2") ? 8 : 0)
  const bottomPadding = padding.length > 1 ? padding[1] : topPadding
  return { size, decoration, topPadding, bottomPadding, total: size + decoration + topPadding + bottomPadding }
}
let metricsCacheVersion = 0
let cachedRowsMetrics: { version: number; container: HTMLElement; clientHeight: number; metrics: ReturnType<typeof computeNativeRowsMetrics> } | null = null
function firstChildRowKey(rowsContainer: HTMLElement): string {
  const first = rowsContainer.firstElementChild as HTMLElement | null
  const row = first?.firstElementChild as HTMLElement | null
  if (row?.hasAttribute("data-message-row-key")) return row.dataset.messageRowKey ?? ""
  return first?.querySelector<HTMLElement>("[data-message-row-key]")?.dataset.messageRowKey ?? ""
}
function computeNativeRowsMetrics(rowsContainer: HTMLElement, root: HTMLElement | null | undefined) {
  let cursor = 0
  let childCount = 0
  let tailSpacerHeight = 0
  const offsets = new Map<HTMLElement, { start: number; height: number }>()
  for (let child = rowsContainer.firstElementChild as HTMLElement | null; child; child = child.nextElementSibling as HTMLElement | null) {
    childCount += 1
    const measured = child.hasAttribute("data-index")
      ? measureRowWrapper(child).total
      : child.hasAttribute("data-message-list-tail")
        ? (Number.parseFloat(child.style.height) || 0)
        : 0
    if (child.hasAttribute("data-message-list-tail")) tailSpacerHeight += measured
    offsets.set(child, { start: cursor, height: measured })
    cursor += measured
  }
  const paddingBottom = Number.parseFloat(rowsContainer.style.paddingBottom) || 0
  const totalHeight = cursor + paddingBottom
  const topOffset = rowsContainer.classList.contains("mt-auto")
    ? Math.max(0, (root?.clientHeight ?? 0) - totalHeight)
    : 0
  return {
    offsets,
    totalHeight,
    topOffset,
    childCount,
    firstChildCount: rowsContainer.firstElementChild?.childElementCount ?? -1,
    lastChildCount: rowsContainer.lastElementChild?.childElementCount ?? -1,
    firstChildKey: firstChildRowKey(rowsContainer),
    paddingBottom,
    tailSpacerHeight,
  }
}
function nativeRowsMetrics(rowsContainer: HTMLElement, root: HTMLElement | null | undefined) {
  const clientHeight = root?.clientHeight ?? 0
  const paddingBottom = Number.parseFloat(rowsContainer.style.paddingBottom) || 0
  const lastEl = rowsContainer.lastElementChild as HTMLElement | null
  const tailSpacerHeight = lastEl?.hasAttribute("data-message-list-tail") ? (Number.parseFloat(lastEl.style.height) || 0) : 0
  const firstChildCount = rowsContainer.firstElementChild?.childElementCount ?? -1
  const lastChildCount = rowsContainer.lastElementChild?.childElementCount ?? -1
  const firstChildKey = firstChildRowKey(rowsContainer)
  if (
    cachedRowsMetrics
    && cachedRowsMetrics.version === metricsCacheVersion
    && cachedRowsMetrics.container === rowsContainer
    && cachedRowsMetrics.clientHeight === clientHeight
    && cachedRowsMetrics.metrics.childCount === rowsContainer.children.length
    && cachedRowsMetrics.metrics.firstChildCount === firstChildCount
    && cachedRowsMetrics.metrics.lastChildCount === lastChildCount
    && cachedRowsMetrics.metrics.firstChildKey === firstChildKey
    && cachedRowsMetrics.metrics.paddingBottom === paddingBottom
    && cachedRowsMetrics.metrics.tailSpacerHeight === tailSpacerHeight
  ) {
    return cachedRowsMetrics.metrics
  }
  const metrics = computeNativeRowsMetrics(rowsContainer, root)
  cachedRowsMetrics = { version: metricsCacheVersion, container: rowsContainer, clientHeight, metrics }
  return metrics
}
function invalidateMetricsCache() {
  metricsCacheVersion += 1
  cachedRowsMetrics = null
  cachedRootsVersion = -1
  cachedScrollRoots = []
}
function fastNodeHeight(node: HTMLElement): number {
  if (node.hasAttribute("data-message-rows")) {
    return nativeRowsMetrics(node, rootFor(node)).totalHeight
  }
  const wrapper = node.hasAttribute("data-index") ? node : node.closest<HTMLElement>("[data-index]")
  if (wrapper) {
    const measured = measureRowWrapper(wrapper)
    if (node.hasAttribute("data-msg-id")) return measured.size
    if (node.hasAttribute("data-new-divider")) return measured.decoration
    return measured.total
  }
  return rowGeometry(node).height
}
function listOffset(container: HTMLElement | null, root: HTMLElement | null | undefined) {
  return container?.parentElement?.hasAttribute("data-message-list-content") && container.parentElement.classList.contains("justify-end")
    ? Math.max(0, (root?.clientHeight ?? 0) - (Number.parseFloat(container.style.height) || 0)) : 0
}
function rowGeometry(node: HTMLElement) {
  const root = rootFor(node)
  if (node.hasAttribute("data-message-rows")) {
    const metrics = nativeRowsMetrics(node, root)
    return DOMRect.fromRect({ y: metrics.topOffset + (root?.clientTop ?? 0) - (root?.scrollTop ?? 0), width, height: metrics.totalHeight })
  }
  const wrapper = node.hasAttribute("data-index") ? node : node.closest<HTMLElement>("[data-index]")
  const rowsContainer = wrapper?.parentElement?.hasAttribute("data-message-rows") ? wrapper.parentElement : null
  if (wrapper && rowsContainer) {
    const metrics = nativeRowsMetrics(rowsContainer, root)
    const entry = metrics.offsets.get(wrapper)
    const measured = measureRowWrapper(wrapper)
    const y = (entry?.start ?? 0) + metrics.topOffset + (root?.clientTop ?? 0) - (root?.scrollTop ?? 0)
    if (node.hasAttribute("data-msg-id")) return DOMRect.fromRect({ y: y + measured.topPadding, width, height: measured.size })
    if (node.hasAttribute("data-new-divider")) return DOMRect.fromRect({ y, width, height: measured.decoration })
    return DOMRect.fromRect({ y, width, height: measured.total })
  }
  const measured = wrapper ? measureRowWrapper(wrapper) : { size: 0, decoration: 0, topPadding: 0, bottomPadding: 0, total: 0 }
  const translation = wrapper?.style.transform.match(/translate3d\(0,\s*(-?[\d.]+)px/)
  const start = Number.parseFloat(translation?.[1] ?? wrapper?.style.top ?? "0") || 0
  const y = start + listOffset(wrapper?.parentElement ?? null, root) + (root?.clientTop ?? 0) - (root?.scrollTop ?? 0)
  if (node.style.position === "relative" && node.parentElement?.hasAttribute("data-message-list-content")) {
    return DOMRect.fromRect({
      y: listOffset(node, root) + (root?.clientTop ?? 0) - (root?.scrollTop ?? 0),
      width,
      height: Number.parseFloat(node.style.height) || 0,
    })
  }
  if (node.hasAttribute("data-msg-id")) return DOMRect.fromRect({ y: y + measured.topPadding, width, height: measured.size })
  if (node.hasAttribute("data-new-divider")) return DOMRect.fromRect({ y, width, height: measured.decoration })
  return DOMRect.fromRect({ y, width, height: measured.total })
}
function Probe({ input, onLayout }: { input: Input; onLayout?: (result: Result) => void }) {
  const items = useMemo<FlatItem[]>(() => {
    if (input.items.length === 0 || input.items.some(item => item.kind !== "message")) return input.items
    return [
      { kind: "leading", key: "rail:leading" },
      ...input.items.flatMap(item => {
        const msg = item as FixtureMessage
        return [
          ...(msg.dateLabel || msg.newDivider ? [{
            kind: "divider" as const,
            key: `divider:${msg.key}`,
            messageId: msg.m.id,
            dateLabel: msg.dateLabel,
            newDivider: msg.newDivider,
          }] : []),
          msg,
        ]
      }),
      ...(input.hasMoreNewer ? [{ kind: "trailing" as const, key: "rail:trailing" }] : []),
    ]
  }, [input.items, input.hasMoreNewer])
  const result = useConversationScroll({ ...input, items })
  useLayoutEffect(() => { latest = result; onLayout?.(result) })
  const tailPaddingEnd = input.tailPaddingEnd ?? MESSAGE_RAIL_TAIL_PADDING_END_PX
  return createElement("div", { "data-slot": "community-conversation-surface" },
    createElement("div", { key: input.scrollRootKey, ref: result.scrollRef, "data-testid": "scroll" },
      createElement("div", { "data-message-list-content": "", className: "flex min-h-full flex-col", "data-read-position-ready": String(result.readPositionReady) },
        createElement("div", { "data-message-rows": "", className: "mt-auto flex w-full flex-col" },
          items.map((item, index) => createElement("div", { key: item.key, "data-index": index, className: "w-full" },
            item.kind === "leading" && item.hidden ? null : createElement("div", {
              "data-message-row-key": item.key,
              "data-fixture-kind": item.kind,
              "data-fixture-date": String(item.kind === "divider" && !!item.dateLabel),
              "data-message-divider-for": item.kind === "divider" ? item.messageId : undefined,
              style: item.kind === "message" && (item.paddingTop !== undefined || item.paddingBottom !== undefined)
                ? { paddingBlock: `${item.paddingTop ?? MESSAGE_ROW_VERTICAL_PADDING_PX}px ${item.paddingBottom ?? MESSAGE_ROW_VERTICAL_PADDING_PX}px` } : undefined,
            },
              item.kind === "divider" && item.newDivider ? createElement("div", { "data-new-divider": "" }) : null,
              item.kind === "message" ? createElement("div", { "data-msg-id": item.m.id, style: { overflowY: overflowModes.get(item.m.id) } }) : null,
            ),
          )),
          createElement("div", { "aria-hidden": "true", "data-message-list-tail": "", className: "shrink-0", style: { height: tailPaddingEnd } }),
        ),
      ),
    ),
    createElement("div", { "data-slot": "community-conversation-footer" }),
  )
}
export function runFrames(count = 26) {
  for (let i = 0; i < count; i++) {
    act(() => {
      vi.advanceTimersByTime(16)
      for (const root of currentScrollRoots()) {
        if (!root.isConnected) continue
        const clamped = Math.max(0, Math.min(root.scrollTop, root.scrollHeight - root.clientHeight))
        if (root.scrollTop !== clamped) {
          root.scrollTop = clamped
          pendingScrollEvents.add(root)
        }
      }
      deliverScrollEvents()
      const pending = [...frames]
      frames.clear()
      for (const [, callback] of pending) callback(performance.now())
    })
  }
}
function measureResizeObservers() {
  for (const observer of [...resizeObservers]) {
    const entries: ResizeObserverEntry[] = []
    for (const [target, observation] of observer.elements) {
      const node = target as HTMLElement
      const style = window.getComputedStyle(node)
      const rendered = node.isConnected && style.display !== "none"
      const padding = (value: string) => Number.parseFloat(value) || 0
      const borderBoxSize = {
        inlineSize: rendered ? node.offsetWidth : 0,
        blockSize: rendered ? node.offsetHeight : 0,
      }
      const contentBoxSize = {
        inlineSize: rendered ? Math.max(0, node.clientWidth - padding(style.paddingLeft) - padding(style.paddingRight)) : 0,
        blockSize: rendered ? Math.max(0, node.clientHeight - padding(style.paddingTop) - padding(style.paddingBottom)) : 0,
      }
      const size = observation.box === "border-box" ? borderBoxSize : contentBoxSize
      if (size.inlineSize === observation.lastSize.inlineSize && size.blockSize === observation.lastSize.blockSize) continue
      observation.lastSize = size
      entries.push({
        target, borderBoxSize: [borderBoxSize], contentBoxSize: [contentBoxSize], devicePixelContentBoxSize: [],
        contentRect: DOMRect.fromRect({
          x: rendered ? padding(style.paddingLeft) : 0, y: rendered ? padding(style.paddingTop) : 0,
          width: contentBoxSize.inlineSize, height: contentBoxSize.blockSize,
        }),
      })
    }
    if (entries.length) observer.callback(entries, observer.observer)
  }
}
export function resize(frameCount = 26) {
  act(() => {
    invalidateMetricsCache()
    deliverScrollEvents()
    measureResizeObservers()
  })
  runFrames(frameCount)
}
export function resizeMeasureBeforeScroll(frameCount = 26, onMeasured?: (pending: number) => void) {
  act(() => {
    invalidateMetricsCache()
    measureResizeObservers()
    onMeasured?.(pendingScrollEvents.size)
  })
  runFrames(frameCount)
}

export function mount(overrides: Partial<Input> = {}, strict = false, onLayout?: (result: Result) => void, wrapper?: RenderOptions["wrapper"], initialFrames = 26) {
  const input: Input = { items: Array.from({ length: 14 }, (_, i) => message(`m${i}`)), initialScrollReady: true, hasMoreOlder: true, ...overrides }
  const element = () => strict ? createElement(StrictMode, null, createElement(Probe, { input, onLayout })) : createElement(Probe, { input, onLayout })
  const view = render(element(), { wrapper })
  const root = view.getByTestId("scroll") as HTMLElement
  resize(initialFrames)
  const stage = (next: Partial<Input>) => { Object.assign(input, next); view.rerender(element()) }
  const update = (next: Partial<Input>) => { stage(next); resize() }
  const move = (offset: number) => {
    fireEvent.wheel(root, { deltaY: offset < root.scrollTop ? -20 : 20 })
    act(() => root.scrollTo({ top: offset }))
    runFrames()
  }
  return { view, root, input, stage, update, move }
}
export function bodyTop(root: HTMLElement, id: string) { return root.querySelector<HTMLElement>(`[data-msg-id="${id}"]`)!.getBoundingClientRect().top }

export function installMessageScrollFixture() {
  height = 500
  width = 320
  firstPrefix = 88
  bodyHeights = new Map()
  const originalBodySet = bodyHeights.set.bind(bodyHeights)
  bodyHeights.set = (key: string, value: number) => {
    invalidateMetricsCache()
    return originalBodySet(key, value)
  }
  const originalBodyDelete = bodyHeights.delete.bind(bodyHeights)
  bodyHeights.delete = (key: string) => {
    invalidateMetricsCache()
    return originalBodyDelete(key)
  }
  invalidateMetricsCache()
  domMetricsObserver?.disconnect()
  domMetricsObserver = new MutationObserver(() => { invalidateMetricsCache() })
  domMetricsObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "data-index", "data-msg-id", "data-message-row-key"] })
  overflowHeights = new Map()
  overflowModes = new Map()
  frames = new Map()
  frameId = 0
  resizeObservers = []
  scrollbarWidth = 0
  scrollCalls = []
  pendingScrollEvents = new Set()
  vi.useFakeTimers()
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
  vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
    private record: typeof resizeObservers[number]
    constructor(callback: ResizeObserverCallback) { this.record = { callback, observer: this, elements: new Map() }; resizeObservers.push(this.record) }
    observe(element: Element, options?: ResizeObserverOptions) {
      const box = options?.box ?? "content-box"
      if (box === "device-pixel-content-box") throw new Error("Message scroll fixture supports CSS content and border boxes")
      this.record.elements.set(element, { box, lastSize: { inlineSize: 0, blockSize: 0 } })
    }
    unobserve(element: Element) { this.record.elements.delete(element) }
    disconnect() { this.record.elements.clear() }
  })
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isScrollRoot(this) ? Math.max(0, height - (Number.parseFloat(this.style.borderTopWidth) || 0) - (Number.parseFloat(this.style.borderBottomWidth) || 0)) : fastNodeHeight(this)
  })
  vi.spyOn(HTMLElement.prototype, "clientTop", "get").mockImplementation(function (this: HTMLElement) {
    return isScrollRoot(this) ? Number.parseFloat(this.style.borderTopWidth) || 0 : 0
  })
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return isScrollRoot(this) ? height : this.clientHeight })
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => width)
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return isScrollRoot(this) ? Math.max(0, width - scrollbarWidth - (Number.parseFloat(this.style.borderLeftWidth) || 0) - (Number.parseFloat(this.style.borderRightWidth) || 0)) : width
  })
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (isScrollRoot(this)) {
      const nativeRows = findNativeRows(this)
      if (nativeRows) {
        return Math.max(this.clientHeight, nativeRowsMetrics(nativeRows, this).totalHeight)
      }
      return Math.max(this.clientHeight, Number.parseFloat(this.querySelector<HTMLElement>("[data-message-list-content]")?.style.height
        || this.querySelector<HTMLElement>("[data-message-list-content] > div")?.style.height || "0") || 0)
    }
    return Math.max(fastNodeHeight(this), this.hasAttribute("data-index") || this.hasAttribute("data-msg-id")
      ? overflowHeights.get(this.dataset.msgId ?? this.querySelector<HTMLElement>("[data-msg-id]")?.dataset.msgId ?? "") ?? 0 : 0)
  })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return isScrollRoot(this) ? DOMRect.fromRect({ width, height }) : rowGeometry(this)
  })
  scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo")
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value(this: HTMLElement, options: ScrollToOptions) {
    const previous = this.scrollTop
    this.scrollTop = Math.max(0, Math.min(options.top ?? this.scrollTop, this.scrollHeight - this.clientHeight))
    scrollCalls.push(this.scrollTop)
    if (this.scrollTop !== previous) pendingScrollEvents.add(this)
  } })
}
export function restoreMessageScrollFixture() {
  domMetricsObserver?.disconnect()
  domMetricsObserver = null
  invalidateMetricsCache()
  pendingScrollEvents.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollDescriptor)
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo")
}

export const scrollFixture = {
  get latest() { return latest },
  get width() { return width },
  set width(value: number) { width = value; invalidateMetricsCache() },
  get height() { return height },
  set height(value: number) { height = value; invalidateMetricsCache() },
  set scrollbarWidth(value: number) { scrollbarWidth = value; invalidateMetricsCache() },
  get firstPrefix() { return firstPrefix },
  set firstPrefix(value: number) { firstPrefix = value; invalidateMetricsCache() },
  get bodyHeights() { return bodyHeights },
  get overflowHeights() { return overflowHeights },
  get overflowModes() { return overflowModes },
  get frames() { return frames },
  get scrollCalls() { return scrollCalls },
}
