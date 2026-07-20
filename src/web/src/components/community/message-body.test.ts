import { describe, it, expect, vi } from "vitest"
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

// Regression for the sanitize allowlist case-mismatch: `MD_ALLOWED_TAGS`
// declared the mention attrs in kebab-case (`data-tag`) while chatSyntaxHandlers
// emits camelCase hast property keys (`dataTag`), so `hast-util-sanitize`
// dropped them. That silently stripped the discriminator from the rendered
// pill (same-name mentions all resolved to the first match on click) and the
// everyone/here flag (lost their styling). These drive the FULL Streamdown +
// sanitize pipeline — the mdast-only unit tests in message-markdown.test.ts
// pass kebab props directly and can't catch this.
describe("MessageBody — mention pill survives sanitize (full pipeline)", () => {
  it("forwards the discriminator from a @Name#dddd handle to onOpenProfile on click", () => {
    const calls: Array<[string, unknown, string | undefined]> = []
    const onOpenProfile = (name: string, _e: React.MouseEvent, discriminator?: string) => {
      calls.push([name, _e, discriminator])
    }
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(MessageBody, { text: "hi @Gus#0042", onOpenProfile }),
      )
    })
    const pill = renderer!.root.findByType("button")
    expect(pill.children.join("")).toBe("@Gus")
    act(() => {
      pill.props.onClick({ preventDefault() {}, stopPropagation() {} })
    })
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe("Gus")
    expect(calls[0][2]).toBe("0042")
  })

  it("keeps the @everyone flag so it renders with the distinct primary styling, and is not clickable", () => {
    const onOpenProfile = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(MessageBody, { text: "cc @everyone hi", onOpenProfile }),
      )
    })
    // @everyone has no user behind it → rendered as a non-clickable <span>
    // (not a <button>), with the distinct primary tint.
    const pill = renderer!.root.find(
      (n) => n.type === "span" && n.children.join("") === "@everyone",
    )
    expect(pill.props.className).toContain("text-primary")
    expect(pill.props.onClick).toBeUndefined()
  })
})
