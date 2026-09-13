import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"
import { INITIAL_POSITION_CROSSFADE_MS } from "./initial-position-transition"
import { InitialPositionAurora } from "./initial-position-aurora"

vi.mock("./initial-position-aurora.module.css", () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

const styles = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "initial-position-aurora.module.css"),
  "utf8",
)
const componentSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "initial-position-aurora.tsx"),
  "utf8",
)
const globals = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../app/globals.css"),
  "utf8",
)

describe("InitialPositionAurora", () => {
  it("renders only for the visible and crossfade phases without interaction or prose", () => {
    const renderer = render(React.createElement(InitialPositionAurora, { phase: "positioning" }))
    expect(renderer.queryByTestId(tid.initialPositionAurora)).toBeNull()

    renderer.rerender(React.createElement(InitialPositionAurora, { phase: "aurora" }))
    const aurora = renderer.getByTestId(tid.initialPositionAurora)
    expect(aurora).toHaveAttribute("aria-hidden", "true")
    expect(aurora).toHaveAttribute("data-phase", "aurora")
    expect(aurora).toHaveTextContent("")
    expect(aurora).toHaveClass("visible")

    renderer.rerender(React.createElement(InitialPositionAurora, { phase: "revealing" }))
    expect(renderer.getByTestId(tid.initialPositionAurora)).toHaveAttribute(
      "data-phase",
      "revealing",
    )
    expect(renderer.getByTestId(tid.initialPositionAurora)).toBe(aurora)
    expect(aurora).toHaveClass("leaving")
    expect(aurora).not.toHaveClass("visible")
    renderer.rerender(React.createElement(InitialPositionAurora, { phase: "revealed" }))
    expect(renderer.queryByTestId(tid.initialPositionAurora)).toBeNull()
  })

  it("keeps Composer-bound geometry, deterministic bottom-anchored bars, and a linear 300ms exit", () => {
    const renderer = render(React.createElement(InitialPositionAurora, { phase: "aurora" }))
    const bars = Array.from(
      renderer.container.querySelectorAll<HTMLElement>("[data-aurora-bar]"),
    )
    const numberProperty = (bar: HTMLElement, property: string) =>
      Number.parseFloat(bar.style.getPropertyValue(property))
    const signature = () => Array.from(
      renderer.container.querySelectorAll<HTMLElement>("[data-aurora-bar]"),
      (bar) => [
        bar.dataset.layer,
        bar.dataset.tone,
        bar.dataset.motion,
        bar.getAttribute("style"),
      ],
    )

    expect(bars).toHaveLength(52)
    const layers = Array.from(
      renderer.container.querySelectorAll<HTMLElement>("[data-aurora-layer]"),
    )
    expect(layers).toHaveLength(2)
    expect(layers.map((layer) => [
      layer.dataset.auroraLayer,
      layer.querySelectorAll("[data-aurora-bar]").length,
    ])).toEqual([["fine", 39], ["broad", 13]])
    const firstSignature = signature()
    renderer.rerender(React.createElement(InitialPositionAurora, { phase: "aurora" }))
    expect(signature()).toEqual(firstSignature)
    expect(componentSource).not.toMatch(/Math\.random|\brandom\s*\(/)

    expect(styles).toMatch(/position:\s*absolute/)
    expect(styles).toMatch(/pointer-events:\s*none/)
    expect(styles).toContain(
      "left: calc(var(--community-composer-inline-start) + var(--community-composer-top-radius));",
    )
    expect(styles).toContain(
      "right: calc(var(--community-composer-inline-end) + var(--community-composer-top-radius));",
    )
    expect(globals).toContain(
      "--community-composer-inline-start: max(0.75rem, var(--app-safe-area-left));",
    )
    expect(globals).toContain(
      "--community-composer-inline-end: max(0.75rem, var(--app-safe-area-right));",
    )
    expect(globals).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\)[\s\S]*?--community-composer-top-radius:\s*0\.75rem;/,
    )
    expect(globals).toMatch(
      /@media \(min-width: 40rem\)[\s\S]*?--community-composer-inline-start:\s*0\.75rem;[\s\S]*?--community-composer-inline-end:\s*0\.75rem;/,
    )
    expect(globals).toContain("--community-composer-top-radius: 1.5rem;")

    expect(styles).toContain(`animation: aurora-enter ${INITIAL_POSITION_CROSSFADE_MS}ms var(--ease-out) both`)
    expect(styles).toContain(`animation: aurora-leave ${INITIAL_POSITION_CROSSFADE_MS}ms linear both`)
    expect(styles).toMatch(/@keyframes aurora-enter\s*\{\s*from \{ opacity: 0; \}\s*to \{ opacity: var\(--aurora-opacity\); \}/)
    expect(styles).toMatch(/@keyframes aurora-leave\s*\{\s*from \{ opacity: var\(--aurora-opacity\); \}\s*to \{ opacity: 0; \}/)
    expect(styles).toContain("calc(var(--initial-position-aurora-opacity) * 0.5)")
    expect(styles).toContain("calc(var(--initial-position-aurora-reduced-opacity) * 0.5)")
    expect(styles).toMatch(/\.aurora\s*\{[^}]*z-index: 0;/)
    expect(styles.match(/\.peaks\s*\{([^}]+)\}/)?.[1]).not.toMatch(/background:/)
    expect(styles).toContain("left: var(--bar-x);")
    expect(styles).toContain("transform-origin: center bottom;")
    expect(styles).toContain(
      "animation: aurora-bar-length var(--bar-duration) var(--ease-in-out) var(--bar-delay) infinite alternate both;",
    )
    expect(styles).toMatch(
      /@keyframes aurora-bar-length\s*\{\s*from\s*\{\s*transform:\s*scaleY\(var\(--bar-min-scale\)\);\s*\}\s*to\s*\{\s*transform:\s*scaleY\(1\);/,
    )
    expect(styles).not.toMatch(/translate(?:X|3d)?\s*\(/)
    expect(styles).toMatch(/\.aurora\s*\{[\s\S]*?height:\s*3\.5rem;/)
    expect(styles).toMatch(
      /@media \(max-width: 40rem\)[\s\S]*?\.aurora\s*\{[\s\S]*?height:\s*3rem;/,
    )
    const themeTokens = [
      "--initial-position-aurora-cyan",
      "--initial-position-aurora-blue",
      "--initial-position-aurora-violet",
      "--initial-position-aurora-magenta",
      "--initial-position-aurora-opacity",
      "--initial-position-aurora-bloom-opacity",
      "--initial-position-aurora-glint-opacity",
      "--initial-position-aurora-reduced-opacity",
    ]
    for (const token of themeTokens) {
      expect(styles).toContain(`var(${token})`)
      expect(globals.match(new RegExp(`${token}:`, "g"))).toHaveLength(2)
    }
    expect(styles).toMatch(/\.fineBars\s*\{[^}]*filter:\s*blur\(1px\)/)
    expect(styles).toMatch(/\.broadBars\s*\{[^}]*opacity:\s*0\.72;[^}]*filter:\s*blur\(5px\)/)
    const barRule = styles.match(/\.bar\s*\{([^}]+)\}/)?.[1] ?? ""
    expect(barRule).not.toContain("filter:")
    expect(barRule).not.toContain("will-change:")
    expect(styles).toContain(".haze::before")
    expect(styles).not.toContain("clip-path")
    expect(styles).not.toContain("repeating-linear-gradient")

    const peakProfiles = ["fine", "broad"].map((layer) => bars
      .filter((bar) => bar.dataset.layer === layer)
      .map((bar) => ({
        position: numberProperty(bar, "--bar-x"),
        height: numberProperty(bar, "--bar-height"),
      })))
    const meanHeight = (profile: Array<{ height: number }>) =>
      profile.reduce((sum, peak) => sum + peak.height, 0) / profile.length
    const hasRiseAndFall = (profile: Array<{ height: number }>) => {
      const changes = profile.slice(1).map((peak, index) => peak.height - profile[index]!.height)
      return changes.some((change) => change > 0) && changes.some((change) => change < 0)
    }
    for (const profile of peakProfiles) {
      expect(profile.find(({ position }) => position === 0)?.height).toBe(0)
      expect(profile.find(({ position }) => position === 100)?.height).toBe(0)
      const center = profile.filter(({ position }) => position >= 25 && position <= 75)
      const leftShoulder = profile.filter(({ position }) => position > 12.5 && position < 25)
      const leftOuter = profile.filter(({ position }) => position <= 12.5)
      const rightShoulder = profile.filter(({ position }) => position > 75 && position < 87.5)
      const rightOuter = profile.filter(({ position }) => position >= 87.5)
      expect(meanHeight(leftOuter)).toBeLessThan(meanHeight(leftShoulder))
      expect(meanHeight(leftShoulder)).toBeLessThan(meanHeight(center))
      expect(meanHeight(rightOuter)).toBeLessThan(meanHeight(rightShoulder))
      expect(meanHeight(rightShoulder)).toBeLessThan(meanHeight(center))
      expect(hasRiseAndFall(profile.filter(({ position }) => position <= 25))).toBe(true)
      expect(hasRiseAndFall(profile.filter(({ position }) => position >= 75).reverse())).toBe(true)
    }

    expect(new Set(bars.map((bar) => numberProperty(bar, "--bar-duration"))).size)
      .toBeGreaterThan(12)
    expect(new Set(bars.map((bar) => numberProperty(bar, "--bar-min-scale"))).size)
      .toBeGreaterThan(10)
    expect(new Set(bars.map((bar) => bar.dataset.motion)).size).toBe(bars.length)
    expect(new Set(bars.map((bar) => [
      bar.style.getPropertyValue("--bar-min-scale"),
      bar.style.getPropertyValue("--bar-duration"),
      bar.style.getPropertyValue("--bar-delay"),
    ].join("/"))).size).toBe(bars.length)
    const directionsAtStart = new Set(bars
      .filter((bar) => numberProperty(bar, "--bar-height") > 0)
      .map((bar) => {
        const duration = numberProperty(bar, "--bar-duration")
        const delay = numberProperty(bar, "--bar-delay")
        expect(delay).toBeLessThan(0)
        const phase = (-delay) % (duration * 2)
        return phase < duration ? "rising" : "falling"
      }))
    expect(directionsAtStart).toEqual(new Set(["rising", "falling"]))

    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.bar,[\s\S]*?\.haze,[\s\S]*?\.haze::before[\s\S]*?animation:\s*none/,
    )
    expect(styles).not.toMatch(/#[\da-f]{3,8}\b/i)
    expect(styles).not.toMatch(/oklch\(/)
  })
})
