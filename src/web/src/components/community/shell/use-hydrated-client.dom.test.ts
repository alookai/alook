import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { render, screen } from "@/test/react-dom-harness"
import { useHydratedClient } from "./use-hydrated-client"

function Probe() {
  return createElement("div", {
    "data-testid": "hydrated-probe",
    "data-hydrated": String(useHydratedClient()),
  })
}

describe("useHydratedClient", () => {
  it("keeps the server snapshot on the SSR side of hydration", () => {
    expect(renderToString(createElement(Probe))).toContain('data-hydrated="false"')
  })

  it("exposes browser-only state after the client render", () => {
    render(createElement(Probe))
    expect(screen.getByTestId("hydrated-probe")).toHaveAttribute("data-hydrated", "true")
  })
})
