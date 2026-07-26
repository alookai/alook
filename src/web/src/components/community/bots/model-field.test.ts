import { describe, it, expect, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"

// The Select is a base-ui component that portals its content into `document`,
// unavailable under this repo's node vitest env. Mock the Select shell to a
// passthrough that (a) records the current value and (b) exposes an onValueChange
// hook the test can drive, and render SelectItem children as plain nodes so we
// can assert which options exist.
const selectCalls: Array<{ value: string; onValueChange: (v: string | null) => void }> = []
vi.mock("@/components/ui/select", () => {
  const React = require("react")
  return {
    Select: ({ value, onValueChange, children }: any) => {
      selectCalls.push({ value, onValueChange })
      return React.createElement("div", { "data-mock": "select", "data-value": value }, children)
    },
    SelectTrigger: ({ children, ...props }: any) =>
      React.createElement("button", { "data-mock": "trigger", ...props }, children),
    SelectValue: ({ placeholder }: any) =>
      React.createElement("span", { "data-mock": "value" }, placeholder),
    SelectContent: ({ children }: any) => React.createElement("div", { "data-mock": "content" }, children),
    SelectItem: ({ value, children }: any) =>
      React.createElement("div", { "data-mock": "item", "data-value": value }, children),
    SelectSeparator: () => React.createElement("hr", { "data-mock": "separator" }),
  }
})

vi.mock("@/components/ui/label", () => {
  const React = require("react")
  return { Label: ({ children }: any) => React.createElement("label", {}, children) }
})
vi.mock("@/components/ui/input", () => {
  const React = require("react")
  return { Input: (props: any) => React.createElement("input", props) }
})

import { ModelField } from "./model-field"

function itemValues(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll((n) => n.props?.["data-mock"] === "item")
    .map((n) => n.props["data-value"] as string)
}

function render(props: {
  runtime: string | null
  value: string | null
  onChange?: (v: string | null) => void
}): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(ModelField, { onChange: vi.fn(), ...props }),
    )
  })
  return renderer
}

describe("ModelField", () => {
  it("renders Default + the catalog options + Custom… for claude", () => {
    const renderer = render({ runtime: "claude", value: null })
    const values = itemValues(renderer)
    expect(values).toContain("__default__")
    expect(values).toContain("claude-opus-4-6")
    expect(values).toContain("claude-sonnet-4-6")
    expect(values).toContain("__custom__")
  })

  it("renders only Default + Custom… for gemini (empty catalog)", () => {
    const values = itemValues(render({ runtime: "gemini", value: null }))
    expect(values).toEqual(["__default__", "__custom__"])
  })

  it("renders nothing for antigravity", () => {
    const renderer = render({ runtime: "antigravity", value: null })
    expect(renderer.root.findAll((n) => n.props?.["data-mock"] === "select")).toHaveLength(0)
  })

  it("selecting a catalog entry emits that id; selecting Default emits null", () => {
    const onChange = vi.fn()
    selectCalls.length = 0
    render({ runtime: "claude", value: null, onChange })
    const latest = selectCalls.at(-1)!
    act(() => latest.onValueChange("claude-opus-4-6"))
    expect(onChange).toHaveBeenLastCalledWith("claude-opus-4-6")
    act(() => selectCalls.at(-1)!.onValueChange("__default__"))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it("Custom… reveals the input; typing emits the raw string; clearing emits null", () => {
    const onChange = vi.fn()
    selectCalls.length = 0
    const renderer = render({ runtime: "claude", value: null, onChange })
    // No custom input until Custom… is chosen.
    expect(renderer.root.findAll((n) => n.props?.["data-testid"] === "bot-model-custom-input")).toHaveLength(0)
    act(() => selectCalls.at(-1)!.onValueChange("__custom__"))
    const input = renderer.root.find((n) => n.props?.["data-testid"] === "bot-model-custom-input")
    expect(input).toBeTruthy()
    act(() => input.props.onChange({ target: { value: "my-ft" } }))
    expect(onChange).toHaveBeenLastCalledWith("my-ft")
    act(() => input.props.onChange({ target: { value: "" } }))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })
})
