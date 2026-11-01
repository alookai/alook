import { describe, expect, it, vi } from "vitest"
import { fireEvent, mockElementGeometry, render } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"
import { CommunityDndProvider } from "../community-dnd"
import { SortableCategory } from "./sortable-category"

describe.each([false, true])("category presentation (private=%s)", isPrivate => {
  it.each([0, 1, 2])("preserves category identity with %i optional actions", actionCount => {
    const toggle = vi.fn()
    const settings = vi.fn()
    const create = vi.fn()
    const view = render(<CommunityDndProvider>
      <SortableCategory id="category" name="Projects" open onToggle={toggle} isPrivate={isPrivate}
        hasChannels canReorder={false} onSettings={actionCount > 0 ? settings : undefined}
        onAddChannel={actionCount > 1 ? create : undefined}>
        <span>Category content</span>
      </SortableCategory>
    </CommunityDndProvider>)
    const header = view.getByTestId(tid.categoryHeader("category"))
    mockElementGeometry(header, { width: 240, height: 24 })
    expect(header).toHaveAccessibleName("Projects")
    expect(header).toHaveAttribute("aria-description", isPrivate ? "Private category" : "Public category")
    expect(header).toHaveAttribute("aria-expanded", "true")
    expect(header.querySelector(isPrivate ? ".lucide-message-square-lock" : ".lucide-messages-square")).not.toBeNull()
    expect(header.querySelector(isPrivate ? ".lucide-messages-square" : ".lucide-message-square-lock")).toBeNull()
    const glyphs = [...header.querySelectorAll("svg")]
    expect(glyphs).toHaveLength(2 + actionCount)
    for (const glyph of glyphs) expect(glyph).toHaveClass("size-3")
    fireEvent.click(header)
    fireEvent.keyDown(header, { key: "Enter" })
    expect(toggle).toHaveBeenCalledTimes(2)
    toggle.mockClear()
    if (actionCount > 0) {
      const button = view.getByRole("button", { name: "Category settings for Projects" })
      fireEvent.click(button)
      fireEvent.keyDown(button, { key: "Enter" })
      expect(settings).toHaveBeenCalledOnce()
    }
    if (actionCount > 1) {
      fireEvent.click(view.getByRole("button", { name: "Create channel in Projects" }))
      expect(create).toHaveBeenCalledOnce()
    }
    expect(toggle).not.toHaveBeenCalled()
  })

  it("keeps an empty category's identity without a disclosure action", () => {
    const toggle = vi.fn()
    const view = render(<CommunityDndProvider>
      <SortableCategory id="empty" name="Empty" open onToggle={toggle} isPrivate={isPrivate}
        hasChannels={false} canReorder={false}>{null}</SortableCategory>
    </CommunityDndProvider>)
    const header = view.getByTestId(tid.categoryHeader("empty"))
    mockElementGeometry(header, { width: 240, height: 24 })
    expect(header).not.toHaveAttribute("aria-expanded")
    expect(header.querySelectorAll("svg")).toHaveLength(1)
    fireEvent.click(header)
    fireEvent.keyDown(header, { key: "Enter" })
    expect(toggle).not.toHaveBeenCalled()
  })
})
