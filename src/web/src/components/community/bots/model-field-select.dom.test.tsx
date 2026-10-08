import React from "react"
import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@/test/react-dom-harness"
import { ModelField } from "./model-field"

const runtime = {
  id: "antigravity",
  reasoning: {
    updateMode: "live_next_turn" as const,
    defaultModelId: "gemini-3.1-pro-high",
    models: ["gemini-3.1-pro-high", "gemini-3.1-pro-low"].map((id) => ({
      id,
      supportedReasoningEfforts: [{ value: "high" }, { value: "low" }],
    })),
  },
}

describe("ModelField with the real Select", () => {
  it("filters an edited model without changing its selection", async () => {
    const onChange = vi.fn()
    render(<ModelField runtime={runtime} value="gemini-3.1-pro-high" onChange={onChange} />)
    expect(screen.getByTestId("bot-model-select")).toHaveTextContent("gemini-3.1-pro-high")
    await act(async () => { fireEvent.click(screen.getByTestId("bot-model-select")) })
    const filter = screen.getByTestId("bot-model-filter-input")
    await act(async () => { fireEvent.change(filter, { target: { value: "gemini-3.1-pro-low" } }) })
    expect(filter).toHaveValue("gemini-3.1-pro-low")
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByTestId("bot-model-select")).toHaveTextContent("gemini-3.1-pro-high")
    expect(screen.getByTestId("bot-model-probe-results").querySelectorAll('[role="option"]')).toHaveLength(1)
    await act(async () => { fireEvent.click(screen.getByRole("option", { name: "gemini-3.1-pro-low" })) })
    expect(onChange).toHaveBeenLastCalledWith("gemini-3.1-pro-low")
  })

  it("keeps explicit Default selectable while the current model is filtered out", async () => {
    const onChange = vi.fn()
    render(<ModelField runtime={runtime} value="gemini-3.1-pro-high" onChange={onChange} />)
    await act(async () => { fireEvent.click(screen.getByTestId("bot-model-select")) })
    const filter = screen.getByTestId("bot-model-filter-input")
    await act(async () => { fireEvent.change(filter, { target: { value: "no-match" } }) })
    expect(filter).toHaveValue("no-match")
    expect(screen.getByRole("status")).toHaveTextContent("No matching models")
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByTestId("bot-model-select")).toHaveTextContent("gemini-3.1-pro-high")
    const option = screen.getByRole("option", { name: "Default (antigravity's own default)" })
    await act(async () => { fireEvent.pointerDown(option, { pointerType: "mouse" }) })
    await act(async () => { fireEvent.click(option) })
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it("preserves a model chosen after opening a create form with Default", async () => {
    const onChange = vi.fn()
    function CreateModel() {
      const [value, setValue] = React.useState<string | null>(null)
      return <ModelField runtime={runtime} value={value} onChange={(next) => {
        setValue(next)
        onChange(next)
      }} />
    }
    render(<CreateModel />)
    await act(async () => { fireEvent.click(screen.getByTestId("bot-model-select")) })
    const high = screen.getByRole("option", { name: "gemini-3.1-pro-high" })
    await act(async () => { fireEvent.pointerDown(high, { pointerType: "mouse" }) })
    await act(async () => { fireEvent.click(high) })
    expect(onChange).toHaveBeenLastCalledWith("gemini-3.1-pro-high")
    onChange.mockClear()
    await act(async () => { fireEvent.click(screen.getByTestId("bot-model-select")) })
    const filter = screen.getByTestId("bot-model-filter-input")
    await act(async () => { fireEvent.change(filter, { target: { value: "gemini-3.1-pro-low" } }) })
    expect(filter).toHaveValue("gemini-3.1-pro-low")
    expect(screen.getByTestId("bot-model-select")).toHaveTextContent("gemini-3.1-pro-high")
    expect(onChange).not.toHaveBeenCalled()
  })

})
