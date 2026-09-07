import { createElement, type PropsWithChildren } from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen, setupUser } from "@/test/react-dom-harness"
import { UserBar } from "./user-bar"
import { tid } from "@/lib/community/testids"

vi.mock("./community-inbox-surface", () => ({
  CommunityInboxSurface: ({ children }: PropsWithChildren) =>
    createElement("div", { "data-testid": "inbox-surface" }, children),
}))
vi.mock("../avatar", () => ({
  Avatar: () => createElement("span", { "data-testid": "user-avatar" }),
}))

function renderBar() {
  const order: string[] = []
  const onInboxOpenChange = vi.fn(() => order.push("close"))
  const onOpenProfile = vi.fn(() => order.push("profile"))
  const onEditProfile = vi.fn(() => order.push("settings"))
  render(createElement(UserBar, {
    breakpoint: "mobile",
    user: { id: "u1", name: "User", avatar: "U" },
    onOpenProfile,
    onEditProfile,
    inbox: createElement("span", null, "Inbox content"),
    hasUnread: false,
    inboxOpen: true,
    onInboxOpenChange,
  }))
  return { order, onInboxOpenChange, onOpenProfile, onEditProfile }
}

describe("UserBar Inbox switching", () => {
  it.each(["avatar", "name"])("closes before the %s profile action exactly once", async (kind) => {
    const user = setupUser()
    const { order, onInboxOpenChange, onOpenProfile } = renderBar()
    const avatarButton = screen.getByTestId("user-avatar").closest("button")
    const button = kind === "avatar"
      ? avatarButton
      : screen.getByRole("button", { name: "User" })
    expect(button).not.toBeNull()

    await user.click(button!)

    expect(order).toEqual(["close", "profile"])
    expect(onInboxOpenChange).toHaveBeenCalledOnce()
    expect(onOpenProfile).toHaveBeenCalledOnce()
  })

  it("closes before Settings exactly once", async () => {
    const user = setupUser()
    const { order, onInboxOpenChange, onEditProfile } = renderBar()

    await user.click(screen.getByTestId(tid.userSettingsOpen))

    expect(order).toEqual(["close", "settings"])
    expect(onInboxOpenChange).toHaveBeenCalledOnce()
    expect(onEditProfile).toHaveBeenCalledOnce()
  })
})
