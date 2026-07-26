import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ReactionChips } from "./reaction-chips"
import type { Reaction } from "./_types"

// F3: ReactionChips is the reaction strip extracted from message.tsx (the
// interactive row) and thread-opener.tsx (the read-only opener). It's
// parameterized on `interactive` + `radius`; these tests pin the two shapes so
// the extraction can't silently converge them.

const reactions: Reaction[] = [{ emoji: "👍", count: 2, me: true, userIds: ["u2", "u3"] }]

describe("ReactionChips interactive (message row)", () => {
  const html = renderToStaticMarkup(
    createElement(ReactionChips, {
      reactions,
      interactive: true,
      radius: "md" as const,
      activated: true,
      onToggleReaction: () => {},
      onReact: () => {},
      resolveUserName: (id: string) => (id === "u2" ? "Bob" : "Cara"),
    }),
  )

  it("renders clickable <button> chips with rounded-md", () => {
    expect(html).toContain("<button")
    expect(html).toContain("rounded-md")
    expect(html).not.toContain("rounded-full")
  })

  it("wires a per-chip tooltip and an add-reaction affordance", () => {
    // Base UI TooltipContent is portaled (absent from static markup), but the
    // tooltip trigger wiring + the add-reaction button prove both are present.
    expect(html).toContain("data-base-ui-tooltip-trigger")
    expect(html).toContain('aria-label="Add reaction"')
  })
})

describe("ReactionChips read-only (thread opener)", () => {
  const html = renderToStaticMarkup(
    createElement(ReactionChips, {
      reactions,
      interactive: false,
      radius: "full" as const,
    }),
  )

  it("renders <span> chips with rounded-full and no clickable element", () => {
    expect(html).toContain("rounded-full")
    expect(html).not.toContain("rounded-md")
    expect(html).not.toContain("<button")
  })

  it("has no toggle/tooltip/add affordance", () => {
    expect(html).not.toContain("Reacted by")
    expect(html).not.toContain("Add reaction")
  })
})
