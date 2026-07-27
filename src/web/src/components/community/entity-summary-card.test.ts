import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { EntitySummaryCard } from "./entity-summary-card"

// F2: EntitySummaryCard is a shared layout skeleton (leading · title/meta ·
// trailing) reused by the forum card header, right-panel thread + pinned rows,
// and the inbox rows. The acceptance is NOT "four identical" — it's "shared
// skeleton, variants preserved": each snapshot keeps its own leading glyph,
// avatar size, and trailing affordance.

function snap(props: Parameters<typeof EntitySummaryCard>[0]): string {
  return renderToStaticMarkup(createElement(EntitySummaryCard, props))
}

describe("EntitySummaryCard shared skeleton, variants preserved", () => {
  it("forum variant: 24px avatar leading + attribution title + avatar-group trailing", () => {
    const html = snap({
      leading: createElement("span", { "data-v": "forum-avatar-24" }, "A"),
      title: createElement("span", null, "Alice · 2h"),
      trailing: createElement("span", { "data-v": "avatar-group" }),
    })
    expect(html).toContain("forum-avatar-24")
    expect(html).toContain("avatar-group")
    expect(html).toContain("Alice · 2h")
    // No meta → title placed directly, no flex-1 middle wrapper.
    expect(html).not.toContain("flex-1")
  })

  it("thread variant: icon leading + title + multi-line meta, no trailing", () => {
    const html = snap({
      leading: createElement("span", { "data-v": "thread-icon" }),
      title: createElement("div", null, "Thread name"),
      meta: createElement("div", null, "3 messages"),
    })
    expect(html).toContain("thread-icon")
    expect(html).toContain("Thread name")
    expect(html).toContain("3 messages")
    // meta present → title/meta wrapped in the flex-1 middle column.
    expect(html).toContain("flex-1")
  })

  it("pinned variant: avatar-circle leading + author title + content meta", () => {
    const html = snap({
      leading: createElement("div", { "data-v": "pinned-avatar" }, "P"),
      title: createElement("span", null, "Pinner"),
      meta: createElement("div", null, "pinned content"),
    })
    expect(html).toContain("pinned-avatar")
    expect(html).toContain("Pinner")
    expect(html).toContain("pinned content")
    expect(html).toContain("flex-1")
  })

  it("inbox variant: entity-icon leading + single-line title + badge/chevron trailing", () => {
    const html = snap({
      leading: createElement("span", { "data-v": "entity-icon" }),
      title: createElement("span", { className: "min-w-0 flex-1 truncate" }, "channel-name"),
      trailing: createElement("span", { "data-v": "chevron" }),
    })
    expect(html).toContain("entity-icon")
    expect(html).toContain("channel-name")
    expect(html).toContain("chevron")
    // Inbox omits meta but keeps flex-1 on its own title span (variant markup).
    expect(html).toContain("flex-1")
  })
})
