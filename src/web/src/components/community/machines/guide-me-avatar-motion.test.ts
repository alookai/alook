import { readFileSync } from "node:fs"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import {
  GuideMeAvatarMotion,
  guideMotionGeometry,
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
      midX: 409.3,
      endX: 610,
      endY: 300,
      endScale: 0.1875,
    })
    expect(geometry.midY).toBeCloseTo(246.48)
  })

  it("uses the rendered mobile avatar size when calculating the handoff scale", () => {
    const geometry = guideMotionGeometry(
      { left: 0, top: 0, right: 390, bottom: 700, width: 390, height: 700 },
      { left: 280, top: 410, right: 304, bottom: 434, width: 24, height: 24 },
      104,
    )

    expect(geometry.startX).toBe(31.2)
    expect(geometry.startY).toBe(532)
    expect(geometry.endScale).toBeCloseTo(24 / 104)
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
      "animation: community-first-signup-guide-travel 1.42s var(--ease-in-out) both;",
    )
    expect(styles).toContain("animation-timing-function: var(--ease-out);")
    expect(styles).toContain("animation-timing-function: var(--ease-in);")
    expect(styles).toContain("animation-timing-function: var(--ease-in-out);")
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
