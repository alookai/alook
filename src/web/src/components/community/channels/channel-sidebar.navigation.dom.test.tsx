import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, setupUser, waitFor } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"
import { ChannelSidebar } from "./channel-sidebar"
import { useChannelTree } from "./use-channel-tree"

vi.mock("next/link", async () => ({ default: (await import("@/test/community-link-mock")).CommunityLinkMock }))

function Sidebar({ onPick, isAdmin = true, grouped = false, onReorder, unread = false, muted = false, actions = false }: {
  unread?: boolean
  muted?: boolean
  onPick: (id: string) => void
  isAdmin?: boolean
  grouped?: boolean
  onReorder?: (ids: string[]) => void
  actions?: boolean
}) {
  const tree = useChannelTree([{ id: grouped ? "group" : "none", name: grouped ? "Group" : "", channels: [
    { id: "one", name: "One", active: false, unread: false, type: "text" },
    { id: "two", name: unread ? "design-feedback-with-a-long-channel-name" : "Two", active: false, unread, muted, type: "forum" },
  ] }])
  return <ChannelSidebar tree={tree} serverId="server" serverName="Server" activeChannel="one"
    setActiveChannel={onPick} onReorderChannels={onReorder} noHeader isAdmin={isAdmin}
    onCreateChannel={actions ? async () => "created" : undefined} />
}

describe("real sortable channel navigation surface", () => {
  it("does not collapse an empty category before its first channel arrives", async () => {
    function EmptyCategory({ filled }: { filled: boolean }) {
      const tree = useChannelTree([{ id: "empty", name: "Empty", channels: filled ? [{ id: "first", name: "First", active: false, unread: false }] : [] }])
      return <ChannelSidebar tree={tree} serverName="Server" activeChannel="" setActiveChannel={() => {}} noHeader />
    }
    const view = render(<EmptyCategory filled={false} />)
    const header = view.getByTestId(tid.categoryHeader("empty"))
    expect(header).not.toHaveAttribute("aria-expanded")
    expect(header.querySelector(".lucide-chevron-down")).toBeNull()
    await setupUser().click(header)
    view.rerender(<EmptyCategory filled />)
    expect(header).toHaveAttribute("aria-expanded", "true")
    expect(header.querySelector(".lucide-chevron-down")).not.toBeNull()
    expect(view.getByTestId(tid.channelRow("first"))).toBeVisible()
  })
  it("keeps nested category action keys separate from disclosure keys", async () => {
    const view = render(<Sidebar onPick={vi.fn()} grouped actions />)
    const header = view.getByTestId(tid.categoryHeader("group"))
    const user = setupUser()
    act(() => header.focus())
    await user.keyboard("{Enter}")
    expect(header).toHaveAttribute("aria-expanded", "false")
    act(() => view.getByRole("button", { name: "Create channel in Group" }).focus())
    await user.keyboard(" ")
    expect(await view.findByRole("dialog")).toBeVisible()
    expect(header).toHaveAttribute("aria-expanded", "false")
  })
  it("keeps a left half-dot outside the long channel name layout", () => {
    const view = render(<Sidebar onPick={vi.fn()} unread />)
    const row = view.getByTestId(tid.channelRow("two"))
    expect(row.querySelector(".truncate")).toHaveTextContent("design-feedback-with-a-long-channel-name")
    expect(row.querySelector('[data-slot="community-channel-unread-indicator"]')).toHaveClass("absolute", "-left-2", "rounded-r-full", "h-2.5")
  })

  it("does not show an unread dot for a muted channel", () => {
    const view = render(<Sidebar onPick={vi.fn()} unread muted />)
    expect(view.getByTestId(tid.channelRow("two")).querySelector('[data-slot="community-channel-unread-indicator"]')).toHaveClass("h-0")
  })

  it("keeps href and drag attributes on the anchor and Enter activates once", async () => {
    const onPick = vi.fn()
    const view = render(<Sidebar onPick={onPick} />)
    const anchor = view.getByTestId(tid.channelRow("two"))
    expect(anchor.tagName).toBe("A")
    expect(anchor).toHaveAttribute("role", "link")
    expect(anchor).toHaveAttribute("href", "/c/channels/server/two")
    expect(anchor).toHaveAttribute("aria-roledescription", "draggable")
    fireEvent.focus(anchor)
    expect(anchor).toHaveAttribute("data-prefetch", "true")
    act(() => anchor.focus())
    await setupUser().keyboard("{Enter}")
    expect(onPick.mock.calls).toEqual([["two"]])
  })

  it("Space and Tab keep ordinary link navigation without keyboard sorting", async () => {
    const onPick = vi.fn()
    const view = render(<Sidebar onPick={onPick} />)
    const anchor = view.getByTestId(tid.channelRow("two"))
    act(() => anchor.focus())
    const user = setupUser()
    await user.keyboard(" ")
    expect(anchor).not.toHaveAttribute("aria-pressed")
    expect(onPick).not.toHaveBeenCalled()
    await user.keyboard("{Tab}")
    expect(view.queryByText(/was dropped/i)).not.toBeInTheDocument()
    expect(onPick).not.toHaveBeenCalled()
  })

  it.each([false, true])("lets ordinary members navigate without reorder, grouped=%s", async (grouped) => {
    const onPick = vi.fn()
    const onReorder = vi.fn()
    const view = render(<Sidebar onPick={onPick} onReorder={onReorder} isAdmin={false} grouped={grouped} />)
    const anchor = view.getByTestId(tid.channelRow("two"))
    expect(anchor.tagName).toBe("A")
    expect(anchor).toHaveAttribute("role", "link")
    expect(anchor).toHaveAttribute("href", "/c/channels/server/two")
    expect(anchor).not.toHaveAttribute("aria-disabled", "true")
    expect(anchor).not.toHaveAttribute("aria-roledescription")
    expect(anchor).not.toHaveAttribute("aria-describedby")
    const user = setupUser()
    await user.click(anchor)
    expect(onPick.mock.calls).toEqual([["two"]])
    act(() => anchor.focus())
    await user.keyboard(" ")
    expect(anchor).not.toHaveAttribute("aria-pressed", "true")
    expect(view.queryByText(/was picked up/i)).not.toBeInTheDocument()
    expect(onPick.mock.calls).toEqual([["two"]])
    await user.keyboard("{Enter}")
    expect(onPick.mock.calls).toEqual([["two"], ["two"]])
    expect(onReorder).not.toHaveBeenCalled()
    for (const element of [view.getByTestId(tid.channelSidebarScroll), anchor, ...(grouped ? [view.getByText("Group")] : [])]) {
      fireEvent.contextMenu(element, { button: 2 })
      expect(view.queryByRole("menu")).toBeNull()
    }
  })
})

it.each(["list", "row", "category"] as const)("retires an open %s menu when actions become unavailable without reviving it or replacing content", async kind => {
  const onPick = vi.fn()
  const view = render(<Sidebar onPick={onPick} grouped />)
  const scroll = view.getByTestId(tid.channelSidebarScroll)
  const row = view.getByTestId(tid.channelRow("two"))
  const category = view.getByText("Group")
  const trigger = kind === "list" ? scroll : kind === "row" ? row : category.closest('[data-slot="context-menu-trigger"]')!
  fireEvent.contextMenu(trigger, { button: 2 })
  expect(await view.findByRole("menu")).toBeVisible()
  view.rerender(<Sidebar onPick={onPick} isAdmin={false} grouped />)
  expect(view.queryByRole("menu")).toBeNull()
  view.rerender(<Sidebar onPick={onPick} grouped />)
  const closing = view.queryByRole("menu")
  if (closing) expect(closing).toHaveAttribute("data-closed")
  await waitFor(() => expect(view.queryByRole("menu")).toBeNull())
  expect(view.getByTestId(tid.channelSidebarScroll)).toBe(scroll)
  expect(view.getByTestId(tid.channelRow("two"))).toBe(row)
  expect(view.getByText("Group")).toBe(category)
  expect(onPick).not.toHaveBeenCalled()
})
