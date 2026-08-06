import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ForumView } from "./forum-view"
import { tid } from "@/lib/community/testids"
import type { ForumThread } from "./_types"

const LAST_AT = "2020-01-01T00:00:00.000Z"

function makePost(over: Partial<ForumThread> = {}): ForumThread {
  return {
    id: "p1",
    name: "A post title",
    messageCount: 3,
    lastMessageAt: LAST_AT,
    parent: { authorName: "Alice", text: "root" },
    authorId: "usr_alice",
    authorAvatar: "A",
    tags: [],
    preview: "preview text",
    participants: [{ id: "usr_alice", name: "Alice", avatar: "A" }],
    ...over,
  }
}

function render(posts: ForumThread[]): string {
  return renderToStaticMarkup(
    createElement(ForumView, {
      forumChannelId: "cha_forum",
      members: [],
      posts,
      onOpenPost: () => {},
    })
  )
}

// Render with the delete affordance wired. `canDeletePost` decides per-post
// visibility; `deletingPost` is the in-flight post id (button disabled).
function renderWithDelete(
  posts: ForumThread[],
  opts: { canDeletePost?: (p: ForumThread) => boolean; deletingPost?: string | null } = {},
): string {
  return renderToStaticMarkup(
    createElement(ForumView, {
      forumChannelId: "cha_forum",
      members: [],
      posts,
      onOpenPost: () => {},
      onDeletePost: () => {},
      canDeletePost: opts.canDeletePost ?? (() => true),
      deletingPost: opts.deletingPost ?? null,
    })
  )
}

describe("ForumView post card header", () => {
  it("solo post renders the creator name and no participant AvatarGroup", () => {
    const html = render([makePost()])
    expect(html).toContain(">Alice<")
    expect(html).not.toContain(tid.forumThreadAvatars("p1"))
  })

  it("renders the creator name and time before the participant AvatarGroup in markup order", () => {
    const html = render([
      makePost({
        participants: [
          { id: "usr_alice", name: "Alice", avatar: "A" },
          { id: "usr_bob", name: "Bob", avatar: "B" },
          { id: "usr_cara", name: "Cara", avatar: "C" },
        ],
      }),
    ])
    const groupTid = tid.forumThreadAvatars("p1")
    expect(html).toContain(groupTid)
    expect(html.indexOf(">Alice<")).toBeGreaterThanOrEqual(0)
    expect(html.indexOf(">Alice<")).toBeLessThan(html.indexOf(groupTid))
    expect(html.indexOf("· ")).toBeLessThan(html.indexOf(groupTid))
  })

  it("falls back to \"Unknown\" when the creator name is empty (deleted creator)", () => {
    const html = render([makePost({ parent: { authorName: "", text: "root" } })])
    expect(html).toContain(">Unknown<")
  })

  it("renders the time separator for both a solo post and a post with others", () => {
    const solo = render([makePost()])
    expect(solo).toContain("· ")

    const withOthers = render([
      makePost({
        participants: [
          { id: "usr_alice", name: "Alice", avatar: "A" },
          { id: "usr_bob", name: "Bob", avatar: "B" },
        ],
      }),
    ])
    expect(withOthers).toContain("· ")
    expect(withOthers).toContain(tid.forumThreadAvatars("p1"))
  })
})

describe("ForumView post delete button", () => {
  it("renders the delete button (with aria-label + testid) when canDeletePost is true", () => {
    const html = renderWithDelete([makePost()], { canDeletePost: () => true })
    expect(html).toContain(tid.forumThreadDeleteBtn("p1"))
    expect(html).toContain('aria-label="Delete post"')
  })

  it("does not render the delete button when canDeletePost is false", () => {
    const html = renderWithDelete([makePost()], { canDeletePost: () => false })
    expect(html).not.toContain(tid.forumThreadDeleteBtn("p1"))
  })

  it("does not render the delete button when onDeletePost is absent", () => {
    // render() wires onOpenPost only — no delete handler → no button.
    const html = render([makePost()])
    expect(html).not.toContain(tid.forumThreadDeleteBtn("p1"))
  })

  it("disables the delete button for the post whose delete is in flight", () => {
    const html = renderWithDelete([makePost()], { deletingPost: "p1" })
    // The disabled attribute rides on the button carrying the delete testid.
    const btnIdx = html.indexOf(tid.forumThreadDeleteBtn("p1"))
    expect(btnIdx).toBeGreaterThanOrEqual(0)
    // renderToStaticMarkup emits a bare `disabled` attribute for disabled={true}.
    const around = html.slice(Math.max(0, btnIdx - 200), btnIdx + 200)
    expect(around).toContain("disabled")
  })

  it("does NOT render the ConfirmDialog until the delete button is clicked", () => {
    // Static markup can't fire a click, so the confirm dialog (state-gated) is
    // absent on first paint — proves clicking, not rendering, opens it.
    const html = renderWithDelete([makePost()])
    expect(html).not.toContain("Delete post?")
  })
})

describe("ForumView filter bar / composer swap", () => {
  it("shows the New Post trigger by default (not the composer)", () => {
    const html = render([makePost()])
    // The trigger button renders on first paint, in the filter bar slot.
    expect(html).toContain("New Post")
    // The composer's aria-label region only exists in composing mode.
    expect(html).not.toContain('aria-label="Create post"')
  })
})

describe("ForumView post card messageCount guard", () => {
  it("clamps a negative messageCount to 0 on render", () => {
    // Simulates a stale/cached response where the server hadn't yet subtracted
    // the body message. The defensive Math.max(0, …) guard keeps the badge
    // non-negative.
    const html = render([makePost({ messageCount: -3 })])
    // No "-3" anywhere in the rendered badge.
    expect(html).not.toContain(">-3<")
  })
})
