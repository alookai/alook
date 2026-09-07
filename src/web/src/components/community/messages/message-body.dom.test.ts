import { describe, it, expect, vi } from "vitest"
import React from "react"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { MessageBody } from "./message-body"

const componentDirectory = dirname(fileURLToPath(import.meta.url))

describe("MessageBody — plain URL rendering", () => {
  it("renders an unsupported HTTPS URL as a generic clickable link badge", () => {
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(MessageBody, { text: "Visit https://example.com/story" }),
      )
    })

    const link = renderer!.container.querySelector("a")!
    expect(link).toHaveAttribute("href", "https://example.com/story")
    expect(link).toHaveAttribute("data-platform-link", "generic")
    expect(link).toHaveAttribute("data-message-external-link", "true")
    expect(renderer!.container.querySelectorAll("svg")).toHaveLength(1)
  })

  it("badges supported platform URLs without changing their href", () => {
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(MessageBody, {
          text: "Review https://github.com/alookai/alook/pull/598 then https://example.com/story",
        }),
      )
    })

    const links = [...renderer!.container.querySelectorAll("a")]
    expect(links).toHaveLength(2)
    expect(links[0]).toHaveAttribute("href", "https://github.com/alookai/alook/pull/598")
    expect(links[0]).toHaveAttribute("data-platform-link", "github")
    expect(links[0]).toHaveAttribute("data-message-external-link", "true")
    expect(links[1]).toHaveAttribute("href", "https://example.com/story")
    expect(links[1]).toHaveAttribute("data-platform-link", "generic")
    expect(links[1]).toHaveAttribute("data-message-external-link", "true")
  })
})

describe("MessageBody — theme contrast", () => {
  it("pins body copy to the semantic foreground token", () => {
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(MessageBody, { text: "Readable in both themes" }),
      )
    })

    const body = renderer!.container.querySelector<HTMLElement>("div.markdown-chat")!
    expect(body.className).toContain("text-foreground")
  })
})

describe("MessageBody — remote image geometry", () => {
  it("keeps Streamdown's native image wrapper and download control", async () => {
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(MessageBody, { text: "![portrait](https://example.com/photo.png)" }),
      )
    })

    expect(renderer!.container.querySelectorAll('[data-streamdown="image-wrapper"]')).toHaveLength(1)
    const image = renderer!.container.querySelector<HTMLImageElement>('[data-streamdown="image"]')!
    Object.defineProperties(image, {
      decode: { configurable: true, value: () => Promise.resolve() },
      naturalWidth: { configurable: true, value: 800 },
      naturalHeight: { configurable: true, value: 450 },
    })
    await act(async () => fireEvent.load(image))
    expect(renderer!.getByTitle("Download image").tagName).toBe("BUTTON")
  })

  it("caps community Markdown images at 300px without distorting their ratio", () => {
    const css = readFileSync(resolve(componentDirectory, "../../../app/globals.css"), "utf8")
    expect(css).toContain('[data-community-message-body] [data-streamdown="image-wrapper"]')
    expect(css).toMatch(/\[data-community-message-body\] \[data-streamdown="image-wrapper"\][^{]*\{[^}]*max-width: 100%;/s)
    expect(css).toMatch(/\[data-community-message-body\] \[data-streamdown="image"\][^{]*\{[^}]*width: 100%;[^}]*height: 100%;[^}]*max-width: 100%;[^}]*max-height: 100%;[^}]*object-fit: contain;/s)
  })
})

// Regression test for the bug MD_LITERAL_TAGS included "spoiler" fixed:
// Streamdown's `literalTagContent` flattens every descendant of a listed
// tag into one text node. `mention`/`channelref` are leaf nodes so that's
// harmless, but a spoiler must preserve nested markdown children — this
// drives the full Streamdown pipeline (not just the mdast layer covered by
// spoiler-syntax.test.ts) to prove the nested `<strong>` survives.
describe("MessageBody — spoiler nested formatting (full Streamdown pipeline)", () => {
  it("keeps a nested <strong> intact after expanding a spoiler that wraps bold text", () => {
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(MessageBody, { text: "||I think **this** is neat||" }),
      )
    })

    // The spoiler renders as a clickable button (see inline-marks.tsx's
    // `Spoiler`); expand it, then confirm the bold span Streamdown renders
    // for `**this**` (`<span data-streamdown="strong">`) survived as a real
    // child element — not flattened into the button's own text content.
    const button = renderer!.getByRole("button")
    fireEvent.click(button)

    const bold = renderer!.container.querySelectorAll('[data-streamdown="strong"]')
    expect(bold).toHaveLength(1)
    expect(bold[0]).toHaveTextContent("this")
  })

  it("still hides/expands a plain spoiler with no nested formatting (regression)", () => {
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(MessageBody, { text: "||secret||" }),
      )
    })

    expect(renderer!.getByRole("button")).toHaveTextContent("secret")
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
  it("renders an HTML-looking member name as one literal pill and opens the tagged profile", () => {
    const onOpenProfile = vi.fn()
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(MessageBody, { text: "hi @<b>Alice</b>#0042", onOpenProfile }),
      )
    })

    const pill = renderer!.getByRole("button")
    expect(pill).toHaveTextContent("@<b>Alice</b>")
    expect(renderer!.container.querySelectorAll("b")).toHaveLength(0)
    fireEvent.click(pill)
    expect(onOpenProfile).toHaveBeenCalledWith("<b>Alice</b>", expect.anything(), "0042")
  })

  it("renders an event-handler-shaped member name as text without creating an image element", () => {
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(MessageBody, { text: "@<img src=x onerror=alert(1)>#0042" }),
      )
    })

    const pill = renderer!.getByText("@<img src=x onerror=alert(1)>", { selector: "span" })
    expect(pill).toBeInTheDocument()
    expect(renderer!.container.querySelectorAll("img")).toHaveLength(0)
    expect(renderer!.container.querySelectorAll("script")).toHaveLength(0)
  })

  it("forwards the discriminator from a @Name#dddd handle to onOpenProfile on click", () => {
    const calls: Array<[string, unknown, string | undefined]> = []
    const onOpenProfile = (name: string, _e: React.MouseEvent, discriminator?: string) => {
      calls.push([name, _e, discriminator])
    }
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(MessageBody, { text: "hi @Gus#0042", onOpenProfile }),
      )
    })
    const pill = renderer!.getByRole("button")
    expect(pill).toHaveTextContent("@Gus")
    fireEvent.click(pill)
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe("Gus")
    expect(calls[0][2]).toBe("0042")
  })

  it("keeps the @everyone flag so it renders with the distinct primary styling, and is not clickable", () => {
    const onOpenProfile = vi.fn()
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(MessageBody, { text: "cc @everyone hi", onOpenProfile }),
      )
    })
    // @everyone has no user behind it → rendered as a non-clickable <span>
    // (not a <button>), with the distinct primary tint.
    const pill = renderer!.getByText("@everyone", { selector: "span" })
    expect(pill.className).toContain("text-primary")
    expect(pill).not.toHaveAttribute("role", "button")
  })
})

// The composer serializes multi-line content with single `\n` separators
// (getText's blockSeparator). Standard markdown collapses a single `\n` to a
// space; `remark-breaks` (added to the remark pipeline) turns it into a hard
// line break so typed/pasted newlines survive. These drive the full pipeline.
describe("MessageBody — single newlines render as hard breaks (remark-breaks)", () => {
  it("renders a <br> for a single \\n between two lines", () => {
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(MessageBody, { text: "line one\nline two" }),
      )
    })
    const brs = renderer!.container.querySelectorAll("br")
    expect(brs.length).toBeGreaterThanOrEqual(1)
  })

  it("still renders a blank line (\\n\\n) as separate paragraphs", () => {
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(MessageBody, { text: "para one\n\npara two" }),
      )
    })
    const paras = renderer!.container.querySelectorAll("p")
    expect(paras.length).toBe(2)
  })
})
