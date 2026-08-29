import { describe, it, expect, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"

// The Select is a base-ui component that portals its content into `document`,
// unavailable under this repo's node vitest env. Mock the Select shell to a
// passthrough that (a) records the current value and (b) exposes an onValueChange
// hook the test can drive, and render SelectItem children as plain nodes so we
// can assert which options exist.
const selectCalls: Array<{
  value: string
  onValueChange: (v: string | null) => void
  onOpenChange?: (open: boolean) => void
}> = []
vi.mock("@/components/ui/select", () => {
  const React = require("react")
  return {
    Select: ({ value, onValueChange, onOpenChange, children }: any) => {
      selectCalls.push({ value, onValueChange, onOpenChange })
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

function itemValues(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll((n) => n.props?.["data-mock"] === "item")
    .map((n) => n.props["data-value"] as string)
}

function render(props: {
  runtime: Pick<CommunityMachineRuntime, "id" | "reasoning"> | null
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
  const runtime = (id: string, models: string[]) => ({
    id,
    reasoning: {
      updateMode: "unsupported" as const,
      models: models.map((modelId) => ({ id: modelId, supportedReasoningEfforts: [] })),
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
    expect(renderer.root.findAllByProps({ "data-testid": "bot-model-filter-input" })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ "data-testid": "bot-model-probe-results" })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ "data-mock": "separator" })).toHaveLength(0)
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
    act(() => renderer.update(React.createElement(ModelField, {
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

    act(() => renderer.update(React.createElement(ModelField, {
      runtime: runtime("codex", ["machine-b-model"]),
      value: "machine-a-model",
      onChange: vi.fn(),
    })))
    expect(selectCalls.at(-1)?.value).toBe("__custom__")
    expect(renderer.root.findByProps({ "data-testid": "bot-model-custom-input" }).props.value)
      .toBe("machine-a-model")
  })

  it("preserves an absent stored model as Custom… with a prefilled input", () => {
    const renderer = render({ runtime: runtime("codex", ["observed"]), value: "stored-old" })
    expect(selectCalls.at(-1)?.value).toBe("__custom__")
    expect(renderer.root.findByProps({ "data-testid": "bot-model-custom-input" }).props.value)
      .toBe("stored-old")
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

  it("Custom… reveals the input; typing emits the raw string; clearing emits null", () => {
    const onChange = vi.fn()
    selectCalls.length = 0
    const renderer = render({ runtime: runtime("claude", ["opus", "sonnet", "haiku"]), value: null, onChange })
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

  it("filters a 204-item catalog by case-insensitive substring while keeping Default and Custom", () => {
    const models = Array.from({ length: 204 }, (_, index) => `Cursor-MODEL-${index}`)
    const renderer = render({ runtime: runtime("cursor", models), value: null })
    const filter = renderer.root.findByProps({ "data-testid": "bot-model-filter-input" })

    act(() => filter.props.onChange({ target: { value: "mOdEl-20" } }))

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

  it("shows an explicit no-match state for a 479-item catalog and keeps Custom usable", () => {
    const models = Array.from({ length: 479 }, (_, index) => `provider/model-${index}`)
    const renderer = render({ runtime: runtime("opencode", models), value: null })
    const filter = renderer.root.findByProps({ "data-testid": "bot-model-filter-input" })

    act(() => filter.props.onChange({ target: { value: "not-in-catalog" } }))

    expect(itemValues(renderer)).toEqual(["__default__", "__custom__"])
    expect(renderer.root.findByProps({ role: "status" }).children).toEqual(["No matching models"])
  })

  it("clears the filter when the list closes", () => {
    selectCalls.length = 0
    const renderer = render({ runtime: runtime("codex", ["gpt-one", "gpt-two"]), value: null })
    const filter = renderer.root.findByProps({ "data-testid": "bot-model-filter-input" })
    act(() => filter.props.onChange({ target: { value: "two" } }))
    expect(itemValues(renderer)).toEqual(["__default__", "__custom__", "gpt-two"])

    act(() => selectCalls.at(-1)?.onOpenChange?.(false))
    expect(renderer.root.findByProps({ "data-testid": "bot-model-filter-input" }).props.value).toBe("")
    expect(itemValues(renderer)).toEqual(["__default__", "__custom__", "gpt-one", "gpt-two"])
  })

  it("clears the filter and never leaks results when switching same-runtime machines", () => {
    const renderer = render({
      runtime: runtime("codex", ["machine-a-one", "machine-a-two"]),
      value: null,
    })
    const filter = renderer.root.findByProps({ "data-testid": "bot-model-filter-input" })
    act(() => filter.props.onChange({ target: { value: "two" } }))
    expect(itemValues(renderer)).toEqual(["__default__", "__custom__", "machine-a-two"])

    act(() => renderer.update(React.createElement(ModelField, {
      runtime: runtime("codex", ["machine-b-three"]),
      value: null,
      onChange: vi.fn(),
    })))
    expect(renderer.root.findByProps({ "data-testid": "bot-model-filter-input" }).props.value).toBe("")
    expect(itemValues(renderer)).toEqual(["__default__", "__custom__", "machine-b-three"])
  })

  it("supports immediate mobile/keyboard filtering without swallowing list navigation keys", () => {
    const renderer = render({ runtime: runtime("cursor", ["one", "two"]), value: null })
    const filter = renderer.root.findByProps({ "data-testid": "bot-model-filter-input" })
    expect(filter.props.autoFocus).toBe(true)
    expect(filter.props.className).toContain("h-10")
    expect(filter.props.className).toContain("sm:h-8")
    const content = renderer.root.findByProps({ "data-mock": "content" })
    expect(content.props.className).toContain("overflow-y-hidden")
    const controls = renderer.root.findByProps({ "data-testid": "bot-model-fixed-controls" })
    expect(controls.props.className).toContain("shrink-0")
    const results = renderer.root.findByProps({ "data-testid": "bot-model-probe-results" })
    expect(results.props.className).toContain("max-h-[min(18rem,50dvh)]")
    expect(results.props.className).toContain("overflow-y-auto")
    expect(results.props.className).toContain("thin-scrollbar")

    const printable = { key: "o", stopPropagation: vi.fn() }
    filter.props.onKeyDown(printable)
    expect(printable.stopPropagation).toHaveBeenCalledOnce()

    const navigation = { key: "ArrowDown", stopPropagation: vi.fn() }
    filter.props.onKeyDown(navigation)
    expect(navigation.stopPropagation).not.toHaveBeenCalled()

    const highlighted = { click: vi.fn() }
    const enter = {
      key: "Enter",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: {
        closest: vi.fn(() => ({ querySelector: vi.fn(() => highlighted) })),
      },
    }
    filter.props.onKeyDown(enter)
    expect(enter.preventDefault).toHaveBeenCalledOnce()
    expect(enter.stopPropagation).toHaveBeenCalledOnce()
    expect(highlighted.click).toHaveBeenCalledOnce()
  })
})
