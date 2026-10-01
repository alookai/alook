import { createElement, useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen, setupUser } from "@/test/react-dom-harness"
import { SortableCategory } from "./sortable-category"

function SidebarGroup({ onSettings }: { onSettings?: () => void }) {
  const [open, setOpen] = useState(true)
  return <SortableCategory id="cat" name="PRIVATE" isPrivate canReorder={false} open={open} onToggle={() => setOpen((value) => !value)} onSettings={onSettings}><span>sidebar channel</span></SortableCategory>
}

describe("shared category in the sidebar", () => {
  it("keeps the header, icon and collapse when rendered through its context menu", async () => {
    const onSettings = vi.fn()
    const user = setupUser()
    render(createElement(SidebarGroup, { onSettings }))
    const header = screen.getByRole("button", { name: "Group: PRIVATE" })
    expect(screen.getByLabelText("Private group")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Category settings for PRIVATE" }))
    expect(onSettings).toHaveBeenCalledOnce()
    expect(header).toHaveAttribute("aria-expanded", "true")
    await user.click(header)
    expect(screen.queryByText("sidebar channel")).not.toBeInTheDocument()
    await user.click(header)
    expect(screen.getByText("sidebar channel")).toBeVisible()
  })

  it("allows keyboard collapse without a management menu", async () => {
    const user = setupUser()
    render(createElement(SidebarGroup))
    await user.tab()
    await user.keyboard(" ")
    expect(screen.getByRole("button", { name: "Group: PRIVATE" })).toHaveAttribute("aria-expanded", "false")
  })
})
