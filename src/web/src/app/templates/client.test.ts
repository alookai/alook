import { describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { TemplatesClient } from "./client"
import { devopsMonitor } from "@/lib/templates/presets/devops-monitor"

vi.mock("@/lib/analytics", () => ({
  trackTemplatesBrowsed: vi.fn(),
  trackTemplateUsed: vi.fn(),
}))

vi.mock("@/components/public-layout", () => ({
  PublicLayout: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-mock": "layout" }, children),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children?: React.ReactNode
    href: string
  }) => React.createElement("a", { href }, children),
}))

function collectHeadingLevels(node: TestRenderer.ReactTestInstance): number[] {
  const levels: number[] = []
  const walk = (n: TestRenderer.ReactTestInstance) => {
    if (typeof n.type === "string" && /^h[1-6]$/.test(n.type)) {
      levels.push(Number(n.type.slice(1)))
    }
    for (const child of n.children) {
      if (typeof child !== "string") walk(child)
    }
  }
  walk(node)
  return levels
}

describe("TemplatesClient heading outline", () => {
  it("steps H1 → H2 → H3 without skipping a level", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TemplatesClient, {
          templates: [devopsMonitor],
          categories: ["Developer"],
          isLoggedIn: false,
        }),
      )
    })

    const levels = collectHeadingLevels(renderer.root)
    expect(levels).toEqual([1, 2, 3])
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1)
    }
  })
})
