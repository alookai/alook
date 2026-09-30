import { describe, expect, it } from "vitest"
import { DURATION, motionAt } from "./motion"

describe("Alook loading loop", () => {
  it("starts and ends on the same completed logo", () => {
    const completed = { joined: 1, orbit: 0, look: 0 }
    expect(motionAt(0)).toEqual(completed)
    expect(motionAt(DURATION - 1)).toEqual(completed)
  })
  it("separates only in the middle of the loop", () => {
    expect(motionAt(60)).toEqual({ joined: 1, orbit: 0, look: 0 })
    expect(motionAt(61).joined).toBeLessThan(1)
    expect(motionAt(61).orbit).toBeGreaterThan(0)
    expect(motionAt(204)).toEqual({ joined: 0, orbit: 0, look: 0 })
    expect(motionAt(510)).toEqual({ joined: 1, orbit: 0, look: 0 })
  })
  it("looks both ways and returns to center before the next merge", () => {
    expect(motionAt(240).look).toBe(-1)
    expect(motionAt(306).look).toBe(1)
    expect(motionAt(366).look).toBe(0)
  })
})
