import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import { ReasoningEffortField } from "./reasoning-effort-field"

vi.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("label", null, children),
}))

vi.mock("@/components/ui/select", () => ({
  Select: ({ children, disabled, items, value, onValueChange }: {
    children?: React.ReactNode
    disabled?: boolean
    items?: unknown[]
    value?: string
    onValueChange?: (value: string | null) => void
  }) => React.createElement("select", { disabled, items, value, onValueChange }, children),
  SelectContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  SelectItem: ({ children, value }: { children?: React.ReactNode; value: string }) =>
    React.createElement("option", { value }, children),
  SelectTrigger: ({ children, ...props }: React.ComponentProps<"button">) =>
    React.createElement("button", props, children),
  SelectValue: ({ placeholder }: { placeholder?: string }) =>
    React.createElement("span", null, placeholder),
}))

const RUNTIME = {
  reasoning: {
    updateMode: "live_next_turn" as const,
    defaultModelId: "gpt-5",
    models: [{
      id: "gpt-5",
      supportedReasoningEfforts: [
        { value: "minimal" },
        { value: "future_level", description: "A future runtime-provided level" },
      ],
      defaultReasoningEffort: "minimal",
    }],
  },
}

function renderField(props: Partial<React.ComponentProps<typeof ReasoningEffortField>> = {}) {
  const onChange = vi.fn()
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(React.createElement(ReasoningEffortField, {
      runtime: RUNTIME,
      model: "gpt-5",
      value: null,
      onChange,
      ...props,
    }))
  })
  return { renderer, onChange }
}

describe("ReasoningEffortField", () => {
  it("shows Default plus the exact runtime-reported options and default", () => {
    const { renderer } = renderField()
    const select = renderer.root.findByType("select")
    expect(select.props.disabled).toBe(false)
    expect(select.props.items).toEqual([
      { value: "__default__", label: "Default (Minimal)" },
      { value: "minimal", label: "Minimal" },
      { value: "future_level", label: "Future_level" },
    ])
    expect(renderer.root.findAllByType("option").map((node) => node.props.value)).toEqual([
      "__default__",
      "minimal",
      "future_level",
    ])
  })

  it("renders disabled Default-only help when no catalog is reported", () => {
    const { renderer } = renderField({ runtime: { reasoning: undefined } })
    expect(renderer.root.findByType("select").props.disabled).toBe(true)
    expect(renderer.root.findAllByType("p")[0]?.children.join("")).toBe(
      "This runtime/model does not report reasoning effort options.",
    )
  })

  it("resets an incompatible selected value to Default", () => {
    const { onChange } = renderField({ value: "ultra" })
    expect(onChange).toHaveBeenCalledWith(null)
  })
})
