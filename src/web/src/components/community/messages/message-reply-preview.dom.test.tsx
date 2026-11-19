import { describe, expect, it, vi } from "vitest"
import { fireEvent, render } from "@/test/react-dom-harness"
import { MessageReplyPreview } from "./message-reply-preview"

describe("shared message reply preview", () => {
  it("keeps the quote button and allocated row through loading, resolution and deletion", () => {
    const jump = vi.fn()
    const reply = { id: "target", authorName: "Peer", text: "stale text must not appear", loading: true }
    const view = render(<MessageReplyPreview reply={reply} authorName="Peer" onJump={jump} />)
    const button = view.getByRole("button", { name: "Show original message" })
    const reserved = getComputedStyle(button).height
    expect(Number.parseFloat(reserved)).toBeGreaterThan(0)
    expect(button).toHaveAttribute("aria-busy", "true")
    expect(view.getByRole("status", { name: "Loading quoted message" })).toBeVisible()
    expect(view.container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(2)
    expect(view.queryByText(reply.text)).toBeNull()
    fireEvent.click(button)
    expect(jump).toHaveBeenCalledTimes(1)

    view.rerender(<MessageReplyPreview reply={{ ...reply, loading: false, text: "Actual referenced content" }} authorName="Peer" onJump={jump} />)
    expect(view.getByRole("button", { name: "Show original message" })).toBe(button)
    expect(getComputedStyle(button).height).toBe(reserved)
    expect(view.queryByRole("status")).toBeNull()
    expect(view.container.querySelector('[data-slot="skeleton"]')).toBeNull()
    expect(view.getByText("Actual referenced content")).toBeVisible()
    fireEvent.click(button)
    expect(jump).toHaveBeenCalledTimes(2)

    view.rerender(<MessageReplyPreview reply={{ ...reply, deleted: true }} authorName="Peer" onJump={jump} />)
    expect(view.getByRole("button", { name: "Show original message" })).toBe(button)
    expect(getComputedStyle(button).height).toBe(reserved)
    expect(view.getByText("Original message was deleted")).toBeVisible()
    expect(view.queryByRole("status")).toBeNull()
    expect(button).not.toHaveAttribute("aria-busy")
    fireEvent.click(button)
    expect(jump).toHaveBeenCalledTimes(3)
  })

  it.each(["Loading message…", "Loading message..."])("renders legitimate same-label reply text %s without a skeleton", text => {
    const view = render(<MessageReplyPreview reply={{ id: "target", authorName: "Peer", text }} authorName="Peer" />)
    expect(view.getByText(text)).toBeVisible()
    expect(view.queryByRole("status")).toBeNull()
    expect(view.container.querySelector('[data-slot="skeleton"]')).toBeNull()
  })

  it("does not reserve a quote when the relation is absent", () => {
    const view = render(<MessageReplyPreview reply={undefined} authorName="Peer" />)
    expect(view.container).toBeEmptyDOMElement()
  })
})
