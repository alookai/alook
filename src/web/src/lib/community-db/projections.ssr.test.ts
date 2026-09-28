import React from "react"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { useServerTreeProjection } from "./projections"

describe("community DB projection server snapshot", () => {
  it("is unresolved without a registry during server rendering", () => {
    function Probe() {
      return React.createElement("span", null, String(useServerTreeProjection("s1")))
    }

    expect(renderToString(React.createElement(Probe))).toContain("undefined")
  })
})
