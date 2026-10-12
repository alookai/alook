import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { render, screen } from "./react-dom-harness"

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
let cleanupCount = 0
const lifecycleOrder: string[] = []

beforeEach(() => () => {
  expect(reactActEnvironment.IS_REACT_ACT_ENVIRONMENT).toBe(true)
  expect(document.body).toBeEmptyDOMElement()
  expect(cleanupCount).toBe(1)
  if (lifecycleOrder.length > 0) {
    lifecycleOrder.push("owner")
    expect(lifecycleOrder).toEqual(["child", "unmount", "owner"])
    lifecycleOrder.length = 0
  }
})

function EffectFixture() {
  useEffect(() => () => {
    cleanupCount += 1
  }, [])
  return <main>Harness fixture</main>
}

function NestedEffectFixture() {
  useEffect(() => () => {
    lifecycleOrder.push("unmount")
  }, [])
  return <main>Nested fixture</main>
}

describe("react-dom harness lifecycle", { concurrent: false }, () => {
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

  describe("native nested suite traversal", { concurrent: false }, () => {
    afterEach(() => {
      expect(screen.getByRole("main")).toHaveTextContent("Nested fixture")
      expect(lifecycleOrder).toEqual([])
      lifecycleOrder.push("child")
    })

    it("runs the child hook, native unmount and returned file owner in order", () => {
      render(<NestedEffectFixture />)
      expect(screen.getByRole("main")).toHaveTextContent("Nested fixture")
      expect(lifecycleOrder).toEqual([])
    })
  })
})
