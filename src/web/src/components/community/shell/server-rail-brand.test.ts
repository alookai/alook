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

  it("pins Add while the server list shrinks only when its content exceeds the remaining space", () => {
    const source = readFileSync(new URL("./server-rail.tsx", import.meta.url), "utf8")

    const scrollViewport =
      'className="min-h-0 w-full shrink overflow-y-auto overflow-x-clip py-2 thin-scrollbar scrollbar-none"'
    const addRegion =
      'className="flex w-full shrink-0 justify-center pb-[calc(var(--community-rail-bottom-inset)+var(--app-safe-area-bottom))] sm:pb-(--community-rail-bottom-inset)"'

    expect(source).toContain("data-testid={tid.serverRailScroll}")
    expect(source).toContain(scrollViewport)
    expect(source).toContain(addRegion)
    expect(source).toContain('"--community-rail-bottom-inset": `${bottomInset ?? 8}px`')
    expect(source.indexOf(scrollViewport)).toBeLessThan(source.indexOf(addRegion))
    expect(scrollViewport).toContain("shrink")
    expect(scrollViewport).not.toContain("flex-1")
    expect(source).not.toContain("pb-2 overflow-y-auto overflow-x-clip thin-scrollbar")
  })

  it("keeps an explicit active server controlled until the route commits", () => {
    const source = readFileSync(new URL("./server-rail.tsx", import.meta.url), "utf8")

    expect(source).toContain("const activeId = activeFromProps || localActiveId")
    expect(source).toContain("setLocalActiveId(id)")
    expect(source).not.toContain("const [activeId, setActiveId]")
  })
})
