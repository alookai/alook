import { describe, it, expect, vi } from "vitest"
import React from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { act, fireEvent, render as rtlRender } from "@/test/react-dom-harness"

// Mock the Select shell to a passthrough that records the current value and exposes an onValueChange
// hook the test can drive, and render SelectItem children as plain nodes so we
// can assert which options exist.
const selectCalls: Array<{
  value: string
  onValueChange: (v: string | null) => void
  onOpenChange?: (open: boolean) => void
  items?: Array<{ value: string; label: string }>
}> = []
vi.mock("@/components/ui/select", () => {
  const React = require("react")
  return {
    Select: ({ value, onValueChange, onOpenChange, items, children }: any) => {
      selectCalls.push({
        value,
        onValueChange: (next) => onValueChange(next, { reason: "item-press", cancel: vi.fn() }),
        onOpenChange,
        items,
      })
      return React.createElement("div", { "data-mock": "select", "data-value": value }, children)
    },
    SelectTrigger: ({ children, ...props }: any) =>
      React.createElement("button", { "data-mock": "trigger", ...props }, children),
    SelectValue: ({ placeholder }: any) =>
      React.createElement("span", { "data-mock": "value" }, placeholder),
    SelectContent: ({ children, ...props }: any) =>
      React.createElement("div", { "data-mock": "content", ...props }, children),
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
import type { CommunityMachineRuntime } from "@alook/shared"

function itemValues(renderer: ReturnType<typeof rtlRender>): string[] {
  return [...renderer.container.querySelectorAll('[data-mock="item"]')]
    .map((node) => node.getAttribute("data-value")!)
}

function itemText(renderer: ReturnType<typeof rtlRender>, value: string): string {
  return renderer.container.querySelector(
    `[data-mock="item"][data-value="${CSS.escape(value)}"]`,
  )?.textContent ?? ""
}

function render(props: {
  runtime: Pick<CommunityMachineRuntime, "id" | "reasoning"> | null
  value: string | null
  onChange?: (v: string | null) => void
}) {
  return rtlRender(React.createElement(ModelField, { onChange: vi.fn(), ...props }))
}

describe("ModelField", () => {
  const runtime = (id: string, models: string[]) => ({
    id,
    reasoning: {
      updateMode: "unsupported" as const,
      models: models.map((modelId) => ({ id: modelId, supportedReasoningEfforts: [] })),
    },
  })

  const labeledRuntime = (models: Array<{ id: string; displayName?: string }>) => ({
    id: "cursor",
    reasoning: {
      updateMode: "unsupported" as const,
      models: models.map((model) => ({ ...model, supportedReasoningEfforts: [] })),
    },
  })

  it("renders exactly Default + aliases + Custom… for Claude's reported catalog", () => {
    const values = itemValues(render({
      runtime: runtime("claude", ["opus", "sonnet", "haiku"]),
      value: null,
    }))
    expect(values).toEqual(["__default__", "__custom__", "opus", "sonnet", "haiku"])
    expect(values.some((value) => value.startsWith("claude-"))).toBe(false)
  })

  it("renders only Default + Custom… when the selected runtime has no catalog", () => {
    const renderer = render({ runtime: { id: "cursor" }, value: null })
    const values = itemValues(renderer)
    expect(values).toEqual(["__default__", "__custom__"])
    expect(renderer.queryAllByTestId("bot-model-filter-input")).toHaveLength(0)
    expect(renderer.queryAllByTestId("bot-model-probe-results")).toHaveLength(0)
    expect(renderer.container.querySelectorAll('[data-mock="separator"]')).toHaveLength(0)
  })

  it("does not let reported IDs collide with picker sentinels", () => {
    expect(itemValues(render({
      runtime: runtime("cursor", ["__default__", "real-model", "__custom__"]),
      value: null,
    }))).toEqual(["__default__", "__custom__", "real-model"])
  })

  it("switches strictly between same-runtime catalogs from different machines", () => {
    const first = runtime("codex", ["machine-a-model"])
    const second = runtime("codex", ["machine-b-model"])
    const renderer = render({ runtime: first, value: null })
    expect(itemValues(renderer)).toEqual(["__default__", "__custom__", "machine-a-model"])
    act(() => renderer.rerender(React.createElement(ModelField, {
      runtime: second,
      value: null,
      onChange: vi.fn(),
    })))
    expect(itemValues(renderer)).toEqual(["__default__", "__custom__", "machine-b-model"])
  })

  it("reclassifies an unchanged stored value when the machine snapshot changes", () => {
    selectCalls.length = 0
    const renderer = render({ runtime: runtime("codex", ["machine-a-model"]), value: "machine-a-model" })
    expect(selectCalls.at(-1)?.value).toBe("machine-a-model")

    act(() => renderer.rerender(React.createElement(ModelField, {
      runtime: runtime("codex", ["machine-b-model"]),
      value: "machine-a-model",
      onChange: vi.fn(),
    })))
    expect(selectCalls.at(-1)?.value).toBe("__custom__")
    expect(renderer.getByTestId("bot-model-custom-input")).toHaveValue("machine-a-model")
  })

  it("preserves an absent stored model as Custom… with a prefilled input", () => {
    const renderer = render({ runtime: runtime("codex", ["observed"]), value: "stored-old" })
    expect(selectCalls.at(-1)?.value).toBe("__custom__")
    expect(renderer.getByTestId("bot-model-custom-input")).toHaveValue("stored-old")
  })

  it("selecting a catalog entry emits that id; selecting Default emits null", () => {
    const onChange = vi.fn()
    selectCalls.length = 0
    render({ runtime: runtime("claude", ["opus", "sonnet", "haiku"]), value: null, onChange })
    const latest = selectCalls.at(-1)!
    act(() => latest.onValueChange("opus"))
    expect(onChange).toHaveBeenLastCalledWith("opus")
    act(() => selectCalls.at(-1)!.onValueChange("__default__"))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it("keeps same-name ACP values distinct in rows, trigger labels, filtering, and onChange", () => {
    const high = "grok-4.6[effort=high,fast=true]"
    const max = "grok-4.6[effort=max,fast=true]"
    const onChange = vi.fn()
    selectCalls.length = 0
    const renderer = render({
      runtime: labeledRuntime([
        { id: high, displayName: "grok-4.6" },
        { id: max, displayName: "grok-4.6" },
      ]),
      value: high,
      onChange,
    })

    expect(itemValues(renderer)).toEqual(["__default__", "__custom__", high, max])
    expect(itemText(renderer, high)).toContain("grok-4.6")
    expect(itemText(renderer, high)).toContain(high)
    expect(itemText(renderer, max)).toContain(max)
    expect(selectCalls.at(-1)?.items).toEqual(expect.arrayContaining([
      { value: high, label: `${high} — grok-4.6` },
      { value: max, label: `${max} — grok-4.6` },
    ]))

    act(() => selectCalls.at(-1)!.onValueChange(max))
    expect(onChange).toHaveBeenLastCalledWith(max)
    act(() => selectCalls.at(-1)!.onValueChange(high))
    expect(onChange).toHaveBeenLastCalledWith(high)

    const filter = renderer.getByTestId("bot-model-filter-input")
    fireEvent.change(filter, { target: { value: "EFFORT=MAX" } })
    expect(itemValues(renderer)).toEqual(["__default__", "__custom__", max])
    fireEvent.change(filter, { target: { value: "GROK-4.6" } })
    expect(itemValues(renderer)).toEqual(["__default__", "__custom__", high, max])
  })

  it("Custom… reveals the input; typing emits the raw string; clearing emits null", () => {
    const onChange = vi.fn()
    selectCalls.length = 0
    const renderer = render({ runtime: runtime("claude", ["opus", "sonnet", "haiku"]), value: null, onChange })
    // No custom input until Custom… is chosen.
    expect(renderer.queryAllByTestId("bot-model-custom-input")).toHaveLength(0)
    act(() => selectCalls.at(-1)!.onValueChange("__custom__"))
    const input = renderer.getByTestId("bot-model-custom-input")
    fireEvent.change(input, { target: { value: "my-ft" } })
    expect(onChange).toHaveBeenLastCalledWith("my-ft")
    fireEvent.change(input, { target: { value: "" } })
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it("preserves Custom through controlled value echoes and re-seeds external changes", () => {
    const first = runtime("opencode", ["provider/tail"])
    const second = runtime("opencode", ["provider/other"])
    const values: Array<string | null> = []
    function Controlled({ selectedRuntime }: { selectedRuntime: typeof first }) {
      const [value, setValue] = useAtom(useCreateAtom<string | null>("provider/tail"))
      return React.createElement(React.Fragment, {},
        React.createElement(ModelField, { runtime: selectedRuntime, value, onChange: (next) => { values.push(next); setValue(next) } }),
        React.createElement("button", { onClick: () => setValue("external/model") }, "External model"),
      )
    }
    const renderer = rtlRender(React.createElement(Controlled, { selectedRuntime: first }))
    act(() => selectCalls.at(-1)!.onValueChange("__custom__"))
    expect(renderer.getByTestId("bot-model-custom-input")).toHaveValue("")
    expect(values.at(-1)).toBeNull()
    fireEvent.change(renderer.getByTestId("bot-model-custom-input"), { target: { value: "custom/model" } })
    expect(values.at(-1)).toBe("custom/model")
    fireEvent.change(renderer.getByTestId("bot-model-custom-input"), { target: { value: "" } })
    expect(renderer.getByTestId("bot-model-custom-input")).toHaveValue("")
    expect(values.at(-1)).toBeNull()
    act(() => renderer.rerender(React.createElement(Controlled, { selectedRuntime: second })))
    expect(renderer.queryAllByTestId("bot-model-custom-input")).toHaveLength(0)
    fireEvent.click(renderer.getByText("External model"))
    expect(renderer.getByTestId("bot-model-custom-input")).toHaveValue("external/model")
    act(() => selectCalls.at(-1)!.onValueChange("__default__"))
    expect(renderer.queryAllByTestId("bot-model-custom-input")).toHaveLength(0)
    expect(values.at(-1)).toBeNull()
  })

  it("filters a 204-item catalog by case-insensitive substring while keeping Default and Custom", () => {
    const models = Array.from({ length: 204 }, (_, index) => `Cursor-MODEL-${index}`)
    const renderer = render({ runtime: runtime("cursor", models), value: null })
    const filter = renderer.getByTestId("bot-model-filter-input")

    fireEvent.change(filter, { target: { value: "mOdEl-20" } })

    expect(itemValues(renderer)).toEqual([
      "__default__",
      "__custom__",
      "Cursor-MODEL-20",
      "Cursor-MODEL-200",
      "Cursor-MODEL-201",
      "Cursor-MODEL-202",
      "Cursor-MODEL-203",
    ])
  })

  it("shows all 598 OpenCode models, selects the catalog tail, and keeps Custom usable after no match", () => {
    const models = Array.from({ length: 598 }, (_, index) => `provider/model-${index}`)
    const onChange = vi.fn()
    const renderer = render({ runtime: runtime("opencode", models), value: null, onChange })
    expect(itemValues(renderer)).toEqual(["__custom__", ...models])
    const filter = renderer.getByTestId("bot-model-filter-input")

    fireEvent.change(filter, { target: { value: "model-597" } })
    expect(itemValues(renderer)).toEqual(["__custom__", models[597]])
    act(() => selectCalls.at(-1)!.onValueChange(models[597]))
    expect(onChange).toHaveBeenLastCalledWith(models[597])

    fireEvent.change(filter, { target: { value: "not-in-catalog" } })

    expect(itemValues(renderer)).toEqual(["__custom__"])
    expect(renderer.getByRole("status")).toHaveTextContent("No matching models")
  })

  it("clears the filter when the list closes", () => {
    selectCalls.length = 0
    const renderer = render({ runtime: runtime("codex", ["gpt-one", "gpt-two"]), value: null })
    const filter = renderer.getByTestId("bot-model-filter-input")
    fireEvent.change(filter, { target: { value: "two" } })
    expect(itemValues(renderer)).toEqual(["__default__", "__custom__", "gpt-two"])

    act(() => selectCalls.at(-1)?.onOpenChange?.(false))
    expect(renderer.getByTestId("bot-model-filter-input")).toHaveValue("")
    expect(itemValues(renderer)).toEqual(["__default__", "__custom__", "gpt-one", "gpt-two"])
  })

  it("clears the filter and never leaks results when switching same-runtime machines", () => {
    const renderer = render({
      runtime: runtime("codex", ["machine-a-one", "machine-a-two"]),
      value: null,
    })
    const filter = renderer.getByTestId("bot-model-filter-input")
    fireEvent.change(filter, { target: { value: "two" } })
    expect(itemValues(renderer)).toEqual(["__default__", "__custom__", "machine-a-two"])

    act(() => renderer.rerender(React.createElement(ModelField, {
      runtime: runtime("codex", ["machine-b-three"]),
      value: null,
      onChange: vi.fn(),
    })))
    expect(renderer.getByTestId("bot-model-filter-input")).toHaveValue("")
    expect(itemValues(renderer)).toEqual(["__default__", "__custom__", "machine-b-three"])
  })

  it("supports immediate mobile/keyboard filtering without swallowing list navigation keys", () => {
    const renderer = render({ runtime: runtime("cursor", ["one", "two"]), value: null })
    const filter = renderer.getByTestId("bot-model-filter-input") as HTMLInputElement
    expect(filter).toHaveFocus()
    expect(filter.className).toContain("h-10")
    expect(filter.className).toContain("sm:h-8")
    const content = renderer.container.querySelector<HTMLElement>('[data-mock="content"]')!
    expect(content.className).toContain("overflow-y-hidden")
    const controls = renderer.getByTestId("bot-model-fixed-controls")
    expect(controls.className).toContain("shrink-0")
    const results = renderer.getByTestId("bot-model-probe-results")
    expect(results.className).toContain("max-h-[min(18rem,50dvh)]")
    expect(results.className).toContain("overflow-y-auto")
    expect(results.className).toContain("thin-scrollbar")

    const printable = new KeyboardEvent("keydown", { key: "o", bubbles: true })
    const printableStop = vi.spyOn(printable, "stopPropagation")
    fireEvent(filter, printable)
    expect(printableStop).toHaveBeenCalledOnce()

    const navigation = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
    const navigationStop = vi.spyOn(navigation, "stopPropagation")
    fireEvent(filter, navigation)
    expect(navigationStop).not.toHaveBeenCalled()

    const highlighted = { click: vi.fn() }
    filter.closest = vi.fn(() => ({ querySelector: vi.fn(() => highlighted) })) as never
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    const preventDefault = vi.spyOn(enter, "preventDefault")
    const stopPropagation = vi.spyOn(enter, "stopPropagation")
    fireEvent(filter, enter)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(highlighted.click).toHaveBeenCalledOnce()
  })

  it("uses exact Antigravity native IDs and labels from the machine catalog", () => {
    const onChange = vi.fn()
    const renderer = render({
      runtime: {
        id: "antigravity",
        reasoning: {
          updateMode: "live_next_turn",
          defaultModelId: "gemini-3.1-pro-high",
          models: [{
            id: "gemini-3.1-pro-high",
            displayName: "Gemini 3.1 Pro (High)",
            supportedReasoningEfforts: [{ value: "high" }, { value: "low" }],
          }, {
            id: "claude-sonnet-4-6",
            displayName: "Claude Sonnet 4.6",
            supportedReasoningEfforts: [],
          }],
        },
      },
      value: null,
      onChange,
    })
    expect(itemValues(renderer)).toEqual([
      "__default__", "__custom__", "gemini-3.1-pro-high", "claude-sonnet-4-6",
    ])
    expect(itemText(renderer, "gemini-3.1-pro-high")).toContain("Gemini 3.1 Pro (High)")
    expect(onChange).not.toHaveBeenCalled()
    act(() => selectCalls.at(-1)!.onValueChange("gemini-3.1-pro-high"))
    expect(onChange).toHaveBeenLastCalledWith("gemini-3.1-pro-high")
    act(() => selectCalls.at(-1)!.onValueChange("__default__"))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })
})
