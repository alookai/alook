import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect } from "vitest"
import { ChannelPill } from "./inline-marks"
import { parseChannelRefDestination } from "@/lib/community/channel-ref"

describe("ref destination normalization", () => {
  it("deduplicates message suffixes while keeping their display numbers", () => {
    const first = parseChannelRefDestination("/Alook#5620/fix/#259#18")!
    const second = parseChannelRefDestination("/ALOOK#5620/fix/#259#27")!
    expect(first.ref).toBe("/alook#5620/fix/#259")
    expect(second.ref).toBe(first.ref)
    expect(first.messageSeq).toBe(18); expect(second.messageSeq).toBe(27)
  })
  it("drops only the message suffix on a plain channel", () => {
    expect(parseChannelRefDestination("/Alook#5620/fix#18")).toMatchObject({ ref: "/alook#5620/fix", messageSeq: 18, threadRootSeq: undefined })
  })
  it("does not accept a new DM target grammar", () => { expect(parseChannelRefDestination("/.dm/peer#0042#18")).toBeNull() })
})
describe("ChannelPill status and semantics", () => {
  it("keeps a ready destination as one native button including the message number", () => {
    const html = renderToStaticMarkup(createElement(ChannelPill, { onClick: () => {}, seqSuffix: 18, state: "ready" }, "Archived post"))
    expect(html).toContain('<button type="button"'); expect(html).toContain("#18"); expect(html).toContain('data-ref-state="ready"')
  })
  it("preserves an unresolved raw ref without suggesting a verified channel", () => {
    const ref = "/Alook#5620/fix/#259#18"
    const html = renderToStaticMarkup(createElement(ChannelPill, { muted: true, showIcon: false, state: "loading", statusLabel: "Loading link…" }, ref))
    expect(html).toContain(ref); expect(html).toContain('aria-busy="true"'); expect(html).toContain("Loading link…")
    expect(html).not.toContain("<button"); expect(html).toContain('data-ref-status="loading"')
  })
})
