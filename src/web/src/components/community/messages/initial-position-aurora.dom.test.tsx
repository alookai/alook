import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"
import { InitialPositionAurora } from "./initial-position-aurora"

vi.mock("./initial-position-aurora.module.css", () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

const styles = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "initial-position-aurora.module.css"),
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

    renderer.rerender(React.createElement(InitialPositionAurora, { phase: "revealing" }))
    expect(renderer.getByTestId(tid.initialPositionAurora)).toHaveAttribute(
      "data-phase",
      "revealing",
    )
    renderer.rerender(React.createElement(InitialPositionAurora, { phase: "revealed" }))
    expect(renderer.queryByTestId(tid.initialPositionAurora)).toBeNull()
  })

  it("keeps fixed overlay geometry, token colors, reduced-motion static paint, and a 100ms fade", () => {
    expect(styles).toMatch(/height:\s*3\.5rem/)
    expect(styles).toMatch(/position:\s*absolute/)
    expect(styles).toMatch(/pointer-events:\s*none/)
    expect(styles).toMatch(/transition:\s*opacity 100ms var\(--ease-out\)/)
    expect(styles).toContain("var(--ring)")
    expect(styles).toContain("var(--primary)")
    expect(styles).toContain(":global(.dark) .visible")
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.drift,[\s\S]*?\.peaks,[\s\S]*?\.haze[\s\S]*?animation:\s*none/,
    )
    expect(styles).not.toMatch(/#[\da-f]{3,8}\b/i)
    expect(styles).not.toMatch(/oklch\(/)
  })
})
