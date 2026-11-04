import React from "react"
import { describe, expect, it, vi } from "vitest"
import { act, setupUser } from "@/test/react-dom-harness"
import { renderCommunity } from "@/test/community-owner-harness"
import { BotMarkStickerView } from "./bot-mark-sticker"

describe("Bot log keyboard navigation", () => {
  it("links panels, selects with Enter, and preserves the footer", async () => {
    const user = setupUser()
    const renderer = renderCommunity(<BotMarkStickerView
      active={false} showStop stopPending={false} onStop={vi.fn()}
      activity={{ events: [], isLoading: false, isError: false, isNotFound: false }}
      marks={[]} isLoading={false} isError={false}
    />)
    const thoughts = renderer.getByRole("tab", { name: "Thoughts" })
    const marks = renderer.getByRole("tab", { name: "Marked messages" })
    const footer = renderer.container.querySelector("footer")
    act(() => thoughts.focus())
    await user.keyboard("{ArrowRight}{Enter}")
    expect(marks).toHaveFocus()
    expect(marks).toHaveAttribute("aria-selected", "true")
    const panel = renderer.getByRole("tabpanel", { name: "Marked messages" })
    expect(panel.id).toBe(marks.getAttribute("aria-controls"))
    expect(panel).toHaveTextContent("No marked messages")
    expect(renderer.container.querySelector("footer")).toBe(footer)
    await user.keyboard("{ArrowLeft}{Enter}")
    expect(thoughts).toHaveFocus()
    expect(renderer.getByRole("tabpanel", { name: "Thoughts" })).toBeVisible()
  })
})
