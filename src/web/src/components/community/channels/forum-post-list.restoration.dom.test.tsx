import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { ForumPostList } from "./forum-post-list"
import type { ForumThread } from "@/lib/community/models/message"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { captureChannelMetadataToken, type ConversationListScope } from "@/lib/community/conversation-qualification"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize, runFrames, scrollFixture } from "@/test/message-scroll-fixture"

beforeEach(installMessageScrollFixture)
afterEach(restoreMessageScrollFixture)
const posts = Array.from({ length: 180 }, (_, index) => ({ id: `p${index}`, openerMessageId: `m${index}` } as ForumThread))
const renderPost = (post: ForumThread) => <div data-msg-id={post.openerMessageId} />

describe("Forum native list identity and ordinary reconstruction", () => {
  it("keeps an unscoped native list readable", () => {
    const view = render(<ForumPostList posts={posts} renderPost={renderPost} loadingContent={<span>Loading</span>} />)
    resize()
    const root = view.getByTestId("community-forum-post-list")
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "true")
    expect(root.scrollTop).toBe(0)
  })

  it.each(["same", "other-tag", "width", "hidden"] as const)("starts a new Forum instance at its normal first item: %s", async mode => {
    const { client } = await createCommunityQueryOwner()
    const positionScope: ConversationListScope = { proof: captureChannelMetadataToken(client, "forum"), tag: null }
    const props = { posts, renderPost, loadingContent: <span>Loading</span>, positionScope }
    const first = render(<ForumPostList {...props} />)
    resize()
    const root = first.getByTestId("community-forum-post-list")
    act(() => root.scrollTo({ top: 800 }))
    runFrames()
    resize()
    expect(root.scrollTop).toBe(800)
    first.unmount()
    const scope = mode === "other-tag" ? { ...positionScope, tag: "bug" } : positionScope
    if (mode === "width") scrollFixture.width = 600
    if (mode === "hidden") { scrollFixture.width = 0; scrollFixture.height = 0 }
    const second = render(<ForumPostList {...props} positionScope={scope} />)
    resize()
    if (mode === "hidden") {
      expect(second.getByTestId("community-forum-post-list").querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
      scrollFixture.width = 320
      scrollFixture.height = 500
      resize()
    }
    const entered = second.getByTestId("community-forum-post-list")
    expect(entered.scrollTop).toBe(0)
    expect(entered.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "true")
    expect(entered.querySelectorAll('[data-index]').length).toBeLessThan(60)
  })

  it("admits a cached list after loading and retains its current instance across ordinary proof refreshes", async () => {
    const { client } = await createCommunityQueryOwner()
    const positionScope: ConversationListScope = { proof: captureChannelMetadataToken(client, "forum"), tag: null }
    const props = { renderPost, loadingContent: <span>Loading</span>, positionScope }
    const view = render(<ForumPostList {...props} posts={[]} loading />)
    expect(view.getByText("Loading")).toBeDefined()
    view.rerender(<ForumPostList {...props} posts={posts} />)
    resize()
    const root = view.getByTestId("community-forum-post-list")
    fireEvent.wheel(root, { deltaY: 20 })
    act(() => root.scrollTo({ top: 700 }))
    runFrames()
    resize()
    view.rerender(<ForumPostList {...props} positionScope={{ ...positionScope, proof: captureChannelMetadataToken(client, "forum") }} posts={posts} isFetching />)
    resize()
    expect(view.getByTestId("community-forum-post-list")).toBe(root)
    expect(root.scrollTop).toBe(700)
    view.rerender(<ForumPostList {...props} positionScope={{ ...positionScope, tag: "bug" }} posts={posts} />)
    resize()
    expect(root.isConnected).toBe(false)
    expect(view.getByTestId("community-forum-post-list").scrollTop).toBe(0)
  })
})
