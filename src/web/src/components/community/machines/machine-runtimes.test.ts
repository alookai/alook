import { describe, it, expect } from "vitest"
import { Children, isValidElement } from "react"
import { MachineRuntimes } from "./machine-runtimes"

function collectChips(tree: unknown): any[] {
  if (!tree || typeof tree !== "object") return []
  const node = tree as { props?: { children?: unknown } }
  const kids = node.props?.children
  if (!kids) return []
  return Children.toArray(kids as any)
}

/** Instantiate a functional component element so we can walk its render output. */
function renderChip(chipElement: any): any {
  const Fn = chipElement.type as (props: any) => any
  return Fn(chipElement.props)
}

describe("MachineRuntimes", () => {
  it("returns null for an empty runtime list", () => {
    expect(MachineRuntimes({ runtimes: [] })).toBeNull()
  })

  it("renders one chip per runtime", () => {
    const tree = MachineRuntimes({
      runtimes: [
        { id: "claude", version: "1.0.0" },
        { id: "codex" },
      ],
    })
    const chips = collectChips(tree)
    expect(chips).toHaveLength(2)
    // React prefixes user-supplied keys with ".$" via Children.toArray.
    expect(chips[0].key).toBe(".$claude")
    expect(chips[1].key).toBe(".$codex")
  })

  it("without a version, the chip is a plain span (no tooltip wrapper)", () => {
    const tree = MachineRuntimes({ runtimes: [{ id: "codex" }] })
    const chips = collectChips(tree)
    const rendered = renderChip(chips[0])
    // Plain span: children = [ProviderLogo, id span]. No Tooltip wrapper.
    expect(rendered.type).toBe("span")
    const inner = Children.toArray(rendered.props.children) as any[]
    expect(inner).toHaveLength(2)
    // id text is the second child
    expect(inner[1].props.children).toBe("codex")
  })

  it("with a version, the chip is wrapped in a Tooltip with the version as the content", () => {
    const tree = MachineRuntimes({
      runtimes: [{ id: "claude", version: "2.0.0-canary-20260101-abcdef" }],
    })
    const chips = collectChips(tree)
    const rendered = renderChip(chips[0])
    // rendered is a <Tooltip>...</Tooltip> — a functional-component element
    expect(isValidElement(rendered)).toBe(true)
    const tooltipChildren = Children.toArray(rendered.props.children) as any[]
    // [0] = TooltipTrigger, [1] = TooltipContent
    expect(tooltipChildren).toHaveLength(2)
    expect(tooltipChildren[1].props.children).toBe("2.0.0-canary-20260101-abcdef")
    // Trigger renders a button carrying the id but not the version text
    const triggerRender = tooltipChildren[0].props.render
    expect(triggerRender.type).toBe("button")
    const triggerInner = Children.toArray(triggerRender.props.children) as any[]
    expect(triggerInner[1].props.children).toBe("claude")
    // aria-label surfaces the version for screen readers
    expect(triggerRender.props["aria-label"]).toBe("claude 2.0.0-canary-20260101-abcdef")
  })

  it("passes the runtime id through to ProviderLogo so unknown ids fall back to the generic icon", () => {
    const tree = MachineRuntimes({ runtimes: [{ id: "future-cli" }] })
    const chips = collectChips(tree)
    const rendered = renderChip(chips[0])
    const inner = Children.toArray(rendered.props.children) as any[]
    expect(inner[0].props.provider).toBe("future-cli")
  })

  it("both chip branches share the same base class; the tooltip branch adds interactive-state classes", () => {
    const baseTokens = [
      "inline-flex",
      "max-w-[160px]",
      "items-center",
      "gap-2",
      "rounded-md",
      "border",
      "border-border",
      "bg-card",
      "px-2",
      "py-1",
      "text-[11px]",
    ]
    const interactiveTokens = [
      "transition-colors",
      "hover:bg-accent",
      "focus-visible:outline-none",
      "focus-visible:ring-2",
      "focus-visible:ring-ring",
      "focus-visible:ring-offset-2",
    ]

    // Plain span (no version) — base only.
    const plainTree = MachineRuntimes({ runtimes: [{ id: "codex" }] })
    const plainChips = collectChips(plainTree)
    const plainRendered = renderChip(plainChips[0])
    const plainClass = plainRendered.props.className as string
    for (const token of baseTokens) {
      expect(plainClass).toContain(token)
    }
    for (const token of interactiveTokens) {
      expect(plainClass).not.toContain(token)
    }

    // Tooltip branch — base + interactive states.
    const tipTree = MachineRuntimes({ runtimes: [{ id: "claude", version: "1.0.0" }] })
    const tipChips = collectChips(tipTree)
    const tipRendered = renderChip(tipChips[0])
    const tipChildren = Children.toArray(tipRendered.props.children) as any[]
    const buttonClass = tipChildren[0].props.render.props.className as string
    for (const token of [...baseTokens, ...interactiveTokens]) {
      expect(buttonClass).toContain(token)
    }
  })
})
