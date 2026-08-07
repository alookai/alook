/**
 * Server-render probes for CreateForumThread. Composer is mocked because it
 * mounts a real tiptap editor (needs DOM); everything else here is pure JSX
 * that renderToStaticMarkup can walk.
 */
import { describe, it, expect, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("./composer", () => ({
  Composer: (props: Record<string, unknown>) =>
    createElement("div", {
      "data-testid": "mock-composer",
      "data-mode": (props.mode as string) ?? "chat",
      "data-send-contract": props.sendContract as string,
      "data-has-deferred-submit": String(typeof props.onDeferredSubmit === "function"),
      "data-hide-emoji": String(!!props.hideEmoji),
      "data-placeholder": (props.placeholder as string) ?? "",
    }),
}))

vi.mock("@/hooks/community/mutations/uploads", () => ({
  useUploadFile: () => ({ mutateAsync: vi.fn() }),
  zipUploadResultsWithDimensions: () => [],
}))

import { CreateForumThread } from "./create-forum-thread"

function render(over: Partial<Parameters<typeof CreateForumThread>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(CreateForumThread, {
      forumChannelId: "cha_forum",
      members: [],
      onCancel: () => {},
      onCreatePost: async () => {},
      ...over,
    }),
  )
}

describe("CreateForumThread — copy + structure", () => {
  it("renders the region role + label so keyboard/SR users land in a named region", () => {
    const html = render()
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="Create post"')
  })

  it("renders the title placeholder \"New post\" (not the old \"Title\")", () => {
    const html = render()
    expect(html).toContain('placeholder="New post"')
    expect(html).not.toContain('placeholder="Title"')
  })

  it("renders the composer in forumThreadBody mode with hideEmoji + the body placeholder", () => {
    const html = render()
    expect(html).toContain('data-testid="mock-composer"')
    expect(html).toContain('data-mode="forumThreadBody"')
    expect(html).toContain('data-send-contract="deferred"')
    expect(html).toContain('data-has-deferred-submit="true"')
    expect(html).toContain('data-hide-emoji="true"')
    expect(html).toContain('data-placeholder="What do you want to discuss?"')
  })

  it("renders a Create post footer button that is initially disabled (title + body both empty)", () => {
    const html = render()
    expect(html).toContain("Create post")
    // renderToStaticMarkup emits a bare `disabled` attribute for disabled={true}.
    // Find the button and check `disabled` is present within the same tag.
    const idx = html.indexOf(">Create post<")
    expect(idx).toBeGreaterThan(-1)
    const tagOpen = html.lastIndexOf("<button", idx)
    expect(tagOpen).toBeGreaterThan(-1)
    const tag = html.slice(tagOpen, idx)
    expect(tag).toMatch(/\sdisabled(=|\s|>)/)
  })

  it("does NOT render an emoji picker button or a slug hint", () => {
    const html = render()
    expect(html).not.toContain('aria-label="Emoji picker"')
    // Old surface's SlugHint muted-line copy pattern.
    expect(html).not.toContain("Will be saved as")
  })

  it("renders the Shift+Enter keyboard hint", () => {
    const html = render()
    // The <Kbd> component renders the shift + enter glyphs.
    expect(html).toContain("⇧")
    expect(html).toContain("⏎")
  })

  it("caps the title input at MAX_CHANNEL_NAME_LENGTH", () => {
    const html = render()
    // MAX_CHANNEL_NAME_LENGTH = 100
    expect(html).toContain('maxLength="100"')
  })

  it("renders the X cancel button with the correct aria-label", () => {
    const html = render()
    expect(html).toContain('aria-label="Cancel post"')
  })
})
