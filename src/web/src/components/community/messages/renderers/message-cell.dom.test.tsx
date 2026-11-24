import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render } from "@/test/react-dom-harness"
import { CurrentMessageCell } from "./current-message-cell"
import { MessageCell } from "./message-cell"
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
  it.each([CurrentMessageCell, MessageCell])("retains safe content and canonical action nodes in %s", Renderer => {
    const action = vi.fn()
    const view = render(createElement(Renderer, fixture(action)))
    expect(view.getByText("<script>unsafe()</script>")).toBeVisible()
    expect(view.container.querySelector("script")).toBeNull()
    expect(view.container.querySelector('[data-message-renderer="current"]')).not.toBeNull()
    fireEvent.click(view.getByRole("button", { name: "Open Peer profile" }))
    fireEvent.click(view.getByRole("button", { name: "Copy message" }))
    fireEvent.click(view.getByRole("button", { name: "Show original" }))
    fireEvent.click(view.getByRole("button", { name: "1 reply" }))
    expect(action).toHaveBeenCalledTimes(4)
  })

  it.each([CurrentMessageCell, MessageCell])("keeps canonical host ownership for own and peer messages in %s", Renderer => {
    for (const authorId of ["peer", "viewer"]) {
      const props = fixture(vi.fn())
      const view = render(<Renderer {...props} message={{ ...props.message, authorId }} slots={{ ...props.slots, selection: <input type="checkbox" aria-label="Select message" /> }} />)
      try {
        const avatar = view.getByRole("button", { name: "Open Peer profile" })
        const body = view.getByRole("checkbox", { name: "Select message" }).parentElement!
        const row = avatar.parentElement!
        const host = view.container.querySelector('[data-message-renderer="current"]')!
        expect(row.children[0]).toBe(avatar)
        expect(row.children[1]).toBe(body)
        expect(row.parentElement).toBe(host)
        expect(view.getByRole("button", { name: "Copy message" }).parentElement).toBe(host)
        expect(view.getByRole("button", { name: "Show original" }).parentElement).toBe(host)
        expect(body).toContainElement(view.getByText("Peer", { selector: "strong" }))
        expect(body).toContainElement(view.getByText("<script>unsafe()</script>"))
        expect(body).toContainElement(view.getByRole("button", { name: "1 reply" }))
      } finally { view.unmount() }
    }
  })
})
