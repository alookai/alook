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

  it("returns null for a legacy summary with undefined availableRuntimes (nullish-guard)", () => {
    expect(MachineRuntimes({ runtimes: undefined })).toBeNull()
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

  it("without a version and healthy, the chip is a plain span (no tooltip wrapper)", () => {
    const tree = MachineRuntimes({ runtimes: [{ id: "codex" }] })
    const chips = collectChips(tree)
    const rendered = renderChip(chips[0])
    expect(rendered.type).toBe("span")
    // React fragment wrapping children — collect deeply.
    const fragment = rendered.props.children as any
    const inner = Children.toArray(fragment.props.children) as any[]
    // [0] logo, [1] id text
    expect(inner).toHaveLength(2)
    expect(inner[1].props.children).toBe("codex")
  })

  it("with a version, the chip is wrapped in a Tooltip carrying the version", () => {
    const tree = MachineRuntimes({
      runtimes: [{ id: "claude", version: "2.0.0-canary-20260101-abcdef" }],
    })
    const chips = collectChips(tree)
    const rendered = renderChip(chips[0])
    expect(isValidElement(rendered)).toBe(true)
    const tooltipChildren = Children.toArray(rendered.props.children) as any[]
    // [0] = TooltipTrigger, [1] = TooltipContent
    expect(tooltipChildren).toHaveLength(2)
    expect(tooltipChildren[1].props.children).toBe("2.0.0-canary-20260101-abcdef")
    // Trigger renders a button. aria-label surfaces the id + version.
    const triggerRender = tooltipChildren[0].props.render
    expect(triggerRender.type).toBe("button")
    expect(triggerRender.props["aria-label"]).toBe(
      "claude 2.0.0-canary-20260101-abcdef"
    )
  })

  it("passes the runtime id through to ProviderLogo so unknown ids fall back to the generic icon", () => {
    const tree = MachineRuntimes({ runtimes: [{ id: "future-cli" }] })
    const chips = collectChips(tree)
    const rendered = renderChip(chips[0])
    const fragment = rendered.props.children as any
    const inner = Children.toArray(fragment.props.children) as any[]
    // Healthy branch renders <ProviderLogo>; unhealthy renders <CircleAlert>.
    expect(inner[0].props.provider).toBe("future-cli")
  })

  it("unhealthy runtimes render dimmed and wrapped in a Tooltip explaining unavailability", () => {
    const tree = MachineRuntimes({
      runtimes: [
        { id: "codex", status: "unhealthy" as const, lastError: "spawn_enoent" },
      ],
    })
    const chips = collectChips(tree)
    const rendered = renderChip(chips[0])
    // Wrapped in Tooltip since the unhealthy branch always has tooltip text.
    expect(isValidElement(rendered)).toBe(true)
    const tooltipChildren = Children.toArray(rendered.props.children) as any[]
    // Tooltip content mentions "Unavailable" and includes the lastError code.
    const contentText = String(tooltipChildren[1].props.children)
    expect(contentText).toMatch(/Unavailable/)
    expect(contentText).toMatch(/spawn_enoent/)
    // Trigger button carries opacity-40 (dim).
    const triggerRender = tooltipChildren[0].props.render
    expect(triggerRender.type).toBe("button")
    expect(triggerRender.props.className as string).toContain("opacity-40")
    // aria-label reflects unhealthy state, not a version.
    expect(triggerRender.props["aria-label"]).toBe("codex unavailable")
  })

  it("sorts unhealthy runtimes after healthy ones, preserving relative order within each group", () => {
    const tree = MachineRuntimes({
      runtimes: [
        { id: "codex", status: "unhealthy" as const },
        { id: "claude" },
        { id: "pi", status: "unhealthy" as const },
        { id: "gemini" },
      ],
    })
    const chips = collectChips(tree)
    expect(chips.map((c) => c.key)).toEqual([".$claude", ".$gemini", ".$codex", ".$pi"])
  })

  it("unhealthy without lastError falls back to a generic 'Unavailable — check daemon logs' tooltip", () => {
    const tree = MachineRuntimes({
      runtimes: [{ id: "codex", status: "unhealthy" as const }],
    })
    const chips = collectChips(tree)
    const rendered = renderChip(chips[0])
    const tooltipChildren = Children.toArray(rendered.props.children) as any[]
    expect(String(tooltipChildren[1].props.children)).toBe(
      "Unavailable — check daemon logs"
    )
  })
})
