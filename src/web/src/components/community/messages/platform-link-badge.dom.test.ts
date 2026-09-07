import React from "react"
import { describe, expect, it } from "vitest"
import { render, screen } from "@/test/react-dom-harness"
import { PlatformLinkBadge } from "./platform-link-badge"

describe("PlatformLinkBadge", () => {
  it("uses the existing Alook favicon for first-party links", () => {
    render(React.createElement(
      PlatformLinkBadge,
      { href: "https://alook.ai/c/invite/abcdef" },
      "https://alook.ai/c/invite/abcdef",
    ))

    const link = screen.getByRole("link", { name: "Alook: https://alook.ai/c/invite/abcdef" })
    expect(link).toHaveAttribute("data-platform-link", "alook")
    expect(link).toHaveAttribute("data-message-external-link", "true")
    const icon = link.querySelector("img")!
    expect(icon).toHaveAttribute("src", "/favicon.ico")
    expect(icon).toHaveAttribute("alt", "")
  })

  it("adds a platform icon and accessible label to a supported URL", () => {
    render(React.createElement(
      PlatformLinkBadge,
      { href: "https://github.com/alookai/alook/pull/598", target: "_blank" },
      "https://github.com/alookai/alook/pull/598",
    ))

    const link = screen.getByRole("link", { name: "GitHub: https://github.com/alookai/alook/pull/598" })
    expect(link).toHaveAttribute("data-platform-link", "github")
    expect(link).toHaveAttribute("data-message-external-link", "true")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link.querySelectorAll("svg")).toHaveLength(1)
    expect(link.querySelector("span")).toHaveTextContent("https://github.com/alookai/alook/pull/598")
  })

  it("uses a local-machine icon for localhost links", () => {
    render(React.createElement(
      PlatformLinkBadge,
      { href: "http://localhost:3000/c/me" },
      "http://localhost:3000/c/me",
    ))

    const link = screen.getByRole("link", { name: "Local: http://localhost:3000/c/me" })
    expect(link).toHaveAttribute("data-platform-link", "local")
    expect(link.querySelectorAll("svg")).toHaveLength(1)
  })

  it("reuses the product's official OpenAI mark", () => {
    render(React.createElement(
      PlatformLinkBadge,
      { href: "https://platform.openai.com/docs" },
      "https://platform.openai.com/docs",
    ))

    const link = screen.getByRole("link", { name: "OpenAI: https://platform.openai.com/docs" })
    expect(link).toHaveAttribute("data-platform-link", "openai")
    expect(link.querySelector('[data-provider-logo="openai"]')).toBeInTheDocument()
  })

  it("gives an unsupported URL the generic link icon and the same badge treatment", () => {
    render(React.createElement(
      PlatformLinkBadge,
      { href: "https://example.com/story", className: "existing-link" },
      "Example story",
    ))

    const link = screen.getByRole("link", { name: "Link: https://example.com/story" })
    expect(link).toHaveClass("platform-link-badge", "existing-link")
    expect(link).toHaveAttribute("data-platform-link", "generic")
    expect(link).toHaveAttribute("data-message-external-link", "true")
    expect(link.querySelectorAll("svg")).toHaveLength(1)
    expect(link.querySelector("span")).toHaveTextContent("Example story")
  })
})
