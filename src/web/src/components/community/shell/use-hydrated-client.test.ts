import { createElement } from "react"
import { renderToString } from "react-dom/server"
// @ts-expect-error react-test-renderer intentionally has no local declaration package.
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it } from "vitest"
import { useHydratedClient } from "./use-hydrated-client"

function Probe() {
  return createElement("probe", { "data-hydrated": String(useHydratedClient()) })
}

describe("useHydratedClient", () => {
  it("keeps the server snapshot on the SSR side of hydration", () => {
    expect(renderToString(createElement(Probe))).toContain('data-hydrated="false"')
  })

  it("exposes browser-only state after the client render", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe))
    })
    expect(renderer.root.findByType("probe").props["data-hydrated"]).toBe("true")
  })
})
