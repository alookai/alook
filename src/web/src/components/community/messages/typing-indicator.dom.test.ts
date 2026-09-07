import { createElement } from "react"
import { describe, expect, it } from "vitest"
import { tid } from "@/lib/community/testids"
import { render, screen } from "@/test/react-dom-harness"
import { TypingIndicator } from "./typing-indicator"

describe("TypingIndicator", () => {
  it("keeps a long single name in one bounded live status", () => {
    render(createElement(TypingIndicator, {
      names: ["A teammate with an exceptionally long account name"],
    }))

    const status = screen.getByTestId(tid.typingIndicator)
    expect(status).toHaveAttribute("role", "status")
    expect(status).toHaveAttribute("aria-live", "polite")
    expect(status).toHaveAttribute("aria-atomic", "true")
    expect(status).toHaveClass("max-w-full")
    const label = status.querySelector(".min-w-0.truncate")
    expect(label).toHaveTextContent("is typing…")
  })

  it("summarizes four or more typers without rendering every long name", () => {
    render(createElement(TypingIndicator, {
      names: ["Alice", "Bob", "Carol", "Dorothy"],
    }))

    const status = screen.getByTestId(tid.typingIndicator)
    expect(status).toHaveTextContent("4 people are typing…")
    expect(status).not.toHaveTextContent("Dorothy")
  })
})
