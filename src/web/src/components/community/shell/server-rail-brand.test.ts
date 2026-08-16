import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("ServerRail Home brand mark", () => {
  it("uses the animated 40px mark with a consistent navigation label", () => {
    const source = readFileSync(new URL("./server-rail.tsx", import.meta.url), "utf8")

    expect(source).toContain('import { AnimatedAlookLogo } from "./animated-alook-logo"')
    expect(source).toContain('<AnimatedAlookLogo className="size-10" />')
    expect(source).toContain('aria-label="Home"')
    expect(source).toContain('data-testid={tid.homeButton}')
    expect(source).toContain('<TooltipContent side="right" sideOffset={8}>Home</TooltipContent>')
    expect(source).not.toContain('>Direct Messages</TooltipContent>')
    expect(source).toContain("group/alook grid size-10")
    expect(source).toContain("flex min-h-0 w-14 shrink-0 flex-col items-center overflow-hidden pt-2")
    expect(source).not.toContain("hover:scale-110")
    expect(source).not.toContain('src="/alook.svg"')
    expect(source).not.toContain("alook-dark.svg")
  })

  it("lets Add follow short lists while only the server list shrinks on overflow", () => {
    const source = readFileSync(new URL("./server-rail.tsx", import.meta.url), "utf8")

    const scrollViewport =
      'className="min-h-0 w-full shrink overflow-y-auto overflow-x-clip py-2 thin-scrollbar scrollbar-none"'
    const addRegion =
      'className="flex w-full shrink-0 justify-center" style={{ paddingBottom: bottomInset ?? 8 }}'

    expect(source).toContain("data-testid={tid.serverRailScroll}")
    expect(source).toContain(scrollViewport)
    expect(source).toContain(addRegion)
    expect(source.indexOf(scrollViewport)).toBeLessThan(source.indexOf(addRegion))
    expect(scrollViewport).not.toContain("flex-1")
    expect(source).not.toContain("pb-2 overflow-y-auto overflow-x-clip thin-scrollbar")
  })
})
