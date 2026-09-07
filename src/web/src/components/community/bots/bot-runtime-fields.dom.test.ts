import { describe, expect, it, vi } from "vitest"
import React from "react"
import { fireEvent, render, screen } from "@/test/react-dom-harness"

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

vi.mock("./reasoning-effort-field", () => ({
  ReasoningEffortField: ({ daemonVersion }: {
    daemonVersion?: string
  }) => React.createElement("div", {
    "data-testid": "reasoning-effort-field",
    "data-daemon-version": daemonVersion,
  }),
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
  const renderer = render(React.createElement(BotRuntimeFields, {
    options: OPTIONS,
    runtime: "claude",
    model: "claude-sonnet-4-6",
    reasoningEffort: "high",
    onRuntimeChange,
    onModelChange,
    onReasoningEffortChange,
    ...overrides,
  }))
  return { renderer, onRuntimeChange, onModelChange, onReasoningEffortChange }
}

function radio(renderer: ReturnType<typeof render>, value: string) {
  return renderer.container.querySelector<HTMLInputElement>(`input[value="${value}"]`)!
}

describe("BotRuntimeFields", () => {
  it("keeps the selected unhealthy runtime enabled and disables other unhealthy options", () => {
    const { renderer } = renderFields()
    expect(radio(renderer, "claude")).toBeEnabled()
    expect(radio(renderer, "codex")).toBeEnabled()
    expect(radio(renderer, "cursor")).toBeDisabled()
  })

  it("changes runtime and clears the previous provider model together", () => {
    const { renderer, onRuntimeChange, onModelChange, onReasoningEffortChange } = renderFields()
    fireEvent.click(radio(renderer, "codex"))
    expect(onRuntimeChange).toHaveBeenCalledWith("codex")
    expect(onModelChange).toHaveBeenCalledWith(null)
    expect(onReasoningEffortChange).toHaveBeenCalledWith(null)
  })

  it("does not clear the model when the selected runtime is chosen again", () => {
    const { renderer, onRuntimeChange, onModelChange } = renderFields()
    fireEvent.click(radio(renderer, "claude"))
    expect(onRuntimeChange).not.toHaveBeenCalled()
    expect(onModelChange).not.toHaveBeenCalled()
  })

  it("exposes optional motion targets without changing the form contract", () => {
    const { renderer } = renderFields({
      motionTargetPrefix: "runtime",
      modelMotionTarget: "model",
    })
    expect(
      renderer.container.querySelector('[data-motion-target="runtime-codex"]'),
    ).toBeInTheDocument()
    expect(
      renderer.container.querySelector('[data-motion-target="model"]'),
    ).toBeInTheDocument()
    expect(radio(renderer, "codex")).toHaveAttribute("name", "edit-bot-runtime")
  })

  it("forwards only the selected daemon version to reasoning effort", () => {
    renderFields({ daemonVersion: "0.1.24" })
    expect(screen.getByTestId("reasoning-effort-field"))
      .toHaveAttribute("data-daemon-version", "0.1.24")
  })
})
