import { describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"

vi.mock("@/components/provider-logo", () => ({
  ProviderLogo: () => React.createElement("span", { "data-mock": "provider-logo" }),
}))

vi.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("label", null, children),
}))

vi.mock("@/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}))

vi.mock("./model-field", () => ({
  ModelField: ({ runtime, value }: { runtime: { id: string } | null; value: string | null }) =>
    React.createElement("div", { "data-runtime": runtime?.id, "data-model": value }),
}))

import { BotRuntimeFields } from "./bot-runtime-fields"

const OPTIONS = [
  { id: "claude", unhealthy: true },
  { id: "codex", unhealthy: false },
  { id: "cursor", unhealthy: true },
]

function renderFields(overrides: Partial<React.ComponentProps<typeof BotRuntimeFields>> = {}) {
  const onRuntimeChange = vi.fn()
  const onModelChange = vi.fn()
  const onReasoningEffortChange = vi.fn()
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(BotRuntimeFields, {
        options: OPTIONS,
        runtime: "claude",
        model: "claude-sonnet-4-6",
        reasoningEffort: "high",
        onRuntimeChange,
        onModelChange,
        onReasoningEffortChange,
        ...overrides,
      }),
    )
  })
  return { renderer, onRuntimeChange, onModelChange, onReasoningEffortChange }
}

function radio(renderer: TestRenderer.ReactTestRenderer, value: string) {
  return renderer.root.find(
    (node) => node.type === "input" && node.props.value === value,
  )
}

describe("BotRuntimeFields", () => {
  it("keeps the selected unhealthy runtime enabled and disables other unhealthy options", () => {
    const { renderer } = renderFields()
    expect(radio(renderer, "claude").props.disabled).toBe(false)
    expect(radio(renderer, "codex").props.disabled).toBe(false)
    expect(radio(renderer, "cursor").props.disabled).toBe(true)
  })

  it("changes runtime and clears the previous provider model together", () => {
    const { renderer, onRuntimeChange, onModelChange, onReasoningEffortChange } = renderFields()
    act(() => radio(renderer, "codex").props.onChange())
    expect(onRuntimeChange).toHaveBeenCalledWith("codex")
    expect(onModelChange).toHaveBeenCalledWith(null)
    expect(onReasoningEffortChange).toHaveBeenCalledWith(null)
  })

  it("does not clear the model when the selected runtime is chosen again", () => {
    const { renderer, onRuntimeChange, onModelChange } = renderFields()
    act(() => radio(renderer, "claude").props.onChange())
    expect(onRuntimeChange).not.toHaveBeenCalled()
    expect(onModelChange).not.toHaveBeenCalled()
  })

  it("exposes optional motion targets without changing the form contract", () => {
    const { renderer } = renderFields({
      motionTargetPrefix: "runtime",
      modelMotionTarget: "model",
    })
    expect(
      renderer.root.find((node) => node.props["data-motion-target"] === "runtime-codex"),
    ).toBeTruthy()
    expect(
      renderer.root.find((node) => node.props["data-motion-target"] === "model"),
    ).toBeTruthy()
    expect(radio(renderer, "codex").props.name).toBe("edit-bot-runtime")
  })
})
