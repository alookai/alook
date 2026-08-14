/**
 * Server-render probes for CreateForumThread. Composer is mocked because it
 * mounts a real tiptap editor (needs DOM); everything else here is pure JSX
 * that renderToStaticMarkup can walk.
 */
import { beforeEach, describe, it, expect, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import TestRenderer, { act } from "react-test-renderer"

const uploadMock = vi.hoisted(() => vi.fn())

vi.mock("./composer", () => ({
  Composer: (props: Record<string, unknown>) =>
    createElement("div", {
      "data-testid": "mock-composer",
      "data-mode": (props.mode as string) ?? "chat",
      "data-send-contract": props.sendContract as string,
      "data-has-deferred-submit": String(typeof props.onDeferredSubmit === "function"),
      "data-hide-emoji": String(!!props.hideEmoji),
      "data-placeholder": (props.placeholder as string) ?? "",
      onSubmit: props.onDeferredSubmit,
      onDirty: props.onDirty,
    }),
}))

vi.mock("@/hooks/community/mutations/uploads", () => ({
  useUploadFile: () => ({ mutateAsync: uploadMock }),
  zipUploadResultsWithDimensions: (results: unknown[]) => results,
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
  beforeEach(() => uploadMock.mockReset())
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

  it("keeps server hasThumbnail in the forum upload cache across create retry", async () => {
    const onCreatePost = vi.fn()
      .mockRejectedValueOnce(new Error("create failed"))
      .mockResolvedValueOnce(undefined)
    uploadMock.mockResolvedValue({
      id: "att_thumb",
      filename: "photo.png",
      contentType: "image/png",
      size: 8,
      hasThumbnail: true,
    })
    const file = new File(["original"], "photo.png", { type: "image/png" })
    const thumbnailBlob = new Blob(["thumbnail"], { type: "image/jpeg" })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(CreateForumThread, {
        forumChannelId: "cha_forum",
        members: [],
        onCancel: () => {},
        onCreatePost,
      }))
    })
    const input = renderer!.root.findByType("input")
    const composer = () => renderer!.root.findByProps({ "data-testid": "mock-composer" })
    act(() => {
      input.props.onChange({ target: { value: "Post" } })
      composer().props.onDirty(true)
    })
    const attachments = [{ file, thumbnailBlob, width: 640, height: 480 }]

    await act(async () => {
      await composer().props.onSubmit("photo", attachments, undefined)
    })
    await act(async () => {
      await composer().props.onSubmit("photo", attachments, undefined)
    })

    expect(uploadMock).toHaveBeenCalledTimes(1)
    expect(uploadMock).toHaveBeenCalledWith(expect.objectContaining({ thumbnailBlob }))
    expect(onCreatePost).toHaveBeenCalledTimes(2)
    for (const [post] of onCreatePost.mock.calls) {
      expect(post.attachments).toEqual([expect.objectContaining({ hasThumbnail: true })])
    }
  })
})
