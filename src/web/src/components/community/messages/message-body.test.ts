import { describe, it, expect, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MessageBody } from "./message-body"
import { communityKeys } from "@/lib/query-keys"
import { tid } from "@/lib/community/testids"
import type { LinkPreview } from "@/lib/community/link-preview"

const PREVIEW_URL = "https://example.com/story"

function renderLinkPreviewMessage(preview?: LinkPreview | null) {
  class MockIntersectionObserver {
    observe = vi.fn()
    disconnect = vi.fn()
  }
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  if (preview !== undefined) {
    client.setQueryData(communityKeys.linkPreview(PREVIEW_URL), { preview })
  }
  let renderer: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(MessageBody, { text: PREVIEW_URL }),
      ),
    )
  })
  return {
    renderer: renderer!,
    cleanup() {
      act(() => renderer!.unmount())
      client.clear()
      vi.unstubAllGlobals()
    },
  }
}

function previewSpacing(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    (node) => node.type === "div" && node.props.className === "pb-2",
  )
}

describe("MessageBody — link preview spacing", () => {
  it("keeps a pending preview sentinel out of message layout", () => {
    const rendered = renderLinkPreviewMessage()
    try {
      expect(previewSpacing(rendered.renderer)).toHaveLength(0)
      const sentinel = rendered.renderer.root.findByType("span")
      expect(sentinel.props.className).toContain("absolute")
    } finally {
      rendered.cleanup()
    }
  })

  it("does not reserve preview spacing when the result has no safe thumbnail", () => {
    const rendered = renderLinkPreviewMessage({
      url: PREVIEW_URL,
      hostname: "example.com",
      title: "No image",
    })
    try {
      expect(previewSpacing(rendered.renderer)).toHaveLength(0)
      expect(rendered.renderer.root.findAllByProps({
        "data-testid": tid.linkPreviewCard,
      })).toHaveLength(0)
    } finally {
      rendered.cleanup()
    }
  })

  it("gives bottom spacing only to a successfully rendered preview card", () => {
    const rendered = renderLinkPreviewMessage({
      url: PREVIEW_URL,
      hostname: "example.com",
      title: "With image",
      thumbnailUrl: "/api/community/link-preview/thumbnail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })
    try {
      expect(previewSpacing(rendered.renderer)).toHaveLength(0)
      expect(rendered.renderer.root.findAllByProps({
        "data-testid": tid.linkPreviewCard,
      })).toHaveLength(0)
      const preload = rendered.renderer.root.findByProps({
        "data-testid": tid.linkPreviewThumbnail,
      })
      act(() => preload.props.onLoad())
      expect(previewSpacing(rendered.renderer)).toHaveLength(1)
      expect(rendered.renderer.root.findAllByProps({
        "data-testid": tid.linkPreviewCard,
      })).toHaveLength(1)
    } finally {
      rendered.cleanup()
    }
  })

  it("removes preview spacing together with a thumbnail that fails to load", () => {
    const rendered = renderLinkPreviewMessage({
      url: PREVIEW_URL,
      hostname: "example.com",
      title: "Broken image",
      thumbnailUrl: "/api/community/link-preview/thumbnail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })
    try {
      const preload = rendered.renderer.root.findByProps({
        "data-testid": tid.linkPreviewThumbnail,
      })
      act(() => preload.props.onLoad())
      expect(previewSpacing(rendered.renderer)).toHaveLength(1)
      const image = rendered.renderer.root.findByProps({
        "data-testid": tid.linkPreviewThumbnail,
      })
      act(() => image.props.onError())
      expect(previewSpacing(rendered.renderer)).toHaveLength(0)
      expect(rendered.renderer.root.findAllByProps({
        "data-testid": tid.linkPreviewCard,
      })).toHaveLength(0)
    } finally {
      rendered.cleanup()
    }
  })
})

describe("MessageBody — theme contrast", () => {
  it("pins body copy to the semantic foreground token", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(MessageBody, { text: "Readable in both themes" }),
      )
    })

    const body = renderer!.root.find(
      (node) => node.type === "div" && typeof node.props.className === "string"
        && node.props.className.includes("markdown-chat"),
    )
    expect(body.props.className).toContain("text-foreground")
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

// The composer serializes multi-line content with single `\n` separators
// (getText's blockSeparator). Standard markdown collapses a single `\n` to a
// space; `remark-breaks` (added to the remark pipeline) turns it into a hard
// line break so typed/pasted newlines survive. These drive the full pipeline.
describe("MessageBody — single newlines render as hard breaks (remark-breaks)", () => {
  it("renders a <br> for a single \\n between two lines", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(MessageBody, { text: "line one\nline two" }),
      )
    })
    const brs = renderer!.root.findAllByType("br")
    expect(brs.length).toBeGreaterThanOrEqual(1)
  })

  it("still renders a blank line (\\n\\n) as separate paragraphs", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(MessageBody, { text: "para one\n\npara two" }),
      )
    })
    const paras = renderer!.root.findAllByType("p")
    expect(paras.length).toBe(2)
  })
})
