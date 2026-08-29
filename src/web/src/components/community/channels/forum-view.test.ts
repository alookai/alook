import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  ForumView,
  ForumViewSkeleton,
  forumTagScrollFades,
  shouldActivateForumRow,
} from "./forum-view"
import { tid } from "@/lib/community/testids"
import type { ForumThread } from "@/lib/community/models/message"

const profileState = vi.hoisted(() => ({ map: new Map<string, Record<string, unknown>>() }))
vi.mock("@/stores/community/ws", () => ({
  useProfilesByUserId: () => profileState.map,
}))

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
    openerMessageId: "msg_1",
    tags: [],
    preview: "preview text",
    participants: [{ id: "usr_alice", name: "Alice", avatar: "A" }],
    participantCount: 1,
    ...over,
  }
}

function render(posts: ForumThread[]): string {
  profileState.map = new Map(posts.flatMap((post) => [
    ...(post.authorId && post.parent.authorName
      ? [[post.authorId, {
          id: post.authorId,
          name: post.parent.authorName,
          avatar: post.authorAvatar ?? post.parent.authorName,
          avatarVersion: 0,
        }] as const]
      : []),
    ...(post.participants ?? []).map((participant) => [participant.id, {
      id: participant.id,
      name: participant.name,
      avatar: participant.avatar,
      avatarVersion: participant.avatarVersion ?? 0,
    }] as const),
  ]))
  return renderToStaticMarkup(
    createElement(ForumView, {
      forumChannelId: "cha_forum",
      members: [],
      posts,
      tag: "All",
      onTagChange: () => {},
      onOpenPost: () => {},
    })
  )
}

function renderWithAvailableTags(posts: ForumThread[], availableTags: string[], tag = "All"): string {
  return renderToStaticMarkup(
    createElement(ForumView, {
      forumChannelId: "cha_forum",
      members: [],
      posts,
      tag,
      availableTags,
      onTagChange: () => {},
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
      tag: "All",
      onTagChange: () => {},
      onOpenPost: () => {},
      onDeletePost: () => {},
      canDeletePost: opts.canDeletePost ?? (() => true),
      deletingPost: opts.deletingPost ?? null,
    })
  )
}

function renderWithActions(
  post: ForumThread,
  opts: { canEdit?: boolean; canDelete?: boolean } = {},
): string {
  return renderToStaticMarkup(
    createElement(ForumView, {
      forumChannelId: "cha_forum",
      members: [],
      posts: [post],
      tag: "All",
      onTagChange: () => {},
      onOpenPost: () => {},
      onEditPostTags: () => {},
      canEditPostTags: () => opts.canEdit ?? true,
      onDeletePost: () => {},
      canDeletePost: () => opts.canDelete ?? true,
    }),
  )
}

describe("ForumView post card header", () => {
  it("only lets the row itself handle Enter or Space, not nested controls", () => {
    const row = {}
    const child = {}
    expect(shouldActivateForumRow({ key: "Enter", target: row, currentTarget: row })).toBe(true)
    expect(shouldActivateForumRow({ key: " ", target: row, currentTarget: row })).toBe(true)
    expect(shouldActivateForumRow({ key: "Enter", target: child, currentTarget: row })).toBe(false)
    expect(shouldActivateForumRow({ key: "Escape", target: row, currentTarget: row })).toBe(false)
  })

  it("renders the title and opener seq before the creator metadata", () => {
    const html = render([makePost({ parentSeq: 42 })])
    expect(html.indexOf("A post title")).toBeLessThan(html.indexOf(">Alice<"))
    expect(html).toContain('<span class="opacity-60">#</span>42')
  })

  it("uses a flat hairline row instead of the old bordered card", () => {
    const html = render([makePost()])
    const testIdIndex = html.indexOf(tid.forumThreadCard("p1"))
    const rowMarkup = html.slice(Math.max(0, testIdIndex - 250), testIdIndex + 350)
    expect(rowMarkup).toContain("border-border/50")
    expect(rowMarkup).not.toContain("bg-card")
    expect(rowMarkup).not.toContain("rounded-lg border")
  })

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
    expect(html.indexOf('aria-hidden="true">·</span>')).toBeLessThan(html.indexOf(groupTid))
  })

  it("uses canonical participant identity when the opener snapshot name is empty", () => {
    const html = render([makePost({ parent: { authorName: "", text: "root" } })])
    expect(html).toContain(">Alice<")
  })

  it("renders the time separator for both a solo post and a post with others", () => {
    const solo = render([makePost()])
    expect(solo).toContain('aria-hidden="true">·</span>')

    const withOthers = render([
      makePost({
        participants: [
          { id: "usr_alice", name: "Alice", avatar: "A" },
          { id: "usr_bob", name: "Bob", avatar: "B" },
        ],
      }),
    ])
    expect(withOthers).toContain('aria-hidden="true">·</span>')
    expect(withOthers).toContain(tid.forumThreadAvatars("p1"))
  })

  it("does not invent overflow when the author is absent from a capped five-person preview", () => {
    const participants = Array.from({ length: 5 }, (_, index) => ({
      id: `usr_${index}`,
      name: `Person ${index}`,
      avatar: `P${index}`,
    }))
    const html = render([makePost({ participants, participantCount: 6 })])
    expect(html).toContain(tid.forumThreadAvatars("p1"))
    expect(html).not.toContain(">+1<")
  })

  it("shows at most two resting tags and collapses the rest into a touch-safe +N button", () => {
    const html = render([makePost({ tags: ["alpha", "beta", "gamma", "delta"] })])
    expect(html).toContain("#alpha")
    expect(html).toContain("#beta")
    expect(html).toContain("Show 2 more tags")
    expect(html).toContain(">+2<")
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

describe("ForumView responsive post actions", () => {
  it("keeps authorized actions visible and touch-safe on mobile, then progressive on desktop", () => {
    const html = renderWithActions(makePost({ parentSeq: 3 }))
    const tagIndex = html.indexOf(tid.forumThreadTagBtn("p1"))
    const deleteIndex = html.indexOf(tid.forumThreadDeleteBtn("p1"))
    const tagButton = html.slice(Math.max(0, tagIndex - 500), tagIndex + 500)
    const deleteButton = html.slice(Math.max(0, deleteIndex - 500), deleteIndex + 500)

    for (const button of [tagButton, deleteButton]) {
      expect(button).toContain("size-8")
      expect(button).toContain("opacity-100")
      expect(button).toContain("sm:size-6")
      expect(button).toContain("sm:opacity-0")
      expect(button).toContain("sm:focus-visible:opacity-100")
      expect(button).toContain("sm:group-hover/card:opacity-100")
    }
    expect(tagButton).toContain("sm:data-popup-open:opacity-100")
    expect(deleteButton).toContain("disabled:opacity-50")
    expect(html).toContain("min-h-8 pr-16 sm:min-h-0")
    expect(html).toContain("relative line-clamp-2 w-full min-w-0 max-w-full wrap-break-word")
    expect(html).toContain(tid.forumThreadTitle("p1"))
    expect(html).toContain(tid.forumThreadTitleText("p1"))
    expect(html).toContain(tid.forumThreadSeq("p1"))
  })

  it("does not render actions or reserve mobile header space without permission", () => {
    const html = renderWithActions(makePost(), { canEdit: false, canDelete: false })

    expect(html).not.toContain(tid.forumThreadTagBtn("p1"))
    expect(html).not.toContain(tid.forumThreadDeleteBtn("p1"))
    expect(html).not.toContain("min-h-8 pr-16 sm:min-h-0")
    expect(html).toContain("sm:pr-14 pr-0")
  })
})

describe("ForumView filter bar / composer swap", () => {
  it("derives conditional edge fades from rail scroll geometry", () => {
    expect(forumTagScrollFades({ scrollLeft: 0, clientWidth: 200, scrollWidth: 200 }))
      .toEqual({ left: false, right: false })
    expect(forumTagScrollFades({ scrollLeft: 0, clientWidth: 200, scrollWidth: 420 }))
      .toEqual({ left: false, right: true })
    expect(forumTagScrollFades({ scrollLeft: 110, clientWidth: 200, scrollWidth: 420 }))
      .toEqual({ left: true, right: true })
    expect(forumTagScrollFades({ scrollLeft: 220, clientWidth: 200, scrollWidth: 420 }))
      .toEqual({ left: true, right: false })
  })

  it("shows the New Post trigger by default (not the composer)", () => {
    const html = render([makePost()])
    // The trigger button renders on first paint, in the filter bar slot.
    expect(html).toContain("New Post")
    // The composer's aria-label region only exists in composing mode.
    expect(html).not.toContain('aria-label="Create post"')
  })

  it("renders the server-query tag controls from the unfiltered result", () => {
    const html = render([makePost({ tags: ["bug", "help"] })])
    expect(html).toContain("#bug")
    expect(html).toContain("#help")
  })

  it("keeps filter tags in one horizontal scroller at every checkpoint beside the fixed action", () => {
    const html = render([makePost({ tags: ["alpha", "beta", "gamma", "delta"] })])
    const railIndex = html.indexOf(tid.forumTagScroller)
    const listIndex = html.indexOf(tid.forumPostList)
    const railMarkup = html.slice(Math.max(0, railIndex - 400), railIndex + 900)
    const listMarkup = html.slice(Math.max(0, listIndex - 300), listIndex + 300)

    expect(html).toContain(tid.forumFilterBar)
    expect(html).toContain(tid.forumTagAll)
    expect(html).toContain(tid.forumNewPost)
    expect(railMarkup).toContain("min-w-0")
    expect(railMarkup).toContain("flex-nowrap")
    expect(railMarkup).toContain("overflow-x-auto")
    expect(railMarkup).toContain("thin-scrollbar")
    expect(railMarkup).toContain("scrollbar-none")
    expect(railMarkup).not.toContain("sm:flex-wrap")
    expect(railMarkup).not.toContain("sm:overflow-x-visible")
    expect(railMarkup).toContain('tabindex="0"')
    expect(html).not.toContain(tid.forumTagFadeLeft)
    expect(html).not.toContain(tid.forumTagFadeRight)
    expect(listMarkup).toContain("px-0")
    expect(listMarkup).toContain("sm:px-4")
  })

  it("keeps the tag rail scrollable without a cross-browser scrollbar gutter", () => {
    const html = render([makePost({ tags: ["alpha", "beta", "gamma", "delta"] })])
    const railIndex = html.indexOf(tid.forumTagScroller)
    const railMarkup = html.slice(Math.max(0, railIndex - 400), railIndex + 900)
    const css = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8")

    expect(railMarkup).toContain("overflow-x-auto")
    expect(railMarkup).toContain("thin-scrollbar scrollbar-none")
    expect(css).toContain(".scrollbar-none")
    expect(css).toContain("-ms-overflow-style: none")
    expect(css).toContain(".thin-scrollbar.scrollbar-none")
    expect(css).toContain("scrollbar-width: none")
    expect(css).toContain(".scrollbar-none::-webkit-scrollbar")
    expect(css).toContain("display: none")
  })

  it("keeps Archived last in the shared scroller and hides it without archived posts", () => {
    const withoutArchived = renderWithAvailableTags([makePost()], ["bug", "help"])
    expect(withoutArchived).not.toContain(tid.forumTagChip("archived"))

    const html = renderWithAvailableTags([makePost()], ["archived", "bug", "help"], "archived")
    const scrollerIndex = html.indexOf(tid.forumTagScroller)
    const allIndex = html.indexOf(tid.forumTagAll)
    const bugIndex = html.indexOf(tid.forumTagChip("bug"))
    const helpIndex = html.indexOf(tid.forumTagChip("help"))
    const archivedIndex = html.indexOf(tid.forumTagChip("archived"))
    const scrollerCloseIndex = html.indexOf("</div>", scrollerIndex)
    const newPostIndex = html.indexOf(tid.forumNewPost)

    expect(scrollerIndex).toBeGreaterThanOrEqual(0)
    expect(allIndex).toBeGreaterThan(scrollerIndex)
    expect(bugIndex).toBeGreaterThan(allIndex)
    expect(helpIndex).toBeGreaterThan(bugIndex)
    expect(archivedIndex).toBeGreaterThan(helpIndex)
    expect(archivedIndex).toBeLessThan(scrollerCloseIndex)
    expect(archivedIndex).toBeLessThan(newPostIndex)
    const archivedMarkup = html.slice(Math.max(0, archivedIndex - 500), archivedIndex + 500)
    expect(archivedMarkup).toContain("Archived")
    expect(archivedMarkup).toContain("opacity-100 ring-1")
  })

  it("matches the real responsive filter rail and 28px chip footprints while loading", () => {
    const html = renderToStaticMarkup(createElement(ForumViewSkeleton))
    expect(html.match(/h-7/g)).toHaveLength(4)
    expect(html).not.toContain("h-5 w-10 rounded-full")
    expect(html).toContain("flex-nowrap")
    expect(html).toContain("overflow-x-auto")
    expect(html).toContain("thin-scrollbar scrollbar-none")
    expect(html).toContain("sm:flex-wrap")
    expect(html).toContain("sm:overflow-x-visible")
    expect(html).toContain("pointer-events-none")
    expect(html).toContain("px-0 py-2 sm:px-4")
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
