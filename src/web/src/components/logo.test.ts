import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark", setTheme: vi.fn() }),
}))

vi.mock("next/image", () => ({
  default: ({ src, alt, width, height }: { src: string; alt: string; width: number; height: number }) =>
    createElement("img", { src, alt, width, height }),
}))

import { Logo } from "./logo"

describe("Logo", () => {
  it("uses the same multicolor brand mark in every theme", () => {
    const html = renderToStaticMarkup(createElement(Logo, { size: "lg" }))

    expect(html).toContain('src="/alook.svg"')
    expect(html).not.toContain("alook-dark.svg")
    expect(html.match(/<img/g)).toHaveLength(1)
    expect(html).toContain('width="36"')
    expect(html).toContain('height="36"')
  })
})
