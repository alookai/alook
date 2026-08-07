import { describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { ChannelHeader } from "./channel-header"

function renderHeader(onRename?: (name: string) => void | Promise<void>, titleRename = true) {
  return TestRenderer.create(
    React.createElement(ChannelHeader, {
      channel: "forum",
      forum: true,
      rightPanel: null,
      onToggle: () => {},
      tools: { threads: false, pinned: false, members: false },
      breadcrumb: { label: "Original title", onRename, titleRename },
    }),
  )
}

describe("ChannelHeader — forum title dialog", () => {
  it("gates the title edit affordance to the creator and keeps normal threads on Rename", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => { renderer = renderHeader() })
    expect(renderer!.root.findAllByProps({ "aria-label": "Edit post title" })).toHaveLength(0)
    act(() => renderer!.unmount())

    act(() => { renderer = renderHeader(vi.fn()) })
    expect(renderer!.root.findAllByProps({ "aria-label": "Edit post title" }).length).toBeGreaterThan(0)
    expect(renderer!.root.findAllByProps({ "aria-label": "Post title" })).toHaveLength(0)
    act(() => renderer!.unmount())

    act(() => { renderer = renderHeader(vi.fn(), false) })
    expect(renderer!.root.findAllByProps({ "aria-label": "Edit post title" })).toHaveLength(0)
    expect(renderer!.root.findAllByProps({ "aria-label": "Rename" }).length).toBeGreaterThan(0)
    act(() => renderer!.unmount())
  })
})
