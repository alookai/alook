import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("ServerRail Home brand mark", () => {
  it("uses the animated 40px mark with a consistent navigation label", () => {
    const source = readFileSync(new URL("./server-rail.tsx", import.meta.url), "utf8")

    expect(source).toContain('import { AnimatedAlookLogo } from "./animated-alook-logo"')
    expect(source).toContain('<AnimatedAlookLogo className="size-10" />')
    expect(source).toContain('aria-label="Home"')
    expect(source).toContain('<TooltipContent side="right" sideOffset={8}>Home</TooltipContent>')
    expect(source).not.toContain('>Direct Messages</TooltipContent>')
    expect(source).toContain("group/alook grid size-10")
    expect(source).toContain("gap-2 pt-2 pb-2")
    expect(source).not.toContain("hover:scale-110")
    expect(source).not.toContain('src="/alook.svg"')
    expect(source).not.toContain("alook-dark.svg")
  })
})
