import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it } from "vitest"
import { PlatformLinkBadge } from "./platform-link-badge"

describe("PlatformLinkBadge", () => {
  it("uses the existing Alook favicon for first-party links", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(
          PlatformLinkBadge,
          { href: "https://alook.ai/c/invite/abcdef" },
          "https://alook.ai/c/invite/abcdef",
        ),
      )
    })

    const link = renderer!.root.findByType("a")
    expect(link.props["data-platform-link"]).toBe("alook")
    expect(link.props["data-message-external-link"]).toBe(true)
    expect(link.props["aria-label"]).toBe(
      "Alook: https://alook.ai/c/invite/abcdef",
    )
    const icon = renderer!.root.findByType("img")
    expect(icon.props.src).toBe("/favicon.ico")
    expect(icon.props.alt).toBe("")
  })

  it("adds a platform icon and accessible label to a supported URL", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(
          PlatformLinkBadge,
          { href: "https://github.com/alookai/alook/pull/598", target: "_blank" },
          "https://github.com/alookai/alook/pull/598",
        ),
      )
    })

    const link = renderer!.root.findByType("a")
    expect(link.props["data-platform-link"]).toBe("github")
    expect(link.props["data-message-external-link"]).toBe(true)
    expect(link.props["aria-label"]).toBe("GitHub: https://github.com/alookai/alook/pull/598")
    expect(link.props.target).toBe("_blank")
    expect(renderer!.root.findAllByType("svg")).toHaveLength(1)
    expect(renderer!.root.findByType("span").children.join("")).toBe(
      "https://github.com/alookai/alook/pull/598",
    )
  })

  it("uses a local-machine icon for localhost links", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(
          PlatformLinkBadge,
          { href: "http://localhost:3000/c/me" },
          "http://localhost:3000/c/me",
        ),
      )
    })

    const link = renderer!.root.findByType("a")
    expect(link.props["data-platform-link"]).toBe("local")
    expect(link.props["aria-label"]).toBe("Local: http://localhost:3000/c/me")
    expect(renderer!.root.findAllByType("svg")).toHaveLength(1)
  })

  it("reuses the product's official OpenAI mark", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(
          PlatformLinkBadge,
          { href: "https://platform.openai.com/docs" },
          "https://platform.openai.com/docs",
        ),
      )
    })

    const link = renderer!.root.findByType("a")
    expect(link.props["data-platform-link"]).toBe("openai")
    expect(renderer!.root.findByProps({ "data-provider-logo": "openai" })).toBeTruthy()
  })

  it("gives an unsupported URL the generic link icon and the same badge treatment", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(
          PlatformLinkBadge,
          { href: "https://example.com/story", className: "existing-link" },
          "Example story",
        ),
      )
    })

    const link = renderer!.root.findByType("a")
    expect(link.props.className).toContain("platform-link-badge")
    expect(link.props.className).toContain("existing-link")
    expect(link.props["data-platform-link"]).toBe("generic")
    expect(link.props["data-message-external-link"]).toBe(true)
    expect(link.props["aria-label"]).toBe("Link: https://example.com/story")
    expect(renderer!.root.findAllByType("svg")).toHaveLength(1)
    expect(renderer!.root.findByType("span").children.join("")).toBe("Example story")
  })
})
