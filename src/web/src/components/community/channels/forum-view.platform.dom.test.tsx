import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { hydrateRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { act, fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import type { ForumThread } from "@/lib/community/models/message"
import { ForumView } from "./forum-view"

vi.mock("@/lib/community-db/projections", () => ({ useCanonicalProfilesByUserId: () => new Map() }))
vi.mock("./forum-post-list", () => ({
  FORUM_LIST_SPACING_CLASS: "px-0 py-2",
  ForumPostList: ({ posts, renderPost }: { posts: ForumThread[]; renderPost: (post: ForumThread, index: number) => React.ReactNode }) => posts.map(renderPost),
}))

const post: ForumThread = {
  id: "p1", name: "Forum title", authorId: "author", authorAvatar: null, authorAvatarVersion: 0, messageCount: 1,
  parent: { authorName: "Author", text: "Opener" }, tags: [], preview: "Preview",
  participants: [], participantCount: 1, openerMessageId: "opener", lastMessageAt: "2020-01-01T00:00:00.000Z",
}

function view() {
  return createElement(ForumView, {
    forumChannelId: "forum", members: [], posts: [post], tag: "All",
    onTagChange() {}, onOpenPost() {}, onEditPostTags() {}, canEditPostTags: () => true,
    onDeletePost() {}, canDeletePost: () => true,
  })
}

afterEach(() => vi.unstubAllGlobals())

describe("Forum platform action lifecycle", () => {
  it("hydrates visible server actions before applying the confirmed desktop policy", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", platform: "MacIntel", maxTouchPoints: 0 })
    const html = renderToString(view())
    expect(html).not.toContain("group-hover/card:opacity-100")
    const container = document.createElement("div")
    container.innerHTML = html
    document.body.appendChild(container)
    const onRecoverableError = vi.fn()
    let root: ReturnType<typeof hydrateRoot> | undefined
    try {
      await act(async () => { root = hydrateRoot(container, view(), { onRecoverableError }) })
      const trigger = container.querySelector('button[aria-label="Edit tags"]')!
      expect(trigger.parentElement!.className).toContain("group-hover/card:opacity-100")
      expect(onRecoverableError).not.toHaveBeenCalled()
    } finally {
      await act(async () => root?.unmount())
      container.remove()
    }
  })

  it("keeps the desktop group visible while its delete confirmation is open", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", maxTouchPoints: 10 })
    render(view())
    const trigger = screen.getByRole("button", { name: "Delete post" })
    const actions = trigger.parentElement!
    expect(actions.className).toContain("opacity-0")
    fireEvent.click(trigger)
    expect(await screen.findByRole("dialog", { name: "Delete post?" })).toBeInTheDocument()
    expect(actions.className.split(" ")).toContain("opacity-100")
    expect(actions.className.split(" ")).not.toContain("opacity-0")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(actions.className.split(" ")).toContain("opacity-0"))
  })
})
