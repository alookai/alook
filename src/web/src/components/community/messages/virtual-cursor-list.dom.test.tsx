import { createElement, useCallback, useLayoutEffect, useRef } from "react"
import { useVirtualizer, type ReactVirtualizer } from "@tanstack/react-virtual"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { COMMUNITY_VIRTUALIZER_REACT_OPTIONS } from "@/hooks/community/virtualizer-react-options"
import { VirtualRows } from "./virtual-cursor-list"

const items = Array.from({ length: 100 }, (_, index) => `row-${index}`)

function List({ direct, mode, ready }: {
  direct: boolean
  mode: "transform" | "position"
  ready: (virtualizer: ReactVirtualizer<HTMLDivElement, Element>) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const bind = useCallback((node: HTMLDivElement | null) => {
    root.current = node
    if (!node) return
    Object.defineProperties(node, {
      clientHeight: { configurable: true, value: 120 },
      clientWidth: { configurable: true, value: 320 },
      offsetHeight: { configurable: true, value: 140 },
      offsetWidth: { configurable: true, value: 340 },
      scrollHeight: { configurable: true, value: 4032 },
      scrollTo: { configurable: true, value: ({ top = 0 }: ScrollToOptions) => { node.scrollTop = top } },
    })
  }, [])
  // eslint-disable-next-line react-hooks/incompatible-library -- Native mutable Virtualizer cannot be safely memoized; this fixture tests its actual React adapter.
  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    ...COMMUNITY_VIRTUALIZER_REACT_OPTIONS,
    directDomUpdates: direct,
    directDomUpdatesMode: mode,
    count: items.length,
    getScrollElement: () => root.current,
    getItemKey: (index) => items[index],
    estimateSize: () => 40,
    paddingStart: 32,
    overscan: 5,
    initialRect: { width: 320, height: 120 },
  })
  useLayoutEffect(() => { ready(virtualizer) }, [ready, virtualizer])
  return createElement("div", { ref: bind, "data-testid": "viewport" },
    createElement(VirtualRows<string>, {
      items,
      virtualizer,
      reactLayout: !direct,
      directDomUpdatesMode: mode,
      getRowAttributes: (item) => ({ "data-row-id": item }),
      renderItem: (item) => item,
    }, createElement("div", { "data-testid": "sticky-date" }, "Today")),
  )
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(40)
})
afterEach(() => { vi.restoreAllMocks() })

describe.each([
  { direct: true, mode: "transform" as const },
  { direct: true, mode: "position" as const },
  { direct: false, mode: "transform" as const },
])("native row shell with direct geometry=$direct, mode=$mode", ({ direct, mode }) => {
  it("mounts the loaded range in the scroll dispatch and measures the visible client viewport", () => {
    let native!: ReactVirtualizer<HTMLDivElement, Element>
    const view = render(createElement(List, { direct, mode, ready: (instance) => { native = instance } }))
    const root = view.getByTestId("viewport")
    expect(native.scrollRect).toEqual({ width: 320, height: 120 })
    expect(view.getByTestId("sticky-date").parentElement).toBe(root.firstElementChild)
    expect(root.querySelector('[data-row-id="row-25"]')).toBeNull()
    act(() => {
      root.scrollTop = 800
      root.dispatchEvent(new Event("scroll"))
      const row = root.querySelector<HTMLElement>('[data-row-id="row-25"]')
      expect(row).not.toBeNull()
      expect(row!.dataset.index).toBe("25")
      if (direct && mode === "position") {
        expect(row!.style.transform).toBe("")
        expect(row!.style.top).toBe("1032px")
      } else {
        expect(row!.style.transform).toBe("translate3d(0, 1032px, 0)")
      }
    })
    expect(root.firstElementChild).toHaveStyle({ height: "4032px" })
    const row = root.querySelector<HTMLElement>('[data-row-id="row-26"]')!
    act(() => { native.resizeItem(25, 80) })
    expect(root.querySelector('[data-row-id="row-26"]')).toBe(row)
    if (direct && mode === "position") {
      expect(row.style.top).toBe("1112px")
      expect(row.style.transform).toBe("")
    } else {
      expect(row.style.transform).toBe("translate3d(0, 1112px, 0)")
    }
    expect(root.firstElementChild).toHaveStyle({ height: "4072px" })
  })
})
