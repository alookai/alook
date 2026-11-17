import React from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"

vi.mock("./community-sheet", () => ({
  CommunitySheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/lib/community-db/projections", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/community-db/projections")>(),
  useCanonicalProfilesByUserId: () => new Map([
    ["user_1", { id: "user_1", name: "Canonical long author name", avatar: "A" }],
  ]),
}))

import { CommunityPanel } from "./community-panel"

describe("CommunityPanel pinned author line", () => {
  it("uses the canonical author and keeps the exact message jump on one outer button", () => {
    const onJumpToMessage = vi.fn()
    const createdAt = "2026-10-16T05:00:00.000Z"
    const view = render(<CommunityPanel
      open
      onOpenChange={vi.fn()}
      kind="pinned"
      members={[]}
      pinned={[{
        id: "message_1", type: "chat", seq: 42,
        authorId: "user_1", authorName: "Stale author",
        content: "Pinned body", createdAt,
      }]}
      threads={[]}
      onOpenThread={vi.fn()}
      onJumpToMessage={onJumpToMessage}
    />)
    const author = view.getByTitle("Canonical long author name")
    const row = author.closest("button")!
    expect(view.queryByText("Stale author")).toBeNull()
    expect(row.querySelectorAll("button")).toHaveLength(0)
    expect(row.querySelector("time")).toHaveAttribute("datetime", createdAt)
    expect(row).toHaveTextContent("Pinned body")
    fireEvent.click(author)
    expect(onJumpToMessage).toHaveBeenCalledExactlyOnceWith(42)
  })
})

describe("auxiliary panel read states", () => {
  it.each(["pinned", "threads"] as const)("keeps unknown %s separate from a successful empty snapshot during failure", kind => {
    const retry = vi.fn()
    const props = { open: true, onOpenChange: vi.fn(), kind, members: [], pinned: [], threads: [], onOpenThread: vi.fn(),
      pinnedError: true, threadsError: true, onRetryPinned: retry, onRetryThreads: retry }
    const view = render(<CommunityPanel {...props} pinnedKnown={false} threadsKnown={false} />)
    expect(view.getByRole("alert")).toHaveTextContent(`Could not load ${kind === "pinned" ? "pinned messages" : "threads"}`)
    expect(view.queryByText("No pinned messages yet.")).toBeNull()
    expect(view.queryByText("0 threads")).toBeNull()
    fireEvent.click(view.getByRole("button", { name: kind === "pinned" ? "Retry pinned messages" : "Retry threads" }))
    expect(retry).toHaveBeenCalledOnce()
    view.rerender(<CommunityPanel {...props} pinnedKnown threadsKnown />)
    expect(view.getByRole("alert")).toHaveTextContent("Could not refresh")
    expect(view.getByText(kind === "pinned" ? "No pinned messages yet." : "0 threads")).toBeVisible()
  })

  it("retains the pinned row and exact Jump while its background read can be retried", () => {
    const retry = vi.fn(), jump = vi.fn()
    const view = render(<CommunityPanel open onOpenChange={vi.fn()} kind="pinned" members={[]}
      pinned={[{ id: "cached-pin", type: "chat", seq: 19, authorId: "user_1", content: "Saved pin" }]} threads={[]}
      pinnedKnown pinnedError onRetryPinned={retry} onOpenThread={vi.fn()} onJumpToMessage={jump} />)
    expect(view.getByText("Saved pin")).toBeVisible()
    fireEvent.click(view.getByRole("button", { name: "Retry pinned messages" }))
    expect(retry).toHaveBeenCalledOnce()
    fireEvent.click(view.getByText("Saved pin"))
    expect(jump).toHaveBeenCalledExactlyOnceWith(19)
  })

  it("retains the thread row and its destination while retrying a failed refresh", () => {
    const retry = vi.fn(), open = vi.fn()
    const view = render(<CommunityPanel open onOpenChange={vi.fn()} kind="threads" members={[]} pinned={[]}
      threads={[{ id: "cached-thread", name: "Saved thread", messageCount: 2, lastMessageAt: "2026-11-01T00:00:00Z", parent: { text: "Saved opener", authorName: "Author" } }]}
      threadsKnown threadsError onRetryThreads={retry} onOpenThread={open} />)
    expect(view.getByText("Saved thread")).toBeVisible()
    fireEvent.click(view.getByRole("button", { name: "Retry threads" }))
    expect(retry).toHaveBeenCalledOnce()
    fireEvent.click(view.getByText("Saved thread"))
    expect(open).toHaveBeenCalledExactlyOnceWith("cached-thread")
  })
})
