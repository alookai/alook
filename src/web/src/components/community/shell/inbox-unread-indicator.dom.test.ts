import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { InboxUnreadIndicator } from "./inbox-unread-indicator"

vi.mock("@/components/ui/number-ticker", () => ({ NumberTicker: ({ value }: { value: number }) => createElement("span", { "data-testid": "count" }, value) }))

describe("Inbox unread indicator", () => {
  it("retracts on open, re-enters on close, updates count, and retains the outgoing digit on clear", () => {
    const view = render(createElement(InboxUnreadIndicator, { count: 0, open: false }))
    const indicator = () => view.container.querySelector('[data-slot="inbox-unread-indicator"]')!
    expect(indicator()).toHaveAttribute("data-unread", "false")
    for (const count of [3, 8, 2]) {
      view.rerender(createElement(InboxUnreadIndicator, { count, open: false }))
      expect(indicator()).toHaveAttribute("data-unread", "true")
      expect(view.getByTestId("count")).toHaveTextContent(String(count))
    }
    view.rerender(createElement(InboxUnreadIndicator, { count: 2, open: true }))
    expect(indicator()).toHaveAttribute("data-unread", "false")
    view.rerender(createElement(InboxUnreadIndicator, { count: 2, open: false }))
    expect(indicator()).toHaveAttribute("data-unread", "true")
    view.rerender(createElement(InboxUnreadIndicator, { count: 0, open: false }))
    expect(indicator()).toHaveAttribute("data-unread", "false")
    expect(view.getByTestId("count")).toHaveTextContent("2")
  })

  it("shows an ellipsis for incomplete or overflowing counts and restores exact numbers", () => {
    const view = render(createElement(InboxUnreadIndicator, { count: 7, partial: true, open: false }))
    const ellipsis = () => view.container.querySelector('[data-slot="inbox-unread-ellipsis"]')
    expect(ellipsis()).not.toBeNull()
    expect(view.queryByTestId("count")).toBeNull()
    view.rerender(createElement(InboxUnreadIndicator, { count: 99, open: false }))
    expect(ellipsis()).toBeNull()
    expect(view.getByTestId("count")).toHaveTextContent("99")
    view.rerender(createElement(InboxUnreadIndicator, { count: 100, open: false }))
    expect(ellipsis()).not.toBeNull()
    expect(view.queryByTestId("count")).toBeNull()
    view.rerender(createElement(InboxUnreadIndicator, { count: 0, open: false }))
    expect(ellipsis()).not.toBeNull()
    view.rerender(createElement(InboxUnreadIndicator, { count: 12, open: false }))
    expect(ellipsis()).toBeNull()
    expect(view.getByTestId("count")).toHaveTextContent("12")
  })
})
