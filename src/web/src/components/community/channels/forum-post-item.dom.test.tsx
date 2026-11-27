import { describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import type { ForumThread } from "@/lib/community/models/message"
import type { CommunityProfile } from "@/lib/community/models/people"
import { tid } from "@/lib/community/testids"
import { ForumPostItem } from "./forum-post-item"

const authorProfile: CommunityProfile = {
  id: "user-1",
  name: "Peggy",
  avatar: "P",
  presence: "online",
}

const profiles = new Map<string, CommunityProfile>([[authorProfile.id, authorProfile]])

function makePost(overrides: Partial<ForumThread> = {}): ForumThread {
  return {
    id: "post-1",
    name: "Deploying typography & jumping quickly",
    authorId: "user-1",
    authorAvatar: "P",
    authorAvatarVersion: 0,
    openerMessageId: "msg-1",
    parent: { authorName: "Peggy", text: "root" },
    lastMessageAt: "2026-10-01T00:05:00.000Z",
    messageCount: 3,
    participants: [{ id: "user-1", name: "Peggy", avatar: "P", avatarVersion: 0 }],
    participantCount: 1,
    tags: ["typography", "buggy"],
    preview: "Preview body line",
    parentSeq: 42,
    ...overrides,
  }
}

describe("ForumPostItem layout", () => {
  it("gives truncated title, author, and tags descender-safe line height and vertical bleed", () => {
    const view = render(
      <ForumPostItem
        post={makePost()}
        profilesByUserId={profiles}
        onOpen={vi.fn()}
      />,
    )

    const heading = view.getByTestId(tid.forumThreadTitle("post-1"))
    expect(heading).toHaveClass("leading-snug")
    expect(heading).not.toHaveClass("leading-tight")

    const titleText = view.getByTestId(tid.forumThreadTitleText("post-1"))
    expect(titleText).toHaveClass("min-w-0", "truncate", "py-0.5", "-my-0.5")

    const author = view.container.querySelector<HTMLElement>('[data-slot="community-forum-post-author"]')!
    expect(author).toHaveClass("truncate", "py-0.5", "-my-0.5")

    const tag = view.getByText("#typography")
    expect(tag).toHaveClass("truncate", "py-0.5", "-my-0.5")
  })

  it("keeps uniform title-to-meta spacing for empty and non-empty previews and reserves action width", () => {
    const withPreview = render(
      <ForumPostItem
        post={makePost({ preview: "Has preview copy" })}
        profilesByUserId={profiles}
        onOpen={vi.fn()}
        actions={<div data-testid="post-actions">actions</div>}
      />,
    )
    const withPreviewHeader = withPreview.getByTestId(tid.forumThreadTitle("post-1")).parentElement!
    expect(withPreviewHeader).toHaveClass("mb-2", "grid-cols-[minmax(0,1fr)_auto]", "grid-rows-[minmax(2rem,max-content)_auto]")
    const previewEl = withPreview.container.querySelector('[data-slot="community-forum-post-preview"]')
    expect(previewEl).toHaveTextContent("Has preview copy")
    expect(previewEl).not.toHaveClass("mb-2")
    withPreview.unmount()

    const withoutPreview = render(
      <ForumPostItem
        post={makePost({ preview: "   " })}
        profilesByUserId={profiles}
        onOpen={vi.fn()}
        actions={<div data-testid="post-actions">actions</div>}
      />,
    )
    const withoutPreviewHeader = withoutPreview.getByTestId(tid.forumThreadTitle("post-1")).parentElement!
    expect(withoutPreviewHeader).toHaveClass("mb-2", "grid-cols-[minmax(0,1fr)_auto]", "grid-rows-[minmax(2rem,max-content)]")
    expect(withoutPreview.container.querySelector('[data-slot="community-forum-post-preview"]')).toBeNull()
    withoutPreview.unmount()

    const noActions = render(
      <ForumPostItem
        post={makePost({ preview: "" })}
        profilesByUserId={profiles}
        onOpen={vi.fn()}
      />,
    )
    const noActionsHeader = noActions.getByTestId(tid.forumThreadTitle("post-1")).parentElement!
    expect(noActionsHeader).toHaveClass("mb-2", "grid-cols-1", "grid-rows-[minmax(2rem,max-content)]")
  })
})
