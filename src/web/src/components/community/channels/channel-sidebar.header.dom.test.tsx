import { expect, it, vi } from "vitest"
import { fireEvent, render, setupUser } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { ChannelSidebar } from "./channel-sidebar"
import { useChannelTree } from "./use-channel-tree"

it("preserves disabled header nodes, retires an open menu and restores only qualified actions", async () => {
  const { client, registry } = await createCommunityQueryOwner()
  const settings = vi.fn()
  const invite = vi.fn()
  function Sidebar({ ready, manager = true }: { ready: boolean; manager?: boolean }) {
    const tree = useChannelTree([])
    return <ChannelSidebar tree={tree} serverName="Target server" serverId="target" activeChannel="" setActiveChannel={vi.fn()}
      isAdmin={ready && manager} onOpenSettings={ready && manager ? settings : undefined}
      onInvitePopoverOpenChange={ready ? invite : undefined} />
  }
  const node = (ready: boolean, manager = true) => <CommunityTestProvider client={client} registry={registry}>
    <CurrentUserProvider initialUser={{ id: "viewer", email: "viewer@example.test", name: "Viewer", avatar: "V" }}>
      <Sidebar ready={ready} manager={manager} />
    </CurrentUserProvider>
  </CommunityTestProvider>
  const view = render(node(false))
  const title = view.getByRole("button", { name: "Target server" })
  const inviteButton = view.getByRole("button", { name: "Invite to server" })
  const arrow = title.querySelector("svg")
  expect(arrow).not.toBeNull()
  const assertDisabled = () => {
    expect(view.getByRole("button", { name: "Target server" })).toBe(title)
    expect(view.getByRole("button", { name: "Invite to server" })).toBe(inviteButton)
    expect(title.querySelector("svg")).toBe(arrow)
    expect(title).toBeDisabled()
    expect(inviteButton).toBeDisabled()
    fireEvent.click(title)
    fireEvent.keyDown(title, { key: "Enter" })
    fireEvent.click(inviteButton)
    expect(view.queryByRole("menu")).toBeNull()
    expect(settings).not.toHaveBeenCalled()
    expect(invite).not.toHaveBeenCalled()
  }
  assertDisabled()
  view.rerender(node(true))
  expect(view.getByRole("button", { name: "Target server" })).toBe(title)
  expect(view.getByRole("button", { name: "Invite to server" })).toBe(inviteButton)
  expect(title).toBeEnabled()
  expect(inviteButton).toBeEnabled()
  const user = setupUser()
  await user.click(title)
  expect(await view.findByRole("menuitem", { name: "Overview" })).toBeVisible()
  view.rerender(node(false))
  assertDisabled()
  view.rerender(node(true))
  expect(view.queryByRole("menu")).toBeNull()
  await user.click(title)
  await user.click(await view.findByRole("menuitem", { name: "Overview" }))
  expect(settings).toHaveBeenCalledExactlyOnceWith("overview")
  await user.click(inviteButton)
  expect(invite).toHaveBeenCalledExactlyOnceWith(true)
  view.rerender(node(true, false))
  expect(view.getByRole("button", { name: "Target server" })).toBe(title)
  expect(title).toBeDisabled()
  expect(inviteButton).toBeEnabled()
  expect(view.queryByRole("menu")).toBeNull()
})
