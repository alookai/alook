import React from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@/test/react-dom-harness"
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
  }) => React.createElement("select", {
    disabled,
    value,
    "data-items": JSON.stringify(items),
    onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onValueChange?.(event.target.value),
  }, children),
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
  const renderer = render(React.createElement(ReasoningEffortField, {
    runtime: RUNTIME,
    model: "gpt-5",
    daemonVersion: "0.1.25",
    value: null,
    onChange,
    ...props,
  }))
  return { renderer, onChange }
}

describe("ReasoningEffortField", () => {
  it("shows exact Default without claiming the catalog default or changing storage", () => {
    const { renderer, onChange } = renderField()
    const select = renderer.container.querySelector("select")!
    expect(select).toBeEnabled()
    expect(JSON.parse(select.dataset.items!)).toEqual([
      { value: "__default__", label: "Default" },
      { value: "minimal", label: "Minimal" },
      { value: "future_level", label: "Future_level" },
    ])
    expect([...renderer.container.querySelectorAll("option")].map((node) => node.value)).toEqual([
      "__default__",
      "minimal",
      "future_level",
    ])
    expect(screen.getByText("Default sends no override. Your runtime or user configuration stays in control."))
      .toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it("keeps genuine current-daemon unavailability distinct from upgrade guidance", () => {
    const { renderer } = renderField({ runtime: { reasoning: undefined } })
    expect(renderer.container.querySelector("select")).toBeDisabled()
    expect(screen.getByText("This runtime/model does not report reasoning effort options."))
      .toBeInTheDocument()
  })

  it("preserves an explicit effort when an old daemon has no catalog evidence", () => {
    const { renderer, onChange } = renderField({
      runtime: { reasoning: undefined },
      daemonVersion: "0.1.24",
      value: "low",
    })
    expect(JSON.parse(renderer.container.querySelector("select")!.dataset.items!)).toEqual([
      { value: "__default__", label: "Default" },
      { value: "low", label: "Low" },
    ])
    expect(onChange).not.toHaveBeenCalled()
  })

  it("shows only the Machines guidance when an old daemon has no catalog", () => {
    const { renderer } = renderField({
      runtime: { reasoning: undefined },
      daemonVersion: "0.1.24",
    })
    expect(screen.getByText("Check the daemon version in Machines, then update and restart it there."))
      .toBeInTheDocument()
    expect(renderer.container.querySelectorAll("code")).toHaveLength(0)
    expect(screen.queryByRole("button", { name: "Update daemon…" })).not.toBeInTheDocument()
    expect(screen.queryByTestId("machine-update-confirm")).not.toBeInTheDocument()
  })

  it("resets an incompatible selected value to Default", () => {
    const { onChange } = renderField({ value: "ultra" })
    expect(onChange).toHaveBeenCalledWith(null)
  })
})
