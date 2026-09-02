import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import { EntityIcon } from "../entity-icon"
import { ChannelHeader } from "./channel-header"

function render(overrides: Record<string, unknown> = {}) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(createElement(ChannelHeader, {
      channel: "general",
      rightPanel: null,
      onToggle: vi.fn(),
      tools: { members: false, threads: false, pinned: false },
      ...overrides,
    }))
  })
  return renderer
}

describe("ChannelHeader hierarchy navigation", () => {
  it("uses one mobile-only 44px Back control for a top-level channel", () => {
    const onNavigate = vi.fn()
    const renderer = render({
      mobileBack: onNavigate,
    })

    const back = renderer.root.findByProps({ "aria-label": "Back" })
    expect(back.props.className).toContain("size-11")
    expect(back.props.className).toContain("sm:hidden")
    act(() => back.props.onClick())
    expect(onNavigate).toHaveBeenCalledOnce()
  })

  it("uses the same mobile Back control for a direct child parent", () => {
    const onNavigateParent = vi.fn()
    const renderer = render({
      mobileBack: onNavigateParent,
      channel: "Thread title",
      kind: "thread",
      onRename: vi.fn(),
    })

    const back = renderer.root.findByProps({ "aria-label": "Back" })
    expect(back.props.className).toContain("size-11")
    expect(back.props.className).toContain("sm:hidden")
    const rename = renderer.root.findByProps({ "aria-label": "Rename" })
    expect(rename.props.className).toContain("hidden")
    expect(rename.props.className).toContain("sm:inline-flex")
    act(() => back.props.onClick())
    expect(onNavigateParent).toHaveBeenCalledOnce()
  })

  it("shows only the current child identity and keeps parent navigation in Back", () => {
    const onNavigateParent = vi.fn()
    const renderer = render({
      mobileBack: onNavigateParent,
      kind: "thread",
      channel: "Thread title",
    })

    const current = renderer.root.findByProps({ title: "Thread title" })
    expect(current.type).toBe("span")
    expect(current.props.className).toContain("min-w-0")
    expect(renderer.root.findByType(EntityIcon).props.kind).toBe("thread")
    act(() => renderer.root.findByProps({ "aria-label": "Back" }).props.onClick())
    expect(onNavigateParent).toHaveBeenCalledOnce()
  })

  it("renders only supplied panel actions in compact split mode", () => {
    const renderer = render({
      compactActions: true,
      tools: undefined,
      notifLevel: "all",
      onSetNotifLevel: vi.fn(),
      endActions: createElement("button", { "aria-label": "Open thread full screen" }),
    })

    expect(renderer.root.findAllByProps({ "aria-label": "Member list" })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ "aria-label": "Channel notifications" })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ "aria-label": "More channel options" })).toHaveLength(0)
    expect(renderer.root.findByProps({ "aria-label": "Open thread full screen" })).toBeTruthy()
  })
})
