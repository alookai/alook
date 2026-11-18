import React from "react"
import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, setupUser, waitFor } from "@/test/react-dom-harness"
import { ChannelHeader } from "./channel-header"
import { ConversationActivityContext } from "@/contexts/view-activity"

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

  it.each(["text", "forum"] as const)("keeps the opened %s intent without granting an old callback authority", async kind => {
    const user = setupUser(), oldLeave = vi.fn(), currentLeave = vi.fn(() => Promise.resolve())
    const props = { channel: "secret", kind, rightPanel: null, onToggle: vi.fn(),
      tools: kind === "forum" ? { threads: false, pinned: false } : undefined }
    const view = render(React.createElement(ChannelHeader, { ...props, onLeave: oldLeave }))
    await user.click(screen.getByRole("button", { name: "More channel options" }))
    await user.click(await screen.findByRole("menuitem", { name: "Leave" }))
    view.rerender(React.createElement(ChannelHeader, props))
    expect(screen.getByText("Leave /secret?")).toBeVisible()
    const confirm = screen.getByRole("button", { name: "Leave" })
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(oldLeave).not.toHaveBeenCalled()
    view.rerender(React.createElement(ChannelHeader, { ...props, onLeave: currentLeave }))
    await user.click(screen.getByRole("button", { name: "Leave" }))
    await waitFor(() => expect(screen.queryByText("Leave /secret?")).toBeNull())
    expect(currentLeave).toHaveBeenCalledOnce()
    expect(oldLeave).not.toHaveBeenCalled()
  })

  it("allows cancellation while qualification is absent and does not reopen on requalification", async () => {
    const user = setupUser(), onLeave = vi.fn()
    const props = { channel: "secret", kind: "forum" as const, rightPanel: null, onToggle: vi.fn(), tools: { threads: false, pinned: false } }
    const view = render(React.createElement(ChannelHeader, { ...props, onLeave }))
    await user.click(screen.getByRole("button", { name: "More channel options" }))
    await user.click(await screen.findByRole("menuitem", { name: "Leave" }))
    view.rerender(React.createElement(ChannelHeader, props))
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled()
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    view.rerender(React.createElement(ChannelHeader, { ...props, onLeave }))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(onLeave).not.toHaveBeenCalled()
  })

  it.each(["channel", "activity"] as const)("retires the opened intent across %s changes without reopening it on return", async boundary => {
    const user = setupUser(), onLeave = vi.fn()
    const node = (channel: string, active: boolean) => React.createElement(ConversationActivityContext, { value: active },
      React.createElement(ChannelHeader, { channel, kind: "forum", rightPanel: null, onToggle: vi.fn(), tools: { threads: false, pinned: false }, onLeave }))
    const view = render(node("secret", true))
    await user.click(screen.getByRole("button", { name: "More channel options" }))
    await user.click(await screen.findByRole("menuitem", { name: "Leave" }))
    view.rerender(node(boundary === "channel" ? "other" : "secret", boundary !== "activity"))
    expect(screen.queryByRole("dialog")).toBeNull()
    view.rerender(node("secret", true))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(onLeave).not.toHaveBeenCalled()
  })
})
