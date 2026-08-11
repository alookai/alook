import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("ConnectTile brand mark", () => {
  it("loads the shared multicolor asset directly", () => {
    const source = readFileSync(new URL("./connect-tile.tsx", import.meta.url), "utf8")

    expect(source).toContain('href="/alook.svg"')
    expect(source).toContain('className="ot-alook ot-center"')
    expect(source).not.toContain("id.alook")
  })
})
