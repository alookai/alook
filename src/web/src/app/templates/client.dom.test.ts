import { createElement, type ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { TemplatesClient } from "./client"
import { devopsMonitor } from "@/lib/templates/presets/devops-monitor"

vi.mock("@/lib/analytics", () => ({
  trackTemplatesBrowsed: vi.fn(),
  trackTemplateUsed: vi.fn(),
}))

vi.mock("@/components/public-layout", () => ({
  PublicLayout: ({ children }: { children?: ReactNode }) =>
    createElement("div", { "data-mock": "layout" }, children),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: ReactNode; href: string }) =>
    createElement("a", { href }, children),
}))

describe("TemplatesClient heading outline", () => {
  it("steps H1 → H2 → H3 without skipping a level", () => {
    const rendered = render(createElement(TemplatesClient, {
      templates: [devopsMonitor],
      categories: ["Developer"],
      isLoggedIn: false,
    }))

    const levels = Array.from(
      rendered.container.querySelectorAll("h1, h2, h3, h4, h5, h6"),
      (heading) => Number(heading.tagName.slice(1)),
    )
    expect(levels).toEqual([1, 2, 3])
    for (let index = 1; index < levels.length; index++) {
      expect(levels[index]! - levels[index - 1]!).toBeLessThanOrEqual(1)
    }
  })
})
