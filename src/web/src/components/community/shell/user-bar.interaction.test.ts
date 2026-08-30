import { createElement, type PropsWithChildren } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import { UserBar } from "./user-bar"
import { tid } from "@/lib/community/testids"

vi.mock("./community-inbox-surface", () => ({
  CommunityInboxSurface: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) =>
    createElement("inbox-surface", props, children),
}))
vi.mock("../avatar", () => ({
  Avatar: () => createElement("avatar"),
}))

async function renderBar() {
  const order: string[] = []
  const onInboxOpenChange = vi.fn(() => order.push("close"))
  const onOpenProfile = vi.fn(() => order.push("profile"))
  const onEditProfile = vi.fn(() => order.push("settings"))
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(UserBar, {
      breakpoint: "mobile",
      user: { id: "u1", name: "User", avatar: "U" },
      onOpenProfile,
      onEditProfile,
      inbox: createElement("inbox-content"),
      inboxOpen: true,
      onInboxOpenChange,
    }))
  })
  return { renderer, order, onInboxOpenChange, onOpenProfile, onEditProfile }
}

describe("UserBar Inbox switching", () => {
  it.each(["avatar", "name"])("closes before the %s profile action exactly once", async (kind) => {
    const { renderer, order, onInboxOpenChange, onOpenProfile } = await renderBar()
    const buttons = renderer.root.findAllByType("button")
    const button = kind === "avatar" ? buttons[0]! : buttons[1]!

    await act(async () => button.props.onClick({ type: "click" }))

    expect(order).toEqual(["close", "profile"])
    expect(onInboxOpenChange).toHaveBeenCalledOnce()
    expect(onOpenProfile).toHaveBeenCalledOnce()
  })

  it("closes before Settings exactly once", async () => {
    const { renderer, order, onInboxOpenChange, onEditProfile } = await renderBar()
    const settings = renderer.root.findByProps({ "data-testid": tid.userSettingsOpen })

    await act(async () => settings.props.onClick())

    expect(order).toEqual(["close", "settings"])
    expect(onInboxOpenChange).toHaveBeenCalledOnce()
    expect(onEditProfile).toHaveBeenCalledOnce()
  })
})
