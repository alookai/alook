import React from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render } from "@/test/react-dom-harness"
import { MessageAuthorLine } from "./message-author-line"

describe("MessageAuthorLine", () => {
  it.each(["Alice", "A long author name with spaces", "这是一个很长的中文姓名", "LongUnbrokenAuthorName".repeat(8)])(
    "keeps the full accessible author name and forwards the click for %s",
    (authorName) => {
      const onAuthorClick = vi.fn()
      const renderer = render(<MessageAuthorLine
        authorName={authorName}
        timestamp="12:34"
        onAuthorClick={onAuthorClick}
        color="var(--foreground)"
      />)
      const author = renderer.getByRole("button", { name: authorName })
      expect(author).toHaveAttribute("title", authorName)
      expect(author).toHaveTextContent(authorName)
      expect(author.style.color).toBe("var(--foreground)")
      fireEvent.click(author)
      expect(onAuthorClick).toHaveBeenCalledOnce()
      expect(onAuthorClick.mock.calls[0][0].target).toBe(author)
    },
  )

  it.each(["compact", "note"] as const)("keeps a %s preview inside its original jump button", (variant) => {
    const jump = vi.fn()
    const renderer = render(<button type="button" onClick={jump}>
      <MessageAuthorLine authorName="Alice" timestamp="2m" variant={variant} />
    </button>)
    expect(renderer.container.querySelectorAll("button")).toHaveLength(1)
    fireEvent.click(renderer.getByTitle("Alice"))
    expect(jump).toHaveBeenCalledOnce()
  })

  it("keeps static capture text and timestamp metadata on the actual time node", () => {
    const dateTime = "2026-10-16T05:00:00.000Z"
    const renderer = render(<MessageAuthorLine
      authorName="Share author"
      timestamp="13:00"
      timestampProps={{ dateTime, "data-share-timestamp": true }}
    />)
    expect(renderer.queryByRole("button")).toBeNull()
    const time = renderer.container.querySelector("time[data-share-timestamp]")!
    expect(time).toHaveAttribute("datetime", dateTime)
    expect(time).toHaveTextContent("13:00")
    expect(time.previousElementSibling).toHaveAttribute("title", "Share author")
  })

  it("omits an absent timestamp without adding an empty time element", () => {
    const renderer = render(<MessageAuthorLine authorName="Deleted user" />)
    expect(renderer.container.querySelector("time")).toBeNull()
    expect(renderer.getByTitle("Deleted user")).toHaveTextContent("Deleted user")
  })
})
