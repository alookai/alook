import { createElement, useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen, setupUser } from "@/test/react-dom-harness"
import { UserBar } from "./user-bar"
import { tid } from "@/lib/community/testids"
import type { UserBarExtensionKind } from "./user-bar-extension-state"

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
  it.each(["mobile", "desktop"] as const)("renders the real %s extension through its intended motion surface", (breakpoint) => {
    const inbox = createElement("button", null, "Inbox item")
    const renderer = render(createElement(UserBar, {
      breakpoint,
      user: { id: "u1", name: "User", avatar: "U" },
      inbox,
      hasUnread: false,
      inboxOpen: true,
      extension: {
        active: "inbox",
        inbox,
        profile: null,
        update: null,
        updateBadgePhase: null,
        eligibleMachines: [],
        onOpenUpdate: vi.fn(),
        onRequestUpdate: vi.fn(),
        onDismiss: vi.fn(),
      },
    }))
    const dialog = renderer.getByRole("dialog", { name: "Inbox" })
    expect(renderer.getAllByRole("button", { name: "Inbox item" })).toHaveLength(1)
    if (breakpoint === "mobile") {
      expect(dialog.closest(".community-user-bar-drawer")).not.toBeNull()
      expect(dialog.className).not.toContain("fade-in")
    } else {
      expect(dialog.closest(".community-user-bar-drawer")).toBeNull()
      expect(dialog.closest(`[data-testid="${tid.userBar}"]`)).toBeNull()
      expect(dialog.closest('[data-slot="popover-content"]')).not.toBeNull()
      expect(dialog).toHaveAttribute("data-presentation", "popup")
      expect(renderer.getByTestId(tid.userBar).querySelector('[data-slot="community-user-bar-base"]')).toHaveClass("rounded-xl")
      expect(dialog.className).toContain("fade-in")
    }
  })

  it("switches desktop pop-ups, restores focus on Escape, and dismisses outside", async () => {
    function Harness() {
      const [active, setActive] = useState<UserBarExtensionKind>("none")
      const inbox = createElement("button", null, "Inbox item")
      return createElement("div", null,
        createElement("button", null, "Outside"),
        createElement(UserBar, {
          breakpoint: "desktop",
          user: { id: "u1", name: "User", avatar: "U" },
          inbox,
          hasUnread: false,
          inboxOpen: active === "inbox",
          onInboxOpenChange: (open) => setActive(open ? "inbox" : "none"),
          onOpenProfile: () => setActive(active === "profile" ? "none" : "profile"),
          extension: {
            active,
            inbox,
            profile: createElement("button", null, "Edit status"),
            update: null,
            updateBadgePhase: null,
            eligibleMachines: [],
            onOpenUpdate: vi.fn(),
            onRequestUpdate: vi.fn(),
            onDismiss: () => setActive("none"),
          },
        }),
      )
    }
    const user = setupUser()
    render(createElement(Harness))
    const trigger = screen.getByTestId(tid.inboxTrigger)
    await user.click(trigger)
    expect(screen.getByRole("dialog", { name: "Inbox" })).toHaveFocus()
    await user.click(screen.getByRole("button", { name: "User", exact: true }))
    expect(screen.queryByRole("dialog", { name: "Inbox" })).not.toBeInTheDocument()
    expect(screen.getByRole("dialog", { name: "Your profile" })).toHaveFocus()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "User", exact: true })).toHaveFocus())
    await user.click(trigger)
    await user.click(screen.getByRole("button", { name: "Outside" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await user.click(trigger)
    await user.click(trigger)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

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
