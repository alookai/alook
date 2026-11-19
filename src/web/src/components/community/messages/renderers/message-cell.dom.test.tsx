import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render } from "@/test/react-dom-harness"
import { ChatscopeMessageCell } from "./chatscope-message-cell"
import { CurrentMessageCell } from "./current-message-cell"
import { MessageCell, MessageRendererContext } from "./message-cell"
import type { MessageCellPresentationProps } from "./message-cell-types"

function fixture(action: () => void): MessageCellPresentationProps {
  return {
    message: { id: "cell-1", type: "chat", authorId: "peer", authorName: "Peer", content: "<script>unsafe()</script>", createdAt: "2026-11-18T00:00:00Z", grouped: false },
    authorName: "Peer", timestamp: "08:00", viewerUserId: "viewer", compact: false, grouped: false, selected: false, highlighted: false,
    slots: {
      avatar: <button aria-label="Open Peer profile" onClick={action}>P</button>,
      header: <strong>Peer</strong>, reply: <button onClick={action}>Show original</button>,
      content: <p>{"<script>unsafe()</script>"}</p>, footer: <button onClick={action}>1 reply</button>,
      actions: <button onClick={action}>Copy message</button>, selection: null,
    },
  }
}
describe("message visual cell boundary", () => {
  it.each([CurrentMessageCell, ChatscopeMessageCell])("retains safe content and canonical action nodes in %s", Renderer => {
    const action = vi.fn()
    const view = render(createElement(Renderer, fixture(action)))
    expect(view.getByText("<script>unsafe()</script>")).toBeVisible()
    expect(view.container.querySelector("script")).toBeNull()
    fireEvent.click(view.getByRole("button", { name: "Open Peer profile" }))
    fireEvent.click(view.getByRole("button", { name: "Copy message" }))
    fireEvent.click(view.getByRole("button", { name: "Show original" }))
    fireEvent.click(view.getByRole("button", { name: "1 reply" }))
    expect(action).toHaveBeenCalledTimes(4)
    if (Renderer === ChatscopeMessageCell) {
      expect(view.container.querySelectorAll("section.cs-message")).toHaveLength(1)
      expect(view.container.querySelector(".cs-message__custom-content p")).toHaveTextContent("<script>")
      expect(view.container.querySelector(".cs-message-list")).toBeNull()
    }
  })

  it("replaces only the visual cell when its context changes", () => {
    const props = fixture(vi.fn())
    const tree = (id: "current" | "chatscope") => <MessageRendererContext.Provider value={{ id, component: id === "current" ? CurrentMessageCell : ChatscopeMessageCell, revision: id === "current" ? 0 : 1 }}><div data-testid="retained-row"><MessageCell {...props} /></div></MessageRendererContext.Provider>
    const view = render(tree("current"))
    const outer = view.getByTestId("retained-row")
    view.rerender(tree("chatscope"))
    expect(view.getByTestId("retained-row")).toBe(outer)
    expect(view.container.querySelectorAll("section.cs-message")).toHaveLength(1)
    view.rerender(tree("current"))
    expect(view.getByTestId("retained-row")).toBe(outer)
    expect(view.container.querySelector(".cs-message")).toBeNull()
    expect(view.getByRole("button", { name: "Copy message" })).toBeVisible()
  })

  it.each([CurrentMessageCell, ChatscopeMessageCell])("keeps canonical host ownership for own and peer messages in %s", Renderer => {
    for (const authorId of ["peer", "viewer"]) {
      const props = fixture(vi.fn())
      const view = render(<Renderer {...props} message={{ ...props.message, authorId }} slots={{ ...props.slots, selection: <input type="checkbox" aria-label="Select message" /> }} />)
      try {
        const avatar = view.getByRole("button", { name: "Open Peer profile" })
        const body = view.getByRole("checkbox", { name: "Select message" }).parentElement!
        const row = avatar.parentElement!
        const host = view.container.querySelector("[data-message-renderer]")!
        expect(row.children[0]).toBe(avatar)
        expect(row.children[1]).toBe(body)
        expect(row.parentElement).toBe(host)
        expect(view.getByRole("button", { name: "Copy message" }).parentElement).toBe(host)
        expect(view.getByRole("button", { name: "Show original" }).parentElement).toBe(host)
        expect(body).toContainElement(view.getByText("Peer", { selector: "strong" }))
        expect(body).toContainElement(view.getByText("<script>unsafe()</script>"))
        expect(body).toContainElement(view.getByRole("button", { name: "1 reply" }))
        if (Renderer === ChatscopeMessageCell) expect(body.querySelectorAll("section.cs-message")).toHaveLength(1)
      } finally { view.unmount() }
    }
  })

  it("shows an explicit failure and a working Return to Current action", () => {
    const back = vi.fn()
    const view = render(<MessageRendererContext.Provider value={{ id: "chatscope", component: null, revision: 1, onReturnCurrent: back }}><MessageCell {...fixture(vi.fn())} /></MessageRendererContext.Provider>)
    expect(view.getByRole("alert")).toHaveTextContent("could not display")
    expect(view.queryByText("<script>unsafe()</script>")).toBeNull()
    fireEvent.click(view.getByRole("button", { name: "Return to Current" }))
    expect(back).toHaveBeenCalledOnce()
  })

  it("catches a throwing candidate and resets the cell when Current is chosen", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const failed = vi.fn()
    const Broken = () => { throw new Error("Cell render failed") }
    try {
      const view = render(<MessageRendererContext.Provider value={{ id: "chatscope", component: Broken, revision: 1, onError: failed }}><MessageCell {...fixture(vi.fn())} /></MessageRendererContext.Provider>)
      expect(view.getByRole("alert")).toHaveTextContent("could not display")
      expect(failed).toHaveBeenCalledOnce()
      expect(view.queryByText("<script>unsafe()</script>")).toBeNull()
      view.rerender(<MessageRendererContext.Provider value={{ id: "current", component: CurrentMessageCell, revision: 2 }}><MessageCell {...fixture(vi.fn())} /></MessageRendererContext.Provider>)
      expect(view.queryByRole("alert")).toBeNull()
      expect(view.getByText("<script>unsafe()</script>")).toBeVisible()
    } finally { error.mockRestore() }
  })
})
