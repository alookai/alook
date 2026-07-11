import { describe, it, expect } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { MessageBody } from "./message-body"

// Regression test for the bug MD_LITERAL_TAGS included "spoiler" fixed:
// Streamdown's `literalTagContent` flattens every descendant of a listed
// tag into one text node. `mention`/`channelref` are leaf nodes so that's
// harmless, but a spoiler must preserve nested markdown children — this
// drives the full Streamdown pipeline (not just the mdast layer covered by
// spoiler-syntax.test.ts) to prove the nested `<strong>` survives.
describe("MessageBody — spoiler nested formatting (full Streamdown pipeline)", () => {
  it("keeps a nested <strong> intact after expanding a spoiler that wraps bold text", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(MessageBody, { text: "||I think **this** is neat||" }),
      )
    })

    // The spoiler renders as a clickable button (see inline-marks.tsx's
    // `Spoiler`); expand it, then confirm the bold span Streamdown renders
    // for `**this**` (`<span data-streamdown="strong">`) survived as a real
    // child element — not flattened into the button's own text content.
    const button = renderer!.root.findByType("button")
    act(() => {
      button.props.onClick()
    })

    const bold = renderer!.root.findAll(
      (node) => node.props["data-streamdown"] === "strong",
    )
    expect(bold).toHaveLength(1)
    expect(bold[0].children.join("")).toBe("this")
  })

  it("still hides/expands a plain spoiler with no nested formatting (regression)", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(MessageBody, { text: "||secret||" }),
      )
    })

    const button = renderer!.root.findByType("button")
    expect(button.children.join("")).toBe("secret")
  })
})
