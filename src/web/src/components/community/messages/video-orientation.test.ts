import { describe, expect, it } from "vitest"
import { playerPointerFraction, playerPointerRegion, playerRelativeRotation } from "./video-orientation"

describe("player-local coordinates", () => {
  it("distinguishes positions along both rotated tracks instead of collapsing them to their screen X", () => {
    const bounds = { left: 100, top: 50, width: 8, height: 200 }
    for (const [y, clockwise, counterclockwise] of [[70, 0.1, 0.9], [230, 0.9, 0.1]]) {
      const point = { clientX: 104, clientY: y }
      expect(playerPointerFraction(point, bounds, 90)).toBeCloseTo(clockwise)
      expect(playerPointerFraction(point, bounds, -90)).toBeCloseTo(counterclockwise)
    }
  })

  it("keeps outside positions available for the existing control's clamping and preserves the upright axis", () => {
    const bounds = { left: 20, top: 40, width: 200, height: 20 }
    expect(playerPointerFraction({ clientX: 0, clientY: 50 }, bounds, 0)).toBe(-0.1)
    expect(playerPointerFraction({ clientX: 240, clientY: 50 }, bounds, 0)).toBe(1.1)
    expect(playerPointerFraction({ clientX: 120, clientY: 50 }, bounds, 0)).toBe(0.5)
    expect(playerPointerFraction({ clientX: 20, clientY: 40 }, { ...bounds, width: 0 }, 0)).toBe(0)
  })

  it("uses the player's logical thirds for gestures in either landscape direction", () => {
    const bounds = { left: 10, top: 20, width: 200, height: 600 }
    for (const rotation of [-90, 90] as const) {
      expect(playerPointerRegion({ clientX: 100, clientY: 320 }, bounds, rotation)).toBe("center")
      expect(playerPointerRegion({ clientX: 100, clientY: rotation === 90 ? 50 : 590 }, bounds, rotation)).toBe("left")
      expect(playerPointerRegion({ clientX: 100, clientY: rotation === 90 ? 590 : 50 }, bounds, rotation)).toBe("right")
    }
  })

  it("subtracts the physical direction from the interface rotation without rotating an already aligned tablet", () => {
    expect(playerRelativeRotation(90, 0)).toBe(-90)
    expect(playerRelativeRotation(270, 0)).toBe(90)
    for (const angle of [0, 90, 180, 270]) expect(playerRelativeRotation(angle, angle)).toBe(0)
    expect(playerRelativeRotation(0, 90)).toBe(90)
    expect(playerRelativeRotation(180, 0)).toBe(0)
  })
})
