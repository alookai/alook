import { createElement, type RefObject } from "react"
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const adapters = vi.hoisted(() => ({
  draggables: [] as unknown[],
  targets: [] as unknown[],
  monitor: null as unknown,
  autoScroll: null as unknown,
  cleanupDraggable: vi.fn(),
  cleanupTarget: vi.fn(),
  cleanupMonitor: vi.fn(),
  cleanupAutoScroll: vi.fn(),
}))

vi.mock("@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter", () => ({
  draggable: (options: unknown) => {
    adapters.draggables.push(options)
    return adapters.cleanupDraggable
  },
  dropTargetForElements: (options: unknown) => {
    adapters.targets.push(options)
    return adapters.cleanupTarget
  },
  monitorForElements: (options: unknown) => {
    adapters.monitor = options
    return adapters.cleanupMonitor
  },
}))

vi.mock("@atlaskit/pragmatic-drag-and-drop-auto-scroll/element", () => ({
  autoScrollForElements: (options: unknown) => {
    adapters.autoScroll = options
    return adapters.cleanupAutoScroll
  },
}))

import type { RailEntity, RailState } from "@/lib/community/server-rail-model"
import {
  SERVER_RAIL_TOUCH_HOLD_MS,
  useServerRailPdd,
} from "./use-server-rail-pdd"

type TestEvent = {
  type: string
  defaultPrevented: boolean
  propagationStopped: boolean
  preventDefault: () => void
  stopPropagation: () => void
  [key: string]: unknown
}

function testEvent(type: string, fields: Record<string, unknown> = {}): TestEvent {
  return {
    type,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
    ...fields,
  }
}

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<(event: TestEvent) => void>>()

  addEventListener(type: string, listener: (event: TestEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: TestEvent) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string, event = testEvent(type)): TestEvent {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
    return event
  }

  dispatchEvent(event: TestEvent): boolean {
    this.dispatch(event.type, event)
    return !event.defaultPrevented
  }
}

class FakeMouseEvent implements TestEvent {
  [key: string]: unknown
  readonly type: string
  readonly clientX: number
  readonly clientY: number
  defaultPrevented = false
  propagationStopped = false

  constructor(type: string, init: { clientX?: number; clientY?: number } = {}) {
    this.type = type
    this.clientX = init.clientX ?? 0
    this.clientY = init.clientY ?? 0
  }

  preventDefault() { this.defaultPrevented = true }
  stopPropagation() { this.propagationStopped = true }
}

type Rect = { top: number; bottom: number; left: number; right: number; height: number; width: number }

function rect(top: number, bottom: number, left = 0, right = 40): Rect {
  return { top, bottom, left, right, height: bottom - top, width: right - left }
}

class FakeElement extends FakeEventTarget {
  scrollTop = 0
  isConnected = true
  clickCount = 0
  lastClickEvent: FakeMouseEvent | null = null
  readonly focus = vi.fn()

  constructor(public bounds: Rect) {
    super()
  }

  getBoundingClientRect() { return this.bounds }

  click() {
    this.clickCount += 1
    this.lastClickEvent = new FakeMouseEvent("click")
    this.dispatchEvent(this.lastClickEvent)
  }
}

class FakeDocument extends FakeEventTarget {
  visibilityState: "visible" | "hidden" = "visible"
  points: FakeElement[] = []
  readonly documentElement = { style: { userSelect: "text" } }
  readonly removeAllRanges = vi.fn()

  elementsFromPoint() { return this.points }
  getSelection() { return { removeAllRanges: this.removeAllRanges } }
}

type HookOptions = Parameters<typeof useServerRailPdd>[0]
type HookApi = ReturnType<typeof useServerRailPdd>

type DraggableOptions = {
  canDrag: () => boolean
  getInitialData: () => Record<string, unknown>
}

type TargetOptions = {
  canDrop: (args: { source: { data: Record<string, unknown> } }) => boolean
  getIsSticky: () => boolean
  getData: (args: {
    input: { clientX: number; clientY: number }
    element: HTMLElement
    source: { data: Record<string, unknown> }
  }) => Record<string, unknown>
}

type MonitorOptions = {
  canMonitor: (args: { source: { data: Record<string, unknown> } }) => boolean
  onDragStart: (args: { source: { data: Record<string, unknown> } }) => void
  onDrag: (args: MonitorLocation) => void
  onDropTargetChange: (args: MonitorLocation) => void
  onDrop: (args: MonitorLocation) => void
}

type MonitorLocation = {
  source: { data: Record<string, unknown> }
  location: { current: { dropTargets: Array<{ data: Record<string, unknown> }> } }
}

type AutoScrollOptions = {
  getAllowedAxis: () => string
  getConfiguration: () => { maxScrollSpeed: string }
}

const renderers: ReactTestRenderer[] = []
let fakeDocument: FakeDocument
let fakeWindow: FakeEventTarget
let animationFrames: Map<number, FrameRequestCallback>
let nextFrameId: number

function stateFixture(): RailState {
  return {
    serverOrder: ["a", "b", "c", "d"],
    folderOrder: ["f", "g"],
    folders: { f: ["c"], g: ["d"] },
    expanded: [],
  }
}

function Capture({ options, onResult }: { options: HookOptions; onResult: (api: HookApi) => void }) {
  onResult(useServerRailPdd(options))
  return null
}

async function renderHook(overrides: Partial<HookOptions> = {}) {
  const scroll = new FakeElement(rect(0, 300, 0, 56))
  const callbacks = {
    getState: vi.fn(() => stateFixture()),
    canStart: vi.fn(() => true),
    getEntityLabel: vi.fn((entity: RailEntity) => entity.id.toUpperCase()),
    onDragStart: vi.fn(),
    onPreview: vi.fn(),
    onDrop: vi.fn(),
    onCancel: vi.fn(),
    onHoverExpand: vi.fn(),
    onAnnounce: vi.fn(),
  }
  let options: HookOptions = {
    scrollRef: { current: scroll as unknown as HTMLElement },
    ...callbacks,
    ...overrides,
  }
  let current!: HookApi
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(Capture, {
      options,
      onResult: (api) => { current = api },
    }))
  })
  renderers.push(renderer)
  return {
    callbacks,
    scroll,
    get current() { return current },
    async rerender(next: Partial<HookOptions>) {
      options = { ...options, ...next }
      await act(async () => renderer.update(createElement(Capture, {
        options,
        onResult: (api) => { current = api },
      })))
    },
  }
}

function register(
  api: HookApi,
  entity: RailEntity,
  bounds: Rect,
) {
  const element = new FakeElement(bounds)
  const handle = new FakeElement(bounds)
  const cleanup = api.registerItem(
    entity,
    element as unknown as HTMLElement,
    handle as unknown as HTMLElement,
  )
  return { entity, element, handle, cleanup }
}

function point(identifier: number, clientX: number, clientY: number) {
  return { identifier, clientX, clientY }
}

function touch(
  handle: FakeElement,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  touches: ReturnType<typeof point>[],
  changedTouches = touches,
) {
  return handle.dispatch(type, testEvent(type, { touches, changedTouches }))
}

function key(target: FakeEventTarget, value: string) {
  return target.dispatch("keydown", testEvent("keydown", { key: value }))
}

function flushAnimationFrame() {
  const first = animationFrames.entries().next().value as [number, FrameRequestCallback] | undefined
  if (!first) return
  animationFrames.delete(first[0])
  first[1](0)
}

function monitorLocation(
  source: RailEntity,
  records: Array<{ data: Record<string, unknown> }>,
): MonitorLocation {
  return {
    source: { data: { railKind: source.kind, railId: source.id } },
    location: { current: { dropTargets: records } },
  }
}

function targetRecord(
  index: number,
  target: FakeElement,
  source: RailEntity,
  clientY: number,
) {
  const options = adapters.targets[index] as TargetOptions
  return {
    data: options.getData({
      input: { clientX: 20, clientY },
      element: target as unknown as HTMLElement,
      source: { data: { railKind: source.kind, railId: source.id } },
    }),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  adapters.draggables.length = 0
  adapters.targets.length = 0
  adapters.monitor = null
  adapters.autoScroll = null
  adapters.cleanupDraggable.mockReset()
  adapters.cleanupTarget.mockReset()
  adapters.cleanupMonitor.mockReset()
  adapters.cleanupAutoScroll.mockReset()
  fakeDocument = new FakeDocument()
  fakeWindow = new FakeEventTarget()
  animationFrames = new Map()
  nextFrameId = 1
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("document", fakeDocument)
  vi.stubGlobal("window", fakeWindow)
  vi.stubGlobal("MouseEvent", FakeMouseEvent)
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrameId++
    animationFrames.set(id, callback)
    return id
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => animationFrames.delete(id))
})

afterEach(async () => {
  await act(async () => {
    for (const renderer of renderers.splice(0)) renderer.unmount()
  })
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("useServerRailPdd behavior", () => {
  it("adapts native PDD availability, previews, hover expansion, and drop", async () => {
    const hook = await renderHook()
    const a = register(hook.current, { kind: "server", id: "a" }, rect(0, 40))
    const b = register(hook.current, { kind: "server", id: "b" }, rect(80, 120))
    const folder = register(hook.current, { kind: "folder", id: "f" }, rect(160, 200))
    register(hook.current, { kind: "folder", id: "g" }, rect(240, 280))

    const draggable = adapters.draggables[0] as DraggableOptions
    expect(draggable.canDrag()).toBe(true)
    expect(draggable.getInitialData()).toEqual({ railKind: "server", railId: "a" })
    const bTarget = adapters.targets[1] as TargetOptions
    expect(bTarget.canDrop({ source: { data: draggable.getInitialData() } })).toBe(true)
    expect(bTarget.canDrop({ source: { data: { railKind: "server", railId: "b" } } })).toBe(false)
    expect(bTarget.getIsSticky()).toBe(false)
    bTarget.getData({
      input: { clientX: 20, clientY: 100 },
      element: b.element as unknown as HTMLElement,
      source: { data: { railKind: "invalid", railId: "x" } },
    })

    const monitor = adapters.monitor as MonitorOptions
    expect(monitor.canMonitor({ source: { data: draggable.getInitialData() } })).toBe(true)
    expect(monitor.canMonitor({ source: { data: {} } })).toBe(false)
    monitor.onDragStart({ source: { data: {} } })
    monitor.onDragStart({ source: { data: draggable.getInitialData() } })
    expect(draggable.canDrag()).toBe(false)

    const afterB = targetRecord(1, b.element, a.entity, 115)
    monitor.onDrag(monitorLocation(a.entity, [afterB]))
    expect(hook.callbacks.onPreview).toHaveBeenLastCalledWith(expect.objectContaining({
      operation: "reorder-after",
    }))

    const intoFolder = targetRecord(2, folder.element, a.entity, 180)
    monitor.onDropTargetChange(monitorLocation(a.entity, [intoFolder]))
    const sameFolderNewSource = targetRecord(2, folder.element, b.entity, 180)
    monitor.onDrag(monitorLocation(b.entity, [sameFolderNewSource]))
    await act(async () => vi.advanceTimersByTime(500))
    expect(hook.callbacks.onHoverExpand).toHaveBeenCalledWith("f")

    monitor.onDrop(monitorLocation(a.entity, [afterB]))
    expect(hook.callbacks.onDrop).toHaveBeenCalledWith(expect.objectContaining({
      operation: "reorder-after",
    }))
    monitor.onDrag(monitorLocation(a.entity, [afterB]))
    monitor.onDropTargetChange(monitorLocation(a.entity, [afterB]))
    monitor.onDrop(monitorLocation(a.entity, [afterB]))
    const autoScroll = adapters.autoScroll as AutoScrollOptions
    expect(autoScroll.getAllowedAxis()).toBe("vertical")
    expect(autoScroll.getConfiguration()).toEqual({ maxScrollSpeed: "fast" })
  })

  it("supports keyboard pickup, spatial changes, drop, cancellation, and pending lock", async () => {
    const hook = await renderHook()
    const a = register(hook.current, { kind: "server", id: "a" }, rect(0, 40, 10, 50))
    const b = register(hook.current, { kind: "server", id: "b" }, rect(80, 120, 0, 40))
    register(hook.current, { kind: "folder", id: "f" }, rect(160, 200))

    expect(key(a.handle, "x").defaultPrevented).toBe(false)
    expect(key(a.handle, " ").defaultPrevented).toBe(true)
    expect(hook.callbacks.onAnnounce).toHaveBeenCalledWith(expect.stringContaining("A picked up"))
    flushAnimationFrame()
    expect(a.handle.focus).toHaveBeenCalledWith({ preventScroll: true })

    const replacement = register(hook.current, a.entity, rect(0, 40))
    expect(replacement.handle.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(key(a.handle, "ArrowDown").defaultPrevented).toBe(true)
    expect(hook.callbacks.onAnnounce).toHaveBeenCalledWith("A will move after B")
    expect(key(a.handle, "ArrowRight").defaultPrevented).toBe(true)
    expect(hook.callbacks.onAnnounce).toHaveBeenCalledWith("A will move into B")
    expect(key(a.handle, "ArrowLeft").defaultPrevented).toBe(true)
    expect(key(a.handle, "ArrowDown").defaultPrevented).toBe(true)
    expect(hook.callbacks.onAnnounce).toHaveBeenCalledWith("A will move into F")
    expect(key(a.handle, "Enter").defaultPrevented).toBe(true)
    expect(hook.callbacks.onDrop).toHaveBeenCalled()

    key(b.handle, " ")
    expect(key(b.handle, "ArrowUp").defaultPrevented).toBe(true)
    key(b.handle, " ")
    expect(hook.callbacks.onDrop).toHaveBeenCalledWith(expect.objectContaining({
      operation: "reorder-before",
    }))

    const folderHandle = (adapters.draggables[2] as DraggableOptions)
    expect(folderHandle.getInitialData()).toEqual({ railKind: "folder", railId: "f" })
    const registeredFolder = register(hook.current, { kind: "folder", id: "g" }, rect(240, 280))
    key(registeredFolder.handle, " ")
    expect(key(registeredFolder.handle, "ArrowDown").defaultPrevented).toBe(true)
    key(registeredFolder.handle, "Escape")

    key(a.handle, " ")
    const escape = key(fakeDocument, "Escape")
    expect(escape.propagationStopped).toBe(true)
    expect(hook.callbacks.onAnnounce).toHaveBeenCalledWith("A move cancelled")

    key(a.handle, " ")
    fakeWindow.dispatch("blur")
    key(a.handle, " ")
    fakeDocument.visibilityState = "hidden"
    fakeDocument.dispatch("visibilitychange")
    fakeDocument.visibilityState = "visible"

    key(a.handle, " ")
    await hook.rerender({ canStart: () => false })
    expect(hook.callbacks.onCancel).toHaveBeenCalled()
    const locked = key(a.handle, " ")
    expect(locked.defaultPrevented).toBe(false)
    expect(hook.callbacks.onAnnounce).toHaveBeenCalledWith(
      "A server rail move is already being saved",
    )
  })

  it("falls back across keyboard combine and relative-order availability", async () => {
    const hook = await renderHook()
    const b = register(hook.current, { kind: "server", id: "b" }, rect(0, 40))
    register(hook.current, { kind: "server", id: "a" }, rect(80, 120))

    expect(key(b.handle, " ").defaultPrevented).toBe(true)
    expect(key(b.handle, "ArrowDown").defaultPrevented).toBe(true)
    expect(hook.callbacks.onAnnounce).toHaveBeenLastCalledWith("B will move into A")

    expect(key(b.handle, "ArrowLeft").defaultPrevented).toBe(true)
    expect(hook.callbacks.onAnnounce).toHaveBeenLastCalledWith("B will move before A")

    hook.callbacks.getState.mockReturnValue({
      serverOrder: ["c", "d"],
      folderOrder: [],
      folders: {},
      expanded: [],
    })
    expect(key(b.handle, "ArrowLeft").defaultPrevented).toBe(false)
    expect(key(b.handle, "Escape").defaultPrevented).toBe(true)
  })

  it("separates taps, scroll, context menu, multi-touch, and cancellation", async () => {
    const hook = await renderHook()
    const a = register(hook.current, { kind: "server", id: "a" }, rect(0, 40))

    touch(a.handle, "touchstart", [point(1, 10, 10)])
    const tapEnd = touch(a.handle, "touchend", [], [point(1, 10, 10)])
    expect(tapEnd.defaultPrevented).toBe(true)
    expect(a.handle.clickCount).toBe(1)

    touch(a.handle, "touchstart", [point(2, 10, 10)])
    const scrollMove = touch(a.handle, "touchmove", [point(2, 10, 30)])
    expect(scrollMove.defaultPrevented).toBe(false)

    touch(a.handle, "touchstart", [point(3, 10, 10)])
    hook.scroll.dispatch("scroll")
    touch(a.handle, "touchmove", [point(3, 10, 30)])
    expect(hook.callbacks.onDragStart).not.toHaveBeenCalled()

    touch(a.handle, "touchstart", [point(4, 10, 10)])
    touch(a.handle, "touchstart", [point(4, 10, 10), point(5, 12, 12)])
    expect(hook.callbacks.onCancel).toHaveBeenCalled()

    touch(a.handle, "touchstart", [point(40, 10, 10)])
    touch(a.handle, "touchmove", [point(40, 10, 20), point(41, 12, 22)])

    touch(a.handle, "touchstart", [point(6, 10, 10)])
    touch(a.handle, "touchmove", [point(7, 10, 30)])
    touch(a.handle, "touchstart", [point(8, 10, 10)])
    touch(a.handle, "touchcancel", [])

    touch(a.handle, "touchstart", [point(9, 10, 10)])
    await act(async () => vi.advanceTimersByTime(650))
    a.handle.click()
    expect(a.handle.lastClickEvent?.defaultPrevented).toBe(true)
    expect(a.handle.lastClickEvent?.propagationStopped).toBe(true)

    touch(a.handle, "touchstart", [point(10, 10, 10)])
    await act(async () => vi.advanceTimersByTime(SERVER_RAIL_TOUCH_HOLD_MS))
    const clickCount = a.handle.clickCount
    touch(a.handle, "touchend", [], [point(10, 10, 10)])
    expect(a.handle.clickCount).toBe(clickCount)
    a.handle.click()
    expect(a.handle.lastClickEvent?.defaultPrevented).toBe(true)

    hook.callbacks.canStart.mockReturnValueOnce(true)
    touch(a.handle, "touchstart", [point(11, 10, 10)])
    await act(async () => vi.advanceTimersByTime(SERVER_RAIL_TOUCH_HOLD_MS))
    hook.callbacks.canStart.mockReturnValue(false)
    touch(a.handle, "touchmove", [point(11, 10, 30)])
    expect(hook.callbacks.onAnnounce).toHaveBeenCalledWith(
      "A server rail move is already being saved",
    )
  })

  it("drags by touch through every hit region and owns edge scroll only after hold", async () => {
    const hook = await renderHook()
    hook.scroll.bounds = rect(0, 100, 0, 56)
    hook.scroll.scrollTop = 20
    const a = register(hook.current, { kind: "server", id: "a" }, rect(0, 40))
    const b = register(hook.current, { kind: "server", id: "b" }, rect(80, 120))
    const f = register(hook.current, { kind: "folder", id: "f" }, rect(160, 200))
    const g = register(hook.current, { kind: "folder", id: "g" }, rect(240, 280))

    async function drag(
      source: typeof a,
      target: typeof a,
      identifier: number,
      startY: number,
      endY: number,
      includeChangedTouch = true,
    ) {
      touch(source.handle, "touchstart", [point(identifier, 20, startY)])
      await act(async () => vi.advanceTimersByTime(SERVER_RAIL_TOUCH_HOLD_MS))
      fakeDocument.points = [target.element]
      const move = touch(source.handle, "touchmove", [point(identifier, 20, endY)])
      expect(move.defaultPrevented).toBe(true)
      touch(source.handle, "touchmove", [point(identifier, 20, endY)])
      flushAnimationFrame()
      touch(
        source.handle,
        "touchend",
        [],
        includeChangedTouch ? [point(identifier, 20, endY)] : [],
      )
    }

    await drag(b, a, 1, 100, 5)
    await drag(a, b, 2, 10, 115, false)

    touch(a.handle, "touchstart", [point(3, 20, 10)])
    await act(async () => vi.advanceTimersByTime(SERVER_RAIL_TOUCH_HOLD_MS))
    fakeDocument.points = [f.element]
    touch(a.handle, "touchmove", [point(3, 20, 180)])
    const context = a.handle.dispatch("contextmenu", testEvent("contextmenu"))
    expect(context.defaultPrevented).toBe(true)
    touch(a.handle, "touchend", [], [point(3, 20, 180)])

    await drag(g, f, 4, 260, 176)
    await drag(f, g, 5, 180, 264)
    expect(hook.callbacks.onDrop.mock.calls.map(([instruction]) => instruction.operation))
      .toEqual(expect.arrayContaining([
        "reorder-before",
        "reorder-after",
        "combine",
      ]))
    expect(hook.scroll.scrollTop).not.toBe(20)
    expect(fakeDocument.removeAllRanges).toHaveBeenCalled()
    expect(fakeDocument.documentElement.style.userSelect).toBe("text")

    touch(a.handle, "touchstart", [point(6, 20, 10)])
    await act(async () => vi.advanceTimersByTime(SERVER_RAIL_TOUCH_HOLD_MS))
    fakeDocument.points = [a.element]
    touch(a.handle, "touchmove", [point(6, 20, 35)])
    touch(a.handle, "touchend", [], [])
    expect(hook.callbacks.onCancel).toHaveBeenCalled()
  })

  it("cancels when an active source leaves, but survives its lazy replacement", async () => {
    const hook = await renderHook()
    const a = register(hook.current, { kind: "server", id: "a" }, rect(0, 40))
    key(a.handle, " ")
    a.cleanup()
    const replacement = register(hook.current, a.entity, rect(0, 40))
    await act(async () => Promise.resolve())
    expect(hook.callbacks.onCancel).not.toHaveBeenCalled()
    replacement.cleanup()
    await act(async () => Promise.resolve())
    expect(hook.callbacks.onCancel).toHaveBeenCalledTimes(1)
    expect(adapters.cleanupTarget).toHaveBeenCalledTimes(2)
    expect(adapters.cleanupDraggable).toHaveBeenCalledTimes(2)
  })
})
