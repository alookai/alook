import rawContractInput0 from "./server-rail.tsx?raw"
import { describe, expect, it } from "vitest"

describe("ServerRail Home brand mark", () => {
  it("uses the animated 40px mark with a consistent navigation label", () => {
    const source = rawContractInput0

    expect(source).toContain('import { AnimatedAlookLogo } from "./animated-alook-logo"')
    expect(source).toContain('<AnimatedAlookLogo className="size-10" characterOnly={characterOnly} />')
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

  it("keeps an explicit active server controlled until the route commits", () => {
    const source = rawContractInput0

    expect(source).toContain("const activeId = activeFromProps || localActiveId")
    expect(source).toContain("setLocalActiveId(id)")
    expect(source).not.toContain("const [activeId, setActiveId]")
  })
})
