import { useCallback, useLayoutEffect, useRef } from "react"
import { useVirtualizer, type ReactVirtualizer } from "@tanstack/react-virtual"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { COMMUNITY_VIRTUALIZER_REACT_OPTIONS } from "@/hooks/community/virtualizer-react-options"
import { VirtualRows } from "@/components/community/messages/virtual-cursor-list"
import { useObservedRegion } from "./regions"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "./telemetry"
import { visibleVirtualItems } from "./virtual-window"

vi.mock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => new URLSearchParams() }))
const events: Array<{ name: string; attributes: Record<string, string> }> = []
const observers = new Map<Element, ResizeObserverCallback>()
let height: number
let native: ReactVirtualizer<HTMLDivElement, Element>
let mounted: ReturnType<typeof render> | undefined
type Row = { id: string }
function WindowPanel({ rows, overscan, attached = true }: { rows: Row[]; overscan: number; attached?: boolean }) {
  const root = useRef<HTMLDivElement | null>(null)
  const bind = useCallback((element: HTMLDivElement | null) => {
    root.current = element
    if (!element) return
    Object.defineProperties(element, {
      clientHeight: { configurable: true, get: () => height },
      offsetHeight: { configurable: true, get: () => height },
      offsetWidth: { configurable: true, value: 320 },
      scrollHeight: { configurable: true, value: 2000 },
      scrollTo: { configurable: true, value: ({ top }: ScrollToOptions) => { element.scrollTop = top ?? 0 } },
    })
  }, [])
  // eslint-disable-next-line react-hooks/incompatible-library -- native Virtual regression
  const virtualizer = useVirtualizer({
    ...COMMUNITY_VIRTUALIZER_REACT_OPTIONS,
    count: rows.length, getScrollElement: () => root.current,
    estimateSize: () => 100, measureElement: () => 100,
    getItemKey: index => rows[index]!.id, overscan,
    initialRect: { width: 320, height: 800 }, initialOffset: 500,
  })
  useLayoutEffect(() => { native = virtualizer })
  const selected = visibleVirtualItems(virtualizer).map(item => rows[item.index]!)
  useObservedRegion("messages", selected.length > 0, selected.length)
  return attached ? <div ref={bind} data-testid="viewport"><VirtualRows items={rows} virtualizer={virtualizer} renderItem={row => <p>{row.id}</p>} /></div> : null
}
function rows() {
  return Array.from({ length: 20 }, (_, index) => ({ id: "row-" + index }))
}
const ready = () => events.filter(event => event.name === "region.ready_commit")
const indexes = () => visibleVirtualItems(native).map(item => item.index)
beforeEach(() => {
  height = 200; events.length = 0; observers.clear()
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: Element) { observers.set(element, this.callback) }
    unobserve(element: Element) { observers.delete(element) }
    disconnect() { observers.clear() }
  })
  configureTelemetry({ session_id: "window-session" }, true)
  installTelemetrySink(event => events.push(event))
})
afterEach(async () => {
  await act(async () => { mounted?.unmount(); mounted = undefined; retireTelemetry() })
  vi.unstubAllGlobals()
})

it.each([8, 5])("excludes mounted overscan %s from initial ready and emits no background update signals", async overscan => {
  const values = rows()
  mounted = render(<WindowPanel rows={values} overscan={overscan} />)
  await waitFor(() => expect(ready().at(-1)?.attributes.row_count).toBe("2"))
  expect(indexes()).toEqual([5, 6])
  expect(native.getVirtualItems().some(item => item.index === 8)).toBe(true)
  expect(mounted.getByText("row-8")).toBeInTheDocument()
  values[8] = { id: "updated-row-8" }
  mounted.rerender(<WindowPanel rows={values} overscan={overscan} />)
  expect(ready()).toHaveLength(1)
  expect(ready()[0]!.attributes).not.toHaveProperty("data_version")
  expect(ready()[0]!.attributes).not.toHaveProperty("ws_event_id")
  const viewport = mounted.getByTestId("viewport")
  await act(async () => { viewport.scrollTop = 650; fireEvent.scroll(viewport) })
  await waitFor(() => expect(indexes()).toEqual([6, 7, 8]))
  await act(async () => {
    height = 50
    observers.get(viewport)!([], {} as ResizeObserver)
  })
  await waitFor(() => expect(indexes()).toEqual([6]))
  expect(ready()).toHaveLength(1)
})

it("counts partial rows and excludes rows touching only an outside boundary", async () => {
  mounted = render(<WindowPanel rows={rows()} overscan={8} />)
  await waitFor(() => expect(indexes()).toEqual([5, 6]))
  const viewport = mounted.getByTestId("viewport")
  await act(async () => { viewport.scrollTop = 550; fireEvent.scroll(viewport) })
  await waitFor(() => expect(indexes()).toEqual([5, 6, 7]))
  await act(async () => { viewport.scrollTop = 600; fireEvent.scroll(viewport) })
  await waitFor(() => expect(indexes()).toEqual([6, 7]))
})

it.each(["unattached", "zero-height"])("does not certify the initialRect as a %s viewport", async mode => {
  if (mode === "zero-height") height = 0
  mounted = render(<WindowPanel rows={rows()} overscan={5} attached={mode !== "unattached"} />)
  await act(async () => {})
  expect(indexes()).toEqual([])
  expect(ready()).toEqual([])
})
