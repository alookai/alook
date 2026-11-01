import { describe, expect, it, vi } from "vitest"
import React from "react"
import { act, fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"

import { ChannelHeader } from "./channel-header"

function renderHeader(onRename?: (name: string) => void | Promise<void>) {
  return render(React.createElement(ChannelHeader, {
    channel: "Original title",
    kind: "thread",
    rightPanel: null,
    onToggle: () => {},
    tools: { threads: false, pinned: false, members: false },
    onRename,
  }))
}

describe("ChannelHeader — ordinary thread rename dialog", () => {
  it("shows Rename only when an ordinary thread provides the action", () => {
    const view = renderHeader()
    expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument()
    view.unmount()
    renderHeader(vi.fn())
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument()
  })

  it("prevents duplicate saves and keeps a failed thread-name draft open", async () => {
    let rejectRename!: (reason?: unknown) => void
    let resolveRename!: () => void
    const onRename = vi.fn(() => new Promise<void>((resolve, reject) => {
      resolveRename = resolve
      rejectRename = reject
    }))
    const renderer = renderHeader(onRename)
    fireEvent.click(screen.getByRole("button", { name: "Rename" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Thread name" }), {
      target: { value: "New title" },
    })

    const save = screen.getByRole("button", { name: "Save" })
    fireEvent.click(save)
    fireEvent.click(save)
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Thread name" }), { key: "Enter" })
    expect(onRename).toHaveBeenCalledOnce()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()

    await act(async () => { rejectRename(new Error("save failed")) })
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled())
    expect(screen.getByRole("textbox", { name: "Thread name" })).toHaveValue("New title")

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onRename).toHaveBeenCalledTimes(2)
    await act(async () => { resolveRename() })

    renderer.unmount()
  })
})
