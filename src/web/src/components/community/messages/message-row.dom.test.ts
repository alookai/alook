import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, setupUser } from "@/test/react-dom-harness"
import { MessageRow } from "./message-row"

vi.mock("./message", () => ({
  Message: ({
    onReply,
    onMentionAuthor,
  }: {
    onReply?: () => void
    onMentionAuthor?: () => void
  }) => createElement("div", null,
    onReply && createElement("button", {
      type: "button",
      onClick: onReply,
    }, "Reply"),
    onMentionAuthor && createElement("button", {
      type: "button",
      onClick: onMentionAuthor,
    }, "Mention author"),
  ),
}))

describe("MessageRow", () => {
  beforeEach(() => vi.clearAllMocks())

  it("binds reply to the exact row id and passes canonical mention text unchanged", async () => {
    const user = setupUser()
    const onReplyId = vi.fn()
    const onInsertMentionText = vi.fn()
    render(createElement(MessageRow, {
      m: {
        id: "message_42",
        type: "chat",
        authorId: "user_7",
        authorName: "Alice",
        content: "hello",
        grouped: false,
      },
      hoverCapable: false,
      onOpenThread: vi.fn(),
      onReplyId,
      mentionText: "@Alice#1234 ",
      onInsertMentionText,
    }))

    await user.click(screen.getByRole("button", { name: "Reply" }))
    await user.click(screen.getByRole("button", { name: "Mention author" }))

    expect(onReplyId).toHaveBeenCalledOnce()
    expect(onReplyId).toHaveBeenCalledWith("message_42")
    expect(onInsertMentionText).toHaveBeenCalledOnce()
    expect(onInsertMentionText).toHaveBeenCalledWith("@Alice#1234 ")
  })

  it("does not expose mention behavior without both text and an insertion seam", () => {
    render(createElement(MessageRow, {
      m: { id: "m1", type: "chat", grouped: false },
      hoverCapable: false,
      onOpenThread: vi.fn(),
      mentionText: "@Alice#1234 ",
    }))

    expect(screen.queryByRole("button", { name: "Mention author" }))
      .not.toBeInTheDocument()
  })
})
