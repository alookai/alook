import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import ServerSidebarLayout from "./layout"

vi.mock("@/components/community/shell/server-sidebar-slot", () => ({
  ServerSidebarSlot: ({ serverId }: { serverId: string }) => createElement("aside", { "data-server-id": serverId }, "Sidebar"),
}))

describe("server sidebar layout", () => {
  it("renders its scoped sidebar without reading the empty child route", async () => {
    const pending = new Promise<void>(() => {})
    const readLeaf = vi.fn(() => { throw pending })
    const props = { params: Promise.resolve({ serverId: "server-1" }), children: createElement(readLeaf) }
    const layout = await ServerSidebarLayout(props)

    expect(renderToStaticMarkup(layout)).toBe('<aside data-server-id="server-1">Sidebar</aside>')
    expect(readLeaf).not.toHaveBeenCalled()
  })
})
