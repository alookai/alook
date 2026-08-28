import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it } from "vitest"
import { tid } from "@/lib/community/testids"
import { TypingIndicator } from "./typing-indicator"

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.children.map((child) => (
    typeof child === "string" ? child : textContent(child)
  )).join("")
}

describe("TypingIndicator", () => {
  it("keeps a long single name in one bounded live status", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(TypingIndicator, {
        names: ["A teammate with an exceptionally long account name"],
      }))
    })
    const status = renderer.root.findByProps({ "data-testid": tid.typingIndicator })
    expect(status.props).toMatchObject({
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    })
    expect(status.props.className).toContain("max-w-full")
    const label = status.findAllByType("span").find((node) => node.props.className === "min-w-0 truncate")
    expect(label).toBeDefined()
    expect(textContent(label!)).toContain("is typing…")
  })

  it("summarizes four or more typers without rendering every long name", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(TypingIndicator, {
        names: ["Alice", "Bob", "Carol", "Dorothy"],
      }))
    })
    const status = renderer.root.findByProps({ "data-testid": tid.typingIndicator })
    expect(textContent(status)).toContain("4 people are typing…")
    expect(textContent(status)).not.toContain("Dorothy")
  })
})
