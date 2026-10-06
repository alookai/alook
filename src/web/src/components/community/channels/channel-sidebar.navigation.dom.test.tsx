import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, setupUser } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"
import { ChannelSidebar } from "./channel-sidebar"
import { useChannelTree } from "./use-channel-tree"

vi.mock("next/link", async () => ({ default: (await import("@/test/community-link-mock")).CommunityLinkMock }))

function Sidebar({ onPick }: { onPick: (id: string) => void }) {
  const tree = useChannelTree([{ id: "none", name: "", channels: [
    { id: "one", name: "One", active: false, unread: false, type: "text" },
    { id: "two", name: "Two", active: false, unread: false, type: "forum" },
  ] }])
  return <ChannelSidebar tree={tree} serverId="server" serverName="Server" activeChannel="one"
    setActiveChannel={onPick} noHeader isAdmin />
}

describe("real sortable channel navigation surface", () => {
  it("keeps href and sortable attributes on the anchor and Enter activates once", async () => {
    const onPick = vi.fn()
    const view = render(<Sidebar onPick={onPick} />)
    const anchor = view.getByTestId(tid.channelRow("two"))
    expect(anchor.tagName).toBe("A")
    expect(anchor).toHaveAttribute("role", "link")
    expect(anchor).toHaveAttribute("href", "/c/channels/server/two")
    expect(anchor).toHaveAttribute("aria-roledescription", "sortable")
    fireEvent.focus(anchor)
    expect(anchor).toHaveAttribute("data-prefetch", "true")
    act(() => anchor.focus())
    await setupUser().keyboard("{Enter}")
    expect(onPick.mock.calls).toEqual([["two"]])
  })

  it("Space starts reorder and Tab ends it without navigating", async () => {
    const onPick = vi.fn()
    const view = render(<Sidebar onPick={onPick} />)
    const anchor = view.getByTestId(tid.channelRow("two"))
    act(() => anchor.focus())
    const user = setupUser()
    await user.keyboard(" ")
    expect(anchor).toHaveAttribute("aria-pressed", "true")
    expect(onPick).not.toHaveBeenCalled()
    await user.keyboard("{Tab}")
    expect(view.getByText(/was dropped/i)).toBeInTheDocument()
    expect(onPick).not.toHaveBeenCalled()
  })
})
