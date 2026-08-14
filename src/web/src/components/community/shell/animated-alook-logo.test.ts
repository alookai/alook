import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  AnimatedAlookLogo,
  ENTER_PROGRESS,
  EXIT_PROGRESS,
  MOTION_DURATION_MS,
  MOTION_OFFSETS,
  REVEAL_MATRIX,
  motionProgressAt,
  transformForProgress,
} from "./animated-alook-logo"

describe("AnimatedAlookLogo", () => {
  it("renders the approved structured Default state", () => {
    const html = renderToStaticMarkup(createElement(AnimatedAlookLogo, { className: "size-10" }))

    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="Alook"')
    expect(html).toContain('data-testid="community-alook-logo"')
    expect(html).toContain('data-state="default"')
    expect(html).toContain('rx="236"')
    expect(html.match(/data-face=/g)).toHaveLength(5)
    expect(html.match(/data-part="expression" opacity="0"/g)).toHaveLength(4)
    expect(html.match(/<path/g)).toHaveLength(21)
    expect(html).toContain('data-motion-layer="foreground" transform="matrix(1 0 0 1 0 0)"')
    expect(html).not.toContain("#F2E7D2")
  })

  it("locks the approved Reveal transform and damped timing", () => {
    expect(REVEAL_MATRIX).toEqual([0.82598, 0, 0, 0.82599, 194.784, 194.424])
    expect(MOTION_DURATION_MS).toBe(300)
    expect(MOTION_OFFSETS).toEqual([0, 0.55, 0.73, 0.88, 1])
    expect(ENTER_PROGRESS).toEqual([0, 1.06, 0.975, 1.01, 1])
    expect(EXIT_PROGRESS).toEqual([1, -0.06, 0.025, -0.01, 0])
    expect(transformForProgress(1)).toBe("matrix(0.82598 0 0 0.82599 194.784 194.424)")
    expect(motionProgressAt(true, 0, 165)).toBeCloseTo(1.06, 5)
    expect(motionProgressAt(false, 1, 165)).toBeCloseTo(-0.06, 5)
    expect(motionProgressAt(true, 0.43, 0)).toBeCloseTo(0.43, 5)
    expect(motionProgressAt(false, 0.61, 0)).toBeCloseTo(0.61, 5)
    expect(motionProgressAt(true, 0, 300)).toBe(1)
    expect(motionProgressAt(false, 1, 300)).toBe(0)
  })

  it("declares desktop, mobile, reduced-motion, pointer, and keyboard behavior", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("./animated-alook-logo.tsx", import.meta.url), "utf8"),
    )

    expect(source).toContain('(max-width: 639px)')
    expect(source).toContain('(prefers-reduced-motion: reduce)')
    expect(source).toContain('addEventListener("pointerenter"')
    expect(source).toContain('addEventListener("pointerleave"')
    expect(source).toContain('addEventListener("focus"')
    expect(source).toContain('addEventListener("blur"')
    expect(source).toContain("const startProgress = progressRef.current")
  })
})
