import { describe, expect, it } from "vitest"
import { DURATION, motionAt } from "./motion"

describe("Alook loading loop", () => {
  it("joins the final and first frames without a state jump", () => {
    expect(motionAt(DURATION - 1)).toEqual(motionAt(0))
    expect(motionAt(1).joined).toBeLessThan(0.00001)
  })
  it("holds the completed logo before continuing into separation", () => {
    for (const frame of [144, 180, 204]) {
      expect(motionAt(frame)).toEqual({ joined: 1, orbit: 0, look: 0 })
    }
    expect(motionAt(205).joined).toBeLessThan(1)
    expect(motionAt(205).orbit).toBeGreaterThan(0)
    expect(motionAt(348)).toEqual({ joined: 0, orbit: 0, look: 0 })
  })
  it("looks both ways and returns to center before the next merge", () => {
    expect(motionAt(384).look).toBe(-1)
    expect(motionAt(450).look).toBe(1)
    expect(motionAt(510).look).toBe(0)
  })
})
