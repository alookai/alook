import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
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
  it("uses one mobile-only 44px server control and suppresses legacy Back", () => {
    const onNavigate = vi.fn()
    const onBack = vi.fn()
    const renderer = render({
      mobileServer: { id: "s1", name: "Studio", icon: null, onNavigate },
      onBack,
    })

    const server = renderer.root.findByProps({ "data-testid": tid.channelHeaderServer("s1") })
    expect(server.props).toMatchObject({
      type: "button",
      "aria-label": "Go to server Studio",
    })
    expect(server.props.className).toContain("size-11")
    expect(server.props.className).toContain("sm:hidden")
    expect(server.findByType("span").props.className).toContain("size-6")
    act(() => server.props.onClick())
    expect(onNavigate).toHaveBeenCalledOnce()
    expect(onBack).not.toHaveBeenCalled()
    expect(renderer.root.findAllByProps({ "aria-label": "Back" })).toHaveLength(0)
  })

  it("replaces the mobile child server control with one narrow direct-parent Back", () => {
    const onNavigateServer = vi.fn()
    const onNavigateParent = vi.fn()
    const renderer = render({
      mobileServer: { id: "s1", name: "Studio", icon: null, onNavigate: onNavigateServer },
      onBack: onNavigateParent,
      breadcrumb: {
        id: "c1",
        label: "Thread title",
        onNavigate: onNavigateParent,
        onRename: vi.fn(),
      },
    })

    expect(renderer.root.findAllByProps({
      "data-testid": tid.channelHeaderServer("s1"),
    })).toHaveLength(0)
    const back = renderer.root.findByProps({ "aria-label": "Back" })
    expect(back.props.className).toContain("h-11")
    expect(back.props.className).toContain("w-8")
    expect(back.props.className).toContain("sm:hidden")
    const rename = renderer.root.findByProps({ "aria-label": "Rename" })
    expect(rename.props.className).toContain("hidden")
    expect(rename.props.className).toContain("sm:inline-flex")
    act(() => back.props.onClick())
    expect(onNavigateParent).toHaveBeenCalledOnce()
    expect(onNavigateServer).not.toHaveBeenCalled()
  })

  it("preserves an uploaded server image inside the 24px mobile visual", () => {
    const renderer = render({
      mobileServer: {
        id: "s1",
        name: "Studio",
        icon: "https://example.test/server.png",
        onNavigate: vi.fn(),
      },
    })

    const server = renderer.root.findByProps({ "data-testid": tid.channelHeaderServer("s1") })
    const image = server.findByType("img")
    expect(image.props).toMatchObject({
      src: "https://example.test/server.png",
      alt: "",
      className: "size-full object-cover",
    })
    expect(server.findByType("span").props.className).toContain("size-6")
  })

  it("navigates a verified parent directly while the current child stays inert", () => {
    const onNavigateParent = vi.fn()
    const renderer = render({
      channel: "general",
      mobileServer: { id: "s1", name: "Studio", icon: null, onNavigate: vi.fn() },
      breadcrumb: {
        id: "c1",
        label: "Thread title",
        onNavigate: onNavigateParent,
      },
    })

    const parent = renderer.root.findByProps({ "data-testid": tid.channelHeaderParent("c1") })
    expect(parent.props.className).toContain("min-w-0")
    expect(parent.props.className).toContain("max-w-24")
    expect(parent.props.className).toContain("sm:max-w-none")
    act(() => parent.props.onClick())
    expect(onNavigateParent).toHaveBeenCalledOnce()
    const current = renderer.root.findByProps({ title: "Thread title" })
    expect(current.type).toBe("span")
    expect(current.props.className).toContain("min-w-8")
    expect(current.props.className).toContain("sm:min-w-0")
  })
})
