import { describe, it, expect } from "vitest"
import { buildMessagesSeed } from "./use-channel-bootstrap"

// The seed shape is load-bearing: useMessages' getNext/PreviousPageParam and
// anchor-revalidation read `pageParams`, and WS inserts patch `pages[0]` using
// the anchor-mode envelope. A wrong shape silently breaks pagination / live
// updates. See plans/community-switch-perf-optimization.md WS2.

function resp(over: Record<string, unknown> = {}) {
  return {
    readState: { lastReadMessageId: "m_10", lastReadAt: "t", lastReadSeq: 10 },
    anchorMode: "anchor" as const,
    anchorMessageId: "m_10",
    messages: [{ id: "m_10", type: "chat" as const }],
    latestSeq: 20,
    hasMoreOlder: true,
    hasMoreNewer: true,
    olderCursor: "oc",
    newerCursor: "nc",
    ...over,
  } as Parameters<typeof buildMessagesSeed>[0]
}

describe("buildMessagesSeed", () => {
  it("seeds a single page with the mandatory anchor pageParam", () => {
    const seed = buildMessagesSeed(resp())
    expect(seed.pages).toHaveLength(1)
    expect(seed.pageParams).toEqual([{ mode: "anchor", anchor: "m_10" }])
  })

  it("carries the anchor-mode envelope (hasMoreOlder/Newer + cursors) for WS-patch compat", () => {
    const seed = buildMessagesSeed(resp())
    const page = seed.pages[0]
    expect(page.hasMoreOlder).toBe(true)
    expect(page.hasMoreNewer).toBe(true)
    expect(page.olderCursor).toBe("oc")
    expect(page.newerCursor).toBe("nc")
    expect(page.latestSeq).toBe(20)
    // Never the legacy `hasMore` field — that would misroute getNextPageParam.
    expect(page.hasMore).toBeUndefined()
  })

  it("uses a newest pageParam when the server fell back (deleted/absent anchor)", () => {
    const seed = buildMessagesSeed(resp({ anchorMode: "newest", anchorMessageId: null }))
    expect(seed.pageParams).toEqual([{ mode: "newest" }])
  })

  it("uses newest when anchorMode is anchor but the id is missing (defensive)", () => {
    const seed = buildMessagesSeed(resp({ anchorMode: "anchor", anchorMessageId: null }))
    expect(seed.pageParams).toEqual([{ mode: "newest" }])
  })
})
