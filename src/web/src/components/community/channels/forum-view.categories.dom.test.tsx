import { expect, it, vi } from "vitest"
import { fireEvent, mockElementGeometry, render } from "@/test/react-dom-harness"
import type { ForumThread } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import { ForumView } from "./forum-view"

vi.mock("@/lib/community-db/projections", () => ({ useCanonicalProfilesByUserId: () => new Map() }))

const post: ForumThread = {
  id: "post", name: "Post", messageCount: 1, lastMessageAt: "2026-10-22T10:00:00Z",
  parent: { authorName: "Author", text: "Root" }, authorId: "author", authorAvatar: "A", authorAvatarVersion: 0,
  openerMessageId: "opener", tags: ["partial"], preview: "Preview", participants: [], participantCount: 1,
}
const props = {
  forumChannelId: "forum", members: [], posts: [post], tag: "All", onTagChange: () => {}, onOpenPost: () => {},
  onScrollRoot: (node: HTMLDivElement | null) => { if (node) mockElementGeometry(node, { clientHeight: 600, clientWidth: 390 }) },
}

it("keeps posts while unknown tags settle to the complete sorted vocabulary", () => {
  const view = render(<ForumView {...props} tagsKnown={false} availableTags={[]} />)
  const card = view.getByTestId(tid.forumThreadCard("post"))
  expect(view.getByRole("status", { name: "Loading tag filters" })).toBeVisible()
  expect(view.getByRole("status", { name: "Loading tag filters" })).toHaveClass("h-7")
  expect(view.queryByTestId(tid.forumTagChip("partial"))).toBeNull()
  expect(view.queryByTestId(tid.forumTagAll)).toBeNull()
  view.rerender(<ForumView {...props} tagsKnown availableTags={["apple", "archived", "zebra"]} />)
  const rail = view.getByTestId(tid.forumTagScroller)
  expect([...rail.querySelectorAll("button")].map(button => button.textContent)).toEqual(["All", "#apple", "#zebra", "Archived"])
  expect(view.getByTestId(tid.forumThreadCard("post"))).toBe(card)
})

it("renders a confirmed empty catalog without deriving categories from current posts", () => {
  const view = render(<ForumView {...props} tagsKnown availableTags={[]} />)
  expect(view.getByTestId(tid.forumTagAll)).toBeVisible()
  expect(view.queryByTestId(tid.forumTagChip("partial"))).toBeNull()
  expect(view.queryByRole("status", { name: "Loading tag filters" })).toBeNull()
  expect(view.getByTestId(tid.forumThreadCard("post"))).toBeVisible()
})

it("retries only unavailable tags and retains a complete cached catalog through errors", () => {
  const retry = vi.fn()
  const view = render(<ForumView {...props} tagsKnown={false} tagsError onRetryTags={retry} />)
  expect(view.getByRole("button", { name: "Retry tags" })).toHaveClass("h-7", "leading-5")
  fireEvent.click(view.getByRole("button", { name: "Retry tags" }))
  expect(retry).toHaveBeenCalledOnce()
  expect(view.getByTestId(tid.forumThreadCard("post"))).toBeVisible()
  view.rerender(<ForumView {...props} tagsKnown tagsError availableTags={["cached"]} onRetryTags={retry} />)
  expect(view.getByTestId(tid.forumTagChip("cached"))).toBeVisible()
  expect(view.queryByRole("button", { name: "Retry tags" })).toBeNull()
})
