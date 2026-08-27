import { readFileSync } from "node:fs"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import {
  GuideMeAvatarMotion,
  guideMotionGeometry,
  guideMotionPath,
  scheduleAfterStablePaint,
} from "./guide-me-avatar-motion"

describe("first-signup guide avatar motion", () => {
  it("lands a large avatar exactly on the existing orbit avatar", () => {
    const geometry = guideMotionGeometry(
      { left: 100, top: 80, right: 900, bottom: 680, width: 800, height: 600 },
      { left: 610, top: 300, right: 634, bottom: 324, width: 24, height: 24 },
      128,
    )

    expect(geometry).toMatchObject({
      startX: 164,
      startY: 492,
      controlX: 395.92,
      endX: 610,
      endY: 300,
      endScale: 0.1875,
    })
    expect(geometry.controlY).toBeCloseTo(175.12)
    expect(guideMotionPath(geometry)).toBe(
      'path("M 164 492 Q 395.92 175.12, 610 300")',
    )
  })

  it("uses the rendered mobile avatar size when calculating the handoff scale", () => {
    const geometry = guideMotionGeometry(
      { left: 0, top: 0, right: 390, bottom: 700, width: 390, height: 700 },
      { left: 280, top: 410, right: 304, bottom: 434, width: 24, height: 24 },
      104,
    )

    expect(geometry.startX).toBe(31.2)
    expect(geometry.startY).toBe(532)
    expect(geometry.controlX).toBeCloseTo(205.36)
    expect(geometry.controlY).toBeCloseTo(500.28)
    expect(geometry.control2X).toBeCloseTo(250.144)
    expect(geometry.control2Y).toBeCloseTo(480.76)
    expect(geometry.endScale).toBeCloseTo(24 / 104)
    expect(geometry.clearanceScale).toBeCloseTo(32 / 104)
    expect(guideMotionPath(geometry)).toBe(
      'path("M 31.2 532 C 205.35999999999999 500.28, 250.144 480.76, 280 410")',
    )
  })

  it("waits for two animation frames so the empty state paints before motion starts", () => {
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    const scheduler = {
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        nextFrame += 1
        frames.set(nextFrame, callback)
        return nextFrame
      }),
      cancelAnimationFrame: vi.fn((frame: number) => {
        frames.delete(frame)
      }),
    }
    const start = vi.fn()

    const cancel = scheduleAfterStablePaint(start, scheduler)

    expect(start).not.toHaveBeenCalled()
    const firstFrame = frames.get(1)!
    frames.delete(1)
    firstFrame(16)
    expect(start).not.toHaveBeenCalled()

    const secondFrame = frames.get(2)!
    frames.delete(2)
    secondFrame(32)
    expect(start).toHaveBeenCalledOnce()

    cancel()
    expect(scheduler.cancelAnimationFrame).toHaveBeenCalledWith(1)
    expect(scheduler.cancelAnimationFrame).toHaveBeenCalledWith(2)
  })

  it("uses phase easings for the one-shot NPC motion while leaving orbit linear", () => {
    const styles = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8")

    expect(styles).toContain(
      "animation: community-guide-me-orbit 4.8s linear infinite;",
    )
    expect(styles).toContain(
      "animation: community-first-signup-guide-travel 4s linear both;",
    )
    expect(styles).toContain("offset-distance: 100%;")
    expect(styles).toContain("animation-timing-function: var(--ease-out);")
    expect(styles).toContain("animation-timing-function: var(--ease-in);")
    expect(styles).toContain("transform: translateX(-3px);")
    expect(styles).toContain("transform: translateX(2px);")
    expect(styles).toContain("animation-timing-function: var(--guide-flight-ease);")
    expect(styles).toContain("animation-name: community-first-signup-guide-scale-mobile;")
    expect(styles).toContain("transform: scale(var(--guide-clearance-scale));")
  })

  it("exposes stable QA targets for the travelling avatar and exact orbit landing point", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(GuideMeAvatarMotion, {
          seed: "same-guide-face",
          intro: true,
          stageRef: { current: null },
          onIntroComplete: vi.fn(),
        }),
      )
    })

    expect(renderer.root.findByProps({ "data-testid": tid.machineFirstSignupGuide })).toBeTruthy()
    expect(renderer.root.findByProps({ "data-testid": tid.machineGuideAvatarTarget })).toBeTruthy()
  })
})
