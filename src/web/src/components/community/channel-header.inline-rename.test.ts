import { describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { ChannelHeader } from "./channel-header"

function renderHeader(onRename?: (name: string) => void | Promise<void>, inlineRename = true) {
  return TestRenderer.create(
    React.createElement(ChannelHeader, {
      channel: "forum",
      forum: true,
      rightPanel: null,
      onToggle: () => {},
      tools: { threads: false, pinned: false, members: false },
      breadcrumb: { label: "Original title", onRename, inlineRename },
    }),
  )
}

describe("ChannelHeader — inline forum title editor", () => {
  it("shows no edit affordance without author permission and keeps normal threads on Rename", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => { renderer = renderHeader() })
    expect(renderer!.root.findAllByProps({ "aria-label": "Edit post title" })).toHaveLength(0)
    act(() => renderer!.unmount())

    act(() => { renderer = renderHeader(vi.fn(), false) })
    expect(renderer!.root.findAllByProps({ "aria-label": "Edit post title" })).toHaveLength(0)
    expect(renderer!.root.findAllByProps({ "aria-label": "Rename" }).length).toBeGreaterThan(0)
    act(() => renderer!.unmount())
  })

  it("trims and saves on Enter, while Escape cancels without submitting", async () => {
    const onRename = vi.fn(async () => {})
    let renderer: TestRenderer.ReactTestRenderer
    act(() => { renderer = renderHeader(onRename) })
    act(() => renderer!.root.findByProps({ "aria-label": "Edit post title" }).props.onClick())
    const input = renderer!.root.findByProps({ "aria-label": "Post title" })
    act(() => input.props.onChange({ target: { value: "  Updated title  " } }))
    await act(async () => renderer!.root.findByProps({ "aria-label": "Post title" }).props.onKeyDown({
      key: "Enter", preventDefault: vi.fn(),
    }))
    expect(onRename).toHaveBeenCalledWith("Updated title")

    act(() => renderer!.root.findByProps({ "aria-label": "Edit post title" }).props.onClick())
    act(() => renderer!.root.findByProps({ "aria-label": "Post title" }).props.onChange({ target: { value: "Discard me" } }))
    act(() => renderer!.root.findByProps({ "aria-label": "Post title" }).props.onKeyDown({
      key: "Escape", preventDefault: vi.fn(),
    }))
    expect(onRename).toHaveBeenCalledTimes(1)
  })

  it("blocks duplicate saves and retains the draft after rejection", async () => {
    let reject!: (error: Error) => void
    const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise })
    const onRename = vi.fn(() => pending)
    let renderer: TestRenderer.ReactTestRenderer
    act(() => { renderer = renderHeader(onRename) })
    act(() => renderer!.root.findByProps({ "aria-label": "Edit post title" }).props.onClick())
    act(() => renderer!.root.findByProps({ "aria-label": "Post title" }).props.onChange({ target: { value: "Retry title" } }))

    const save = renderer!.root.findAllByType("button")
      .find((button) => button.children.includes("Save"))
    act(() => {
      save!.props.onClick()
      save!.props.onClick()
    })
    expect(onRename).toHaveBeenCalledTimes(1)
    expect(renderer!.root.findByProps({ "aria-label": "Post title" }).props.value).toBe("Retry title")

    await act(async () => reject(new Error("network")))
    expect(renderer!.root.findByProps({ "aria-label": "Post title" }).props.value).toBe("Retry title")
    expect(renderer!.root.findByProps({ "aria-label": "Post title" })).toBeTruthy()
  })
})
