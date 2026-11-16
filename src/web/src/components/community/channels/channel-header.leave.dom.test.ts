import React from "react"
import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, setupUser, waitFor } from "@/test/react-dom-harness"
import { ChannelHeader } from "./channel-header"

describe("ChannelHeader — overflow Leave action", () => {
  it("exposes Leave only when provided and keeps compact split headers clean", async () => {
    const user = setupUser()
    const publicForum = render(React.createElement(ChannelHeader, {
      channel: "ideas", kind: "forum", rightPanel: null, onToggle: vi.fn(),
      tools: { threads: false, pinned: false },
    }))
    expect(screen.queryByRole("button", { name: "More channel options" })).toBeNull()
    publicForum.unmount()

    const splitThread = render(React.createElement(ChannelHeader, {
      channel: "Thread", kind: "thread", rightPanel: null, onToggle: vi.fn(),
      compactActions: true, onLeave: vi.fn(),
    }))
    expect(screen.queryByRole("button", { name: "More channel options" })).toBeNull()
    splitThread.unmount()

    const privateForum = render(React.createElement(ChannelHeader, {
      channel: "secret-forum", kind: "forum", rightPanel: null, onToggle: vi.fn(),
      tools: { threads: false, pinned: false }, onLeave: vi.fn(),
    }))
    await user.click(screen.getByRole("button", { name: "More channel options" }))
    const leaveItem = await screen.findByRole("menuitem", { name: "Leave" })
    expect(leaveItem).toHaveAttribute("data-variant", "destructive")
    expect(document.querySelector('[data-slot="dropdown-menu-separator"]')).toBeNull()
    privateForum.unmount()
  })

  it("confirms Leave with unit-specific copy, blocks duplicate submits, and retains retry on failure", async () => {
    const user = setupUser()
    let resolveLeave!: () => void
    let rejectLeave!: (err: unknown) => void
    const onLeave = vi.fn(() => new Promise<void>((resolve, reject) => {
      resolveLeave = resolve
      rejectLeave = reject
    }))
    const view = render(React.createElement(ChannelHeader, {
      channel: "design-review", kind: "thread", rightPanel: null, onToggle: vi.fn(),
      tools: { threads: false }, onLeave,
    }))
    expect(screen.queryByRole("dialog")).toBeNull()

    await user.click(screen.getByRole("button", { name: "More channel options" }))
    const leaveItem = await screen.findByRole("menuitem", { name: "Leave" })
    expect(document.querySelector('[data-slot="dropdown-menu-separator"]')).not.toBeNull()
    await user.click(leaveItem)

    expect(await screen.findByText("Leave /design-review?")).toBeVisible()
    expect(screen.getByText("You'll stop receiving notifications for new replies.")).toBeVisible()
    const confirmBtn = screen.getByRole("button", { name: "Leave" })
    fireEvent.click(confirmBtn)
    fireEvent.click(confirmBtn)
    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Leaving…" })).toBeDisabled()

    await act(async () => { rejectLeave(new Error("leave failed")) })
    await waitFor(() => expect(screen.getByRole("button", { name: "Leave" })).toBeEnabled())

    fireEvent.click(screen.getByRole("button", { name: "Leave" }))
    expect(onLeave).toHaveBeenCalledTimes(2)
    await act(async () => { resolveLeave() })
    await waitFor(() => expect(screen.queryByText("Leave /design-review?")).toBeNull())
    view.unmount()
  })
})
