import { render } from "@/test/react-dom-harness"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ServerRailDragPreview } from "./server-rail-drag-preview"
import type { RailDndController, RailReturn } from "./use-server-rail-dnd"
import type { RailEntity } from "@/lib/community/server-rail-model"

const drag = vi.hoisted(() => ({ entity: null as RailEntity | null, offset: null as { x: number; y: number } | null, returning: null as RailReturn | null }))
vi.mock("./use-server-rail-dnd", () => ({ useServerRailDrag: () => drag }))

const props = {
  dnd: {} as RailDndController,
  servers: new Map([["a", { id: "a", name: "Alpha", initial: "A", active: false, unread: true, mentions: 2 }]]),
  folderNames: new Map([["f", "Team"]]),
  state: { serverIds: ["a"], folderIds: ["f"], folders: { f: ["a"] }, expanded: [] },
  activeServerId: "a",
}

describe("server rail moving preview", () => {
  const nativeAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate")
  afterEach(() => {
    drag.returning = null
    if (nativeAnimate) Object.defineProperty(Element.prototype, "animate", nativeAnimate)
    else Reflect.deleteProperty(Element.prototype, "animate")
  })
  it("returns to the current source center with no stationary delay and removes the animation on cleanup", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList)
    const source = document.createElement("div")
    document.body.appendChild(source)
    source.getBoundingClientRect = () => ({ left: 8, top: 72, width: 40, height: 40 }) as DOMRect
    const animation = { onfinish: null as (() => void) | null, cancel: vi.fn() }
    const animate = vi.fn(() => animation), completeReturn = vi.fn()
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate })
    drag.entity = { kind: "server", id: "a" }; drag.offset = { x: 300, y: 200 }
    drag.returning = { entity: drag.entity, offset: drag.offset, element: source }
    const result = render(<ServerRailDragPreview {...props} dnd={{ completeReturn } as unknown as RailDndController} />)
    expect(document.querySelector('[data-rail-preview-phase="returning"]')).not.toBeNull()
    expect(animate).toHaveBeenCalledExactlyOnceWith([
      { transform: "translate(300px, 200px)" }, { transform: "translate(6px, 70px)" },
    ], { duration: 150, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "forwards" })
    animation.onfinish?.()
    expect(completeReturn).toHaveBeenCalledExactlyOnceWith(drag.returning)
    result.unmount()
    expect(animation.cancel).toHaveBeenCalledTimes(1)
    expect(animation.onfinish).toBeNull()
    source.remove()
  })
  it.each(["reduced", "removed"])("restores immediately when the source is %s", (reason) => {
    const source = document.createElement("div")
    if (reason !== "removed") document.body.appendChild(source)
    source.getBoundingClientRect = () => ({ left: 8, top: 72, width: 40, height: 40 }) as DOMRect
    const media = vi.spyOn(window, "matchMedia").mockReturnValue({ matches: reason === "reduced" } as MediaQueryList)
    const animate = vi.fn(), completeReturn = vi.fn()
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate })
    try {
      drag.entity = { kind: "server", id: "a" }; drag.offset = { x: 300, y: 200 }
      drag.returning = { entity: drag.entity, offset: drag.offset, element: source }
      render(<ServerRailDragPreview {...props} dnd={{ completeReturn } as unknown as RailDndController} />)
      expect(completeReturn).toHaveBeenCalledExactlyOnceWith(drag.returning)
      expect(animate).not.toHaveBeenCalled()
    } finally { source.remove(); media.mockRestore() }
  })
  it("moves the same icon and name bubble together, without an indicator, and removes both on release", () => {
    drag.entity = { kind: "server", id: "a" }; drag.offset = { x: 100, y: 200 }
    const result = render(<ServerRailDragPreview {...props} />)
    const preview = document.querySelector('[data-rail-floating-preview="server"]')!
    expect(preview).toHaveAttribute("aria-hidden", "true")
    expect(preview.firstElementChild).toHaveStyle({ transform: "translate(100px, 200px)" })
    expect(preview.querySelector('[data-slot="community-server-rail-drag-name"]')).toHaveTextContent("Alpha")
    expect(preview.querySelector('[data-slot="community-server-rail-drag-glyph"]')).toHaveClass("opacity-50")
    expect(preview.querySelector('[data-slot="community-server-rail-drag-name"]')?.parentElement).toBe(preview.firstElementChild)
    expect(preview.querySelector('[data-rail-drag-preview]')).toHaveClass("size-10")
    expect(preview.querySelector('[data-slot="community-server-rail-drag-mentions"]')).toHaveTextContent("2")
    expect(preview.querySelector('[data-slot="community-server-rail-indicator"]')).toBeNull()
    drag.offset = { x: 160, y: 320 }
    result.rerender(<ServerRailDragPreview {...props} />)
    expect(document.querySelector('[data-rail-floating-preview="server"]')).toBe(preview)
    expect(preview.firstElementChild).toHaveStyle({ transform: "translate(160px, 320px)" })
    drag.entity = null; drag.offset = null
    result.rerender(<ServerRailDragPreview {...props} />)
    expect(document.querySelector('[data-rail-floating-preview]')).toBeNull()
  })

  it("reuses folder collection thumbnails and its name without a base indicator", () => {
    drag.entity = { kind: "folder", id: "f" }; drag.offset = { x: 20, y: 80 }
    const view = render(<ServerRailDragPreview {...props} />)
    const preview = document.querySelector('[data-rail-floating-preview="folder"]')!
    expect(preview.querySelector('[data-slot="community-server-rail-drag-name"]')).toHaveTextContent("Team")
    expect(preview.querySelector('[role="img"]')).toHaveAttribute("aria-label", "Alpha")
    expect(preview.querySelector('[data-slot="community-server-rail-indicator"]')).toBeNull()
    expect(preview.querySelector('[data-slot="community-server-rail-drag-folder"]')).toHaveClass("size-10", "rounded-xl")
    expect(preview.firstElementChild).toHaveClass("size-11")
    view.rerender(<ServerRailDragPreview {...props} activeServerId="other" />)
    expect(preview.querySelector('[data-slot="community-server-rail-drag-folder"]')).toHaveClass("size-10", "rounded-[18px]")
  })
})
