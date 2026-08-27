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

  it("keeps Move behind contextual actions and uses a compact two-step sheet", () => {
    const server = read("./sortable-server.tsx")
    const folder = read("./rail-folder.tsx")
    const move = read("./server-rail-move-menu.tsx")
    expect(server).toContain("Move…")
    expect(folder).toContain("Move…")
    expect(move).toContain("Choose a destination, then its exact position.")
    expect(move).toContain('side="bottom"')
    expect(move).toContain("tid.serverRailMoveDestination")
    expect(move).not.toContain("fixed right-")
  })
})
