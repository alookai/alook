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

  it("starts beside the desktop Machines tab and follows it into the guide", () => {
    const geometry = guideMotionGeometry(
      { left: 417, top: 0, right: 1280, bottom: 800, width: 863, height: 800 },
      { left: 900, top: 500, right: 924, bottom: 524, width: 24, height: 24 },
      128,
      { left: 72, top: 64, right: 408, bottom: 100, width: 336, height: 36 },
    )

    expect(geometry).toMatchObject({
      startX: 424,
      startY: 64,
      controlX: 671.52,
      controlY: 116.32,
      endX: 900,
      endY: 500,
    })
    expect(guideMotionPath(geometry)).toBe(
      'path("M 424 64 Q 671.52 116.32, 900 500")',
    )
  })

  it("starts beside the mobile Machines title without leaving the viewport", () => {
    const geometry = guideMotionGeometry(
      { left: 0, top: 48, right: 390, bottom: 844, width: 390, height: 796 },
      { left: 280, top: 600, right: 304, bottom: 624, width: 24, height: 24 },
      104,
      { left: 64, top: 17, right: 133, bottom: 34, width: 69, height: 17 },
    )

    expect(geometry).toMatchObject({
      startX: 149,
      startY: 17,
      controlX: 240.7,
      controlY: 162.75,
      control2X: 264.28,
      control2Y: 279.35,
      endX: 280,
      endY: 600,
    })
    expect(geometry.startX + 104).toBeLessThanOrEqual(390)
    expect(geometry.startY).toBeGreaterThanOrEqual(0)
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
