import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ForumView } from "./forum-view"
import { tid } from "@/lib/community/testids"
import type { ForumPost } from "./_types"

const LAST_AT = "2020-01-01T00:00:00.000Z"

function makePost(over: Partial<ForumPost> = {}): ForumPost {
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

function render(posts: ForumPost[]): string {
  return renderToStaticMarkup(
    createElement(ForumView, { posts, onOpenPost: () => {} })
  )
}

describe("ForumView post card header", () => {
  it("solo post renders the creator name and no participant AvatarGroup", () => {
    const html = render([makePost()])
    expect(html).toContain(">Alice<")
    expect(html).not.toContain(tid.forumPostAvatars("p1"))
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
    const groupTid = tid.forumPostAvatars("p1")
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
    expect(withOthers).toContain(tid.forumPostAvatars("p1"))
  })
})
