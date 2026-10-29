import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, mockElementGeometry, render, waitFor } from "@/test/react-dom-harness"
import { SwipeRoot, SwipePortal, SwipeViewport, SwipePopup, SwipeTitle } from "@/components/ui/swipe-container"
import { canStartSwipe } from "@/components/ui/swipe-gesture-policy"
import type { ForumThread } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import { ForumView } from "./forum-view"

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true, useBreakpoint: () => "mobile" }))
vi.mock("@/lib/community-db/projections", () => ({ useCanonicalProfilesByUserId: () => new Map() }))

const hitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint")
const originalRect = HTMLElement.prototype.getBoundingClientRect
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-index") ? new DOMRect(0, Number.parseFloat(this.style.top) || 0, 390, 128) : originalRect.call(this)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  if (hitTest) Object.defineProperty(document, "elementFromPoint", hitTest)
  else Reflect.deleteProperty(document, "elementFromPoint")
})

const post: ForumThread = {
  id: "post", name: "Post", messageCount: 1, lastMessageAt: "2026-10-22T10:00:00Z",
  parent: { authorName: "Author", text: "Root" }, authorId: "author", authorAvatar: "A", authorAvatarVersion: 0,
  openerMessageId: "opener", tags: [], preview: "Card body", participants: [], participantCount: 1,
}

function fixture({ empty = false, kind = "page" as "page" | "overlay" } = {}) {
  const opened = vi.fn(), changed = vi.fn(), archive = vi.fn()
  const view = render(<SwipeRoot kind={kind} open onOpenChange={changed}>
    <SwipePortal><SwipeViewport data-testid="page-viewport"><SwipePopup data-testid="page-popup">
      <SwipeTitle>Forum</SwipeTitle>
      <ForumView forumChannelId="forum" members={[]} posts={empty ? [] : [post]}
        tag="All" tagsKnown availableTags={[]} onTagChange={() => {}} onOpenPost={opened}
        onEditPostTags={archive} canEditPostTags={() => true}
        onScrollRoot={node => { if (node) mockElementGeometry(node, { clientHeight: 600, clientWidth: 390, width: 390, height: 600 }) }} />
    </SwipePopup></SwipeViewport></SwipePortal>
  </SwipeRoot>)
  const root = view.getByTestId("page-viewport"), popup = view.getByTestId("page-popup")
  const restore = mockElementGeometry(popup, { width: 390, height: 600, offsetWidth: 390, offsetHeight: 600, clientWidth: 390, clientHeight: 600 })
  const target = view.getByText(empty ? "No posts with this tag yet. Start one with New Post." : "Card body")
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target })
  return { ...view, root, popup, target, opened, changed, archive, restore }
}

function touch(target: Element, type: "touchstart" | "touchmove" | "touchend" | "touchcancel", x: number, timeStamp: number, y = 100) {
  const point = { clientX: x, clientY: y, identifier: 0, target }
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    touches: { value: type === "touchend" || type === "touchcancel" ? [] : [point] },
    changedTouches: { value: [point] }, timeStamp: { value: timeStamp },
  })
  fireEvent(target, event)
}

describe("Forum navigation row inside the real shared Drawer", () => {
  it.each([false, true])("admits populated and empty content through the same page policy (empty=%s)", async empty => {
    const f = fixture({ empty })
    try {
      expect(canStartSwipe({ target: f.target, root: f.root, x: 40, y: 100, kind: "page", enabled: true, pointerType: "touch" })).toBe(true)
      touch(f.target, "touchstart", 40, 100)
      touch(f.target, "touchmove", 130, 200)
      touch(f.target, "touchmove", 360, 300)
      touch(f.target, "touchend", 360, 400)
      await waitFor(() => expect(f.changed).toHaveBeenCalledOnce())
      expect(f.changed.mock.calls[0][0]).toBe(false)
      expect(f.opened).not.toHaveBeenCalled()
    } finally { f.restore() }
  })

  it.each(["touchend", "touchcancel"] as const)("restores a short or cancelled gesture without opening a post (%s)", async end => {
    const f = fixture()
    try {
      touch(f.target, "touchstart", 40, 100)
      touch(f.target, "touchmove", 80, 300)
      touch(f.target, "touchmove", 95, 1000)
      expect(f.popup).toHaveAttribute("data-swiping")
      touch(f.target, end, 95, 1500)
      await waitFor(() => expect(f.popup).not.toHaveAttribute("data-swiping"))
      expect(f.changed).not.toHaveBeenCalled()
      expect(f.opened).not.toHaveBeenCalled()
    } finally { f.restore() }
  })

  it("preserves post activation and embedded action ownership", () => {
    const f = fixture()
    try {
      const card = f.getByTestId(tid.forumThreadCard(post.id))
      expect(card).toHaveAttribute("role", "button")
      expect(card).toHaveAttribute("tabindex", "0")
      fireEvent.click(f.target)
      fireEvent.keyDown(card, { key: "Enter" })
      fireEvent.keyDown(card, { key: " " })
      expect(f.opened.mock.calls).toEqual([[post.id], [post.id], [post.id]])
      f.opened.mockClear()
      const control = f.getByRole("button", { name: /^Archive post$/ })
      expect(canStartSwipe({ target: control, root: f.root, x: 40, y: 100, kind: "page", enabled: true, pointerType: "touch" })).toBe(false)
      fireEvent.click(control)
      fireEvent.keyDown(control, { key: "Enter" })
      expect(f.archive).toHaveBeenCalledExactlyOnceWith(post.id, ["archived"])
      expect(f.opened).not.toHaveBeenCalled()
    } finally { f.restore() }
  })

  it("keeps the real card outside overlay admission", () => {
    const f = fixture({ kind: "overlay" })
    try {
      expect(canStartSwipe({ target: f.target, root: f.root, x: 40, y: 100, enabled: true, pointerType: "touch" })).toBe(false)
      touch(f.target, "touchstart", 40, 100)
      touch(f.target, "touchmove", 360, 300)
      touch(f.target, "touchend", 360, 400)
      expect(f.changed).not.toHaveBeenCalled()
    } finally { f.restore() }
  })

  it("leaves a vertical drag to the list direction instead of navigating", () => {
    const f = fixture()
    const restore = mockElementGeometry(f.getByTestId(tid.forumPostList), { clientHeight: 600, scrollHeight: 1200 })
    try {
      touch(f.target, "touchstart", 40, 100, 100)
      touch(f.target, "touchmove", 40, 300, 160)
      touch(f.target, "touchmove", 40, 500, 300)
      touch(f.target, "touchend", 40, 700, 300)
      expect(f.popup).not.toHaveAttribute("data-swiping")
      expect(f.changed).not.toHaveBeenCalled()
      expect(f.opened).not.toHaveBeenCalled()
    } finally { restore(); f.restore() }
  })
})
