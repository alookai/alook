import { useEffect } from "react"
import { describe, expect, it } from "vitest"
import { render, screen } from "./react-dom-harness"

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
let cleanupCount = 0

function EffectFixture() {
  useEffect(() => () => {
    cleanupCount += 1
  }, [])
  return <main>Harness fixture</main>
}

describe.sequential("react-dom harness lifecycle", () => {
  it("enables the React act environment while rendering", () => {
    expect(reactActEnvironment.IS_REACT_ACT_ENVIRONMENT).toBe(true)
    render(<EffectFixture />)
    expect(screen.getByRole("main")).toHaveTextContent("Harness fixture")
    expect(cleanupCount).toBe(0)
  })

  it("auto-cleans the prior tree exactly once before the next test", () => {
    expect(reactActEnvironment.IS_REACT_ACT_ENVIRONMENT).toBe(true)
    expect(cleanupCount).toBe(1)
    expect(document.body).toBeEmptyDOMElement()
  })
})
