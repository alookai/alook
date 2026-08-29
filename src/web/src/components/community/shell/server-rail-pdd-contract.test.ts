import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8")

describe("server rail PDD component contract", () => {
  it("uses Pragmatic Drag and Drop only in the server rail", () => {
    const rail = read("./server-rail.tsx")
    const adapter = read("./use-server-rail-pdd.ts")
    const channelTree = read("../channels/use-channel-tree.ts")
    expect(rail).toContain('from "./use-server-rail-pdd"')
    expect(adapter).toContain("@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter")
    expect(adapter).toContain("getIsSticky: () => false")
    expect(rail).not.toContain("@dnd-kit")
    expect(channelTree).toContain("@dnd-kit")
  })

  it("pins one inset indicator, one combine outline, and the 500ms expansion", () => {
    const server = read("./sortable-server.tsx")
    const folder = read("./rail-folder.tsx")
    const adapter = read("./use-server-rail-pdd.ts")
    for (const source of [server, folder]) {
      expect(source).toContain("h-0.5 w-9")
      expect(source).toContain("bg-primary/10 outline outline-2! outline-primary")
      expect(source).not.toContain("ring-2 ring-primary")
    }
    expect(folder).toContain("transition-[border-radius,background-color]")
    expect(server).toContain("transition-[border-radius,background-color,border-color,opacity,transform]")
    expect(adapter).toContain("}, 500)")
  })

  it("uses drag as the only spatial model and retains only Ungroup", () => {
    const server = read("./sortable-server.tsx")
    const folder = read("./rail-folder.tsx")
    const rail = read("./server-rail.tsx")
    expect(server).not.toContain("Move…")
    expect(server).not.toContain("Create group")
    expect(folder).not.toContain("Move…")
    expect(folder).toContain("Ungroup")
    expect(rail).not.toContain("ServerRailMoveMenu")
  })

  it("separates touch scroll intent and exposes keyboard drag instructions", () => {
    const adapter = read("./use-server-rail-pdd.ts")
    const rail = read("./server-rail.tsx")
    expect(adapter).toContain("SERVER_RAIL_TOUCH_HOLD_MS = 450")
    expect(adapter).toContain("SERVER_RAIL_TOUCH_DRIFT_PX = 10")
    expect(adapter).toContain('addEventListener("touchstart", onTouchStart, { passive: false })')
    expect(adapter).toContain("event.preventDefault()")
    expect(adapter).toContain('addEventListener("touchmove", onTouchMove, { passive: false })')
    expect(adapter).toContain("scroll.scrollTop -= touch.clientY - previousY")
    expect(adapter).toContain("requestAnimationFrame(runTouchFrame)")
    expect(adapter).not.toContain("matchMedia")
    expect(rail).toContain("Press Space to pick up a server or group")
    expect(rail).toContain("onAnnounce: announce")
  })
})
