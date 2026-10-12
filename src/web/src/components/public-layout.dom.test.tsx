import React from "react"
import { render } from "@/test/react-dom-harness"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.ComponentProps<"a">) => (
    <a data-next-link="true" href={href} {...props}>{children}</a>
  ),
}))
vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}))

import { isCrossZoneNavigation, PublicLayout } from "./public-layout"

describe("PublicLayout zone navigation", () => {
  it("classifies only document transitions across Worker ownership", () => {
    expect(isCrossZoneNavigation("/guides#coding-agents", "main")).toBe(true)
    expect(isCrossZoneNavigation("/guides/", "blog")).toBe(false)
    expect(isCrossZoneNavigation("/guides-other", "main")).toBe(true)
    expect(isCrossZoneNavigation("/blog", "main")).toBe(true)
    expect(isCrossZoneNavigation("/blogger", "main")).toBe(true)
    expect(isCrossZoneNavigation("/templates", "main")).toBe(false)
    expect(isCrossZoneNavigation("/", "blog")).toBe(true)
    expect(isCrossZoneNavigation("/llms.txt", "blog")).toBe(true)
    expect(isCrossZoneNavigation("/blog/topic/agents", "blog")).toBe(false)
    expect(isCrossZoneNavigation("https://github.com/alookai/alook", "blog")).toBe(false)
  })

  it("uses hard anchors for Blog-to-main and Next links within Blog", () => {
    const { container } = render(
      <PublicLayout zone="blog" breadcrumb="Blog" footer="rich">
        content
      </PublicLayout>,
    )

    expect(container.innerHTML).toContain('<a href="/" class="flex items-center gap-1">')
    expect(container.innerHTML).toContain('data-next-link="true" href="/blog"')
    expect(container.innerHTML).toContain('<a href="/templates"')
    expect(container.innerHTML).toContain('<a href="/llms.txt"')
  })

  it("uses hard anchors for main-to-Blog and Next links within main", () => {
    const { container } = render(
      <PublicLayout zone="main" footer="rich">content</PublicLayout>,
    )

    expect(container.innerHTML).toContain('data-next-link="true" href="/"')
    expect(container.innerHTML).toContain('<a href="/blog"')
    expect(container.innerHTML).toContain('data-next-link="true" href="/templates"')
  })
})
