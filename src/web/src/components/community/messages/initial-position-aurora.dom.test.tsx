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

  it("keeps non-layout overlay geometry, semantic aurora paint, reduced-motion static layers, and a linear 300ms exit", () => {
    expect(styles).toMatch(/position:\s*absolute/)
    expect(styles).toMatch(/pointer-events:\s*none/)
    expect(styles).toContain(`animation: aurora-enter ${INITIAL_POSITION_CROSSFADE_MS}ms var(--ease-out) both`)
    expect(styles).toContain(`animation: aurora-leave ${INITIAL_POSITION_CROSSFADE_MS}ms linear both`)
    expect(styles).toMatch(/@keyframes aurora-enter\s*\{\s*from \{ opacity: 0; \}\s*to \{ opacity: var\(--aurora-opacity\); \}/)
    expect(styles).toMatch(/@keyframes aurora-leave\s*\{\s*from \{ opacity: var\(--aurora-opacity\); \}\s*to \{ opacity: 0; \}/)
    expect(styles).toContain("calc(var(--initial-position-aurora-opacity) * 0.5)")
    expect(styles).toContain("calc(var(--initial-position-aurora-reduced-opacity) * 0.5)")
    expect(styles).toMatch(/\.aurora\s*\{[^}]*z-index: 0;/)
    expect(styles.match(/\.peaks\s*\{([^}]+)\}/)?.[1]).not.toMatch(/background:/)
    expect(styles).toMatch(/animation: aurora-drift [\d.]+s var\(--ease-in-out\) -[\d.]+s infinite alternate/)
    expect(styles).toContain("translateX(-4%)")
    expect(styles).toContain("translateX(4%)")
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
    expect(styles).toContain(".peaks::before")
    expect(styles).toContain(".peaks::after")
    expect(styles).toContain(".haze::before")
    expect(styles).not.toContain("clip-path")
    expect(styles).not.toContain("repeating-linear-gradient")
    expect(styles).not.toMatch(/\brandom\s*\(/)

    const peakProfiles = ["before", "after"].map((pseudo) => {
      const block = styles.match(new RegExp(`\\.peaks::${pseudo}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1]
      expect(block).toBeTruthy()
      return Array.from(
        block!.matchAll(
          /transparent\)\s+([\d.]+)%\s+100%\s*\/\s*[\d.]+rem\s+([\d.]+)%\s+no-repeat/g,
        ),
        ([, position, height]) => ({ position: Number(position), height: Number(height) }),
      )
    })
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
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.drift,[\s\S]*?\.peaks::before,[\s\S]*?\.peaks::after,[\s\S]*?\.haze,[\s\S]*?\.haze::before[\s\S]*?animation:\s*none/,
    )
    expect(styles).not.toMatch(/#[\da-f]{3,8}\b/i)
    expect(styles).not.toMatch(/oklch\(/)
  })
})
