import rawContractInput0 from "./connect-tile.tsx?raw"
import { describe, expect, it } from "vitest"

describe("ConnectTile brand mark", () => {
  it("loads the shared multicolor asset directly", () => {
    const source = rawContractInput0

    expect(source).toContain('href="/alook.svg"')
    expect(source).toContain('className="ot-alook ot-center"')
    expect(source).not.toContain("id.alook")
  })
})
