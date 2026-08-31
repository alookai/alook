import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("Popover primitive surface", () => {
  const source = readFileSync(new URL("./popover.tsx", import.meta.url), "utf8")

  it("exposes Base UI's real nonmodal composition parts", () => {
    for (const part of [
      "PopoverBackdrop",
      "PopoverClose",
      "PopoverPopup",
      "PopoverPortal",
      "PopoverPositioner",
      "PopoverTitle",
    ]) {
      expect(source).toContain(`function ${part}`)
      expect(source).toContain(`  ${part},`)
    }
    expect(source).toContain("<PopoverPrimitive.Backdrop")
    expect(source).not.toContain("pointer-events-none fixed z-50")
  })

  it("keeps existing PopoverContent positioning and portal behavior", () => {
    expect(source).toContain("function PopoverContent")
    expect(source).toContain("typeof document !== \"undefined\" ? document.body : null")
    expect(source).toContain("sideOffset = 6")
    expect(source).toContain("align = \"start\"")
    expect(source).toContain('style={{ zIndex: 60 }}')
    expect(source).toContain("w-72 origin-(--transform-origin) rounded-lg border")
  })
})
