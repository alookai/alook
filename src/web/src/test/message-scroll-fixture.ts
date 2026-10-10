import { createElement, StrictMode, useLayoutEffect, useMemo } from "react"
import { vi } from "vitest"
import { act, render, fireEvent } from "@/test/react-dom-harness"
import { VirtualRows } from "@/components/community/messages/virtual-cursor-list"
import type { FlatItem } from "@/lib/community/message-list-items"
import { useScrollAnchor } from "@/hooks/community/use-scroll-anchor"

type FixtureMessage = Extract<FlatItem, { kind: "message" }> & { dateLabel?: string; newDivider?: boolean }
export const message = (id: string, authorId = "peer"): FixtureMessage => ({ kind: "message", key: `msg:${id}`, m: { id, type: "chat", authorId, grouped: false } })
type Input = Parameters<typeof useScrollAnchor>[0]
type Result = ReturnType<typeof useScrollAnchor>
let latest: Result
let height: number
let width: number
let firstPrefix: number
let bodyHeights: Map<string, number>
let frames: Map<number, FrameRequestCallback>
let frameId: number
let resizeObservers: Array<{
  callback: ResizeObserverCallback
  observer: ResizeObserver
  elements: Map<Element, { box: "content-box" | "border-box"; lastSize: ResizeObserverSize }>
}>
let scrollbarWidth: number
let scrollCalls: number[]
let scrollDescriptor: PropertyDescriptor | undefined

const ROOT_SELECTOR = '[data-testid="scroll"], [data-testid="community-message-scroller"]'
function isScrollRoot(node: HTMLElement) { return node.matches(ROOT_SELECTOR) }
function rootFor(node: HTMLElement) { return node.closest<HTMLElement>(ROOT_SELECTOR) }
function rowGeometry(node: HTMLElement) {
  const wrapper = node.matches('[data-index]') ? node : node.closest<HTMLElement>('[data-index]')
  const root = rootFor(node)
  const content = wrapper?.querySelector<HTMLElement>('[data-msg-id]')
  const size = content ? bodyHeights.get(content.dataset.msgId!) ?? 100 : 0
  const actualRow = wrapper?.querySelector<HTMLElement>("[data-message-row-key]")
  const key = actualRow?.dataset.messageRowKey
  const kind = actualRow?.dataset.fixtureKind ?? (key === "rail:leading" ? "leading" : key === "rail:trailing" ? "trailing"
    : key?.startsWith("date:") || key?.startsWith("new:") ? "divider" : "message")
  const hasDate = actualRow?.dataset.fixtureDate === "true" || !!actualRow?.querySelector("span.text-xs")
  const decoration = kind === "leading" ? firstPrefix : kind === "trailing" ? 56
    : kind === "divider" ? hasDate ? 32 : 24 : 0
  const padding = kind === "message" ? (actualRow?.style.paddingBlock ?? "").split(/\s+/).map(Number.parseFloat) : [0]
  const topPadding = padding[0] || (actualRow?.classList.contains("py-2") ? 8 : 0)
  const bottomPadding = padding.length > 1 ? padding[1] : topPadding
  const translation = wrapper?.style.transform.match(/translate3d\(0,\s*(-?[\d.]+)px/)
  const start = Number.parseFloat(translation?.[1] ?? wrapper?.style.top ?? "0") || 0
  const y = start - (root?.scrollTop ?? 0)
  if (node.matches('[data-msg-id]')) return DOMRect.fromRect({ y: y + topPadding, width, height: size })
  if (node.matches('[data-new-divider]')) return DOMRect.fromRect({ y, width, height: decoration })
  return DOMRect.fromRect({ y, width, height: size + decoration + topPadding + bottomPadding })
}
function Probe({ input, onLayout }: { input: Input; onLayout?: (result: Result) => void }) {
  const items = useMemo<FlatItem[]>(() => {
    if (input.items.length === 0 || input.items.some(item => item.kind !== "message")) return input.items
    return [
      { kind: "leading", key: "rail:leading" },
      ...input.items.flatMap(item => {
        const message = item as FixtureMessage
        return [
          ...(message.dateLabel || message.newDivider ? [{
            kind: "divider" as const,
            key: `divider:${message.key}`,
            messageId: message.m.id,
            dateLabel: message.dateLabel,
            newDivider: message.newDivider,
          }] : []),
          message,
        ]
      }),
      ...(input.hasMoreNewer ? [{ kind: "trailing" as const, key: "rail:trailing" }] : []),
    ]
  }, [input.items, input.hasMoreNewer])
  const result = useScrollAnchor({ ...input, items })
  useLayoutEffect(() => { latest = result; onLayout?.(result) })
  return createElement("div", { "data-slot": "community-conversation-surface" },
    createElement("div", { ref: result.scrollRef, "data-testid": "scroll" },
      createElement("div", { "data-message-list-content": "", "data-read-position-ready": String(result.readPositionReady) },
        createElement(VirtualRows<FlatItem>, {
          items, virtualizer: result.virtualizer,
          renderItem: (item) => createElement("div", {
            "data-message-row-key": item.key,
            "data-fixture-kind": item.kind,
            "data-fixture-date": String(item.kind === "divider" && !!item.dateLabel),
            "data-message-divider-for": item.kind === "divider" ? item.messageId : undefined,
          },
            item.kind === "divider" && item.newDivider ? createElement("div", { "data-new-divider": "" }) : null,
            item.kind === "message" ? createElement("div", { "data-msg-id": item.m.id }) : null,
          ),
        }),
      ),
    ),
    createElement("div", { "data-slot": "community-conversation-footer" }),
  )
}
export function runFrames(count = 26) {
  for (let i = 0; i < count; i++) {
    act(() => {
      vi.advanceTimersByTime(16)
      for (const root of document.querySelectorAll<HTMLElement>(ROOT_SELECTOR)) {
        const clamped = Math.max(0, Math.min(root.scrollTop, root.scrollHeight - root.clientHeight))
        if (root.scrollTop !== clamped) {
          root.scrollTop = clamped
          root.dispatchEvent(new Event("scroll"))
        }
      }
      const pending = [...frames]
      frames.clear()
      for (const [, callback] of pending) callback(performance.now())
    })
  }
}
export function resize(frameCount = 26) {
  act(() => {
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
  })
  runFrames(frameCount)
}
export function mount(overrides: Partial<Input> = {}, strict = false, onLayout?: (result: Result) => void) {
  const input: Input = { items: Array.from({ length: 14 }, (_, i) => message(`m${i}`)), initialScrollReady: true, hasMoreOlder: true, ...overrides }
  const element = () => strict ? createElement(StrictMode, null, createElement(Probe, { input, onLayout })) : createElement(Probe, { input, onLayout })
  const view = render(element())
  const root = view.getByTestId("scroll") as HTMLElement
  resize()
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
  frames = new Map()
  frameId = 0
  resizeObservers = []
  scrollbarWidth = 0
  scrollCalls = []
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
    return isScrollRoot(this) ? Math.max(0, height - (Number.parseFloat(this.style.borderTopWidth) || 0) - (Number.parseFloat(this.style.borderBottomWidth) || 0)) : rowGeometry(this).height
  })
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return isScrollRoot(this) ? height : this.clientHeight })
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => width)
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return isScrollRoot(this) ? Math.max(0, width - scrollbarWidth - (Number.parseFloat(this.style.borderLeftWidth) || 0) - (Number.parseFloat(this.style.borderRightWidth) || 0)) : width
  })
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isScrollRoot(this)
      ? Math.max(this.clientHeight, Number.parseFloat(this.querySelector<HTMLElement>('[data-message-list-content] > div')?.style.height ?? "0") || 0)
      : rowGeometry(this).height
  })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return isScrollRoot(this) ? DOMRect.fromRect({ width, height }) : rowGeometry(this)
  })
  scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo")
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value(this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = Math.max(0, Math.min(options.top ?? this.scrollTop, this.scrollHeight - this.clientHeight))
    scrollCalls.push(this.scrollTop)
    this.dispatchEvent(new Event("scroll"))
  } })
}
export function restoreMessageScrollFixture() {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollDescriptor)
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo")
}

export const scrollFixture = {
  get latest() { return latest },
  get width() { return width },
  set width(value: number) { width = value },
  get height() { return height },
  set height(value: number) { height = value },
  set scrollbarWidth(value: number) { scrollbarWidth = value },
  get firstPrefix() { return firstPrefix },
  set firstPrefix(value: number) { firstPrefix = value },
  get bodyHeights() { return bodyHeights },
  get frames() { return frames },
  get scrollCalls() { return scrollCalls },
}
