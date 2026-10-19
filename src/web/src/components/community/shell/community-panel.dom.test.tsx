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
      searchResults={[]}
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
