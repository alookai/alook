import { describe, expect, it, vi } from "vitest"
import React from "react"
import { fireEvent, render, screen } from "@/test/react-dom-harness"

vi.mock("../settings/create-dialog-shell", async () => {
  const ReactModule = await import("react")
  return {
    CreateDialogShell: ({ title, footer, children }: { title: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode }) => (
      ReactModule.createElement("div", { "data-testid": "create-dialog-shell", role: "dialog" },
        ReactModule.createElement("div", { className: "text-xs font-normal text-muted-foreground" }, title),
        children,
        footer,
      )
    ),
  }
})

import { ChannelHeader } from "./channel-header"

function renderHeader(onRename?: (name: string) => void | Promise<void>, titleRename = true) {
  return render(React.createElement(ChannelHeader, {
    channel: "Original title",
    kind: "thread",
    rightPanel: null,
    onToggle: () => {},
    tools: { threads: false, pinned: false, members: false },
    onRename,
    titleRename,
  }))
}

describe("ChannelHeader — forum title dialog", () => {
  it("gates the title edit affordance to the creator and keeps normal threads on Rename", () => {
    let renderer = renderHeader()
    expect(screen.getByRole("banner")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Edit post title" })).not.toBeInTheDocument()
    renderer.unmount()

    renderer = renderHeader(vi.fn())
    expect(screen.getByRole("button", { name: "Edit post title" })).toBeInTheDocument()
    expect(screen.queryByRole("textbox", { name: "Post title" })).not.toBeInTheDocument()
    renderer.unmount()

    renderer = renderHeader(vi.fn(), false)
    expect(screen.queryByRole("button", { name: "Edit post title" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument()
    renderer.unmount()
  })

  it("uses the shared create-dialog shell and hero input for post titles", () => {
    const renderer = renderHeader(vi.fn())
    fireEvent.click(screen.getByRole("button", { name: "Edit post title" }))

    expect(screen.getByRole("textbox", { name: "Post title" })).toHaveClass("text-[30px]")
    expect(screen.getByText("Edit post title", { selector: "div" }))
      .toHaveClass("text-xs", "font-normal", "text-muted-foreground")
    expect(screen.getByTestId("create-dialog-shell")).toBeInTheDocument()

    renderer.unmount()
  })

  it("prevents duplicate saves and keeps a failed post-title draft open", async () => {
    let rejectRename!: (reason?: unknown) => void
    let resolveRename!: () => void
    const onRename = vi.fn(() => new Promise<void>((resolve, reject) => {
      resolveRename = resolve
      rejectRename = reject
    }))
    const renderer = renderHeader(onRename)
    fireEvent.click(screen.getByRole("button", { name: "Edit post title" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Post title" }), {
      target: { value: "New title" },
    })

    const save = screen.getByRole("button", { name: "Save" })
    fireEvent.click(save)
    fireEvent.click(save)
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Post title" }), { key: "Enter" })
    expect(onRename).toHaveBeenCalledOnce()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()

    rejectRename(new Error("save failed"))
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled())
    expect(screen.getByRole("textbox", { name: "Post title" })).toHaveValue("New title")

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onRename).toHaveBeenCalledTimes(2)
    resolveRename()
    await Promise.resolve()

    renderer.unmount()
  })
})
