import { describe, it, expect } from "vitest"
import {
  requireMessageBearingSurface,
  requireChildSurface,
  rejectDmOnGenericChannelRoute,
  requireReactableSurface,
  requirePinnableSurface,
} from "./channel-write-guard"

describe("requireMessageBearingSurface", () => {
  it("accepts text/forum/thread — every stored type except dm", () => {
    for (const t of ["text", "forum", "thread"]) {
      expect(requireMessageBearingSurface(t).ok).toBe(true)
    }
  })

  it("rejects a DM hitting a generic channel route with 400 (block-bypass guard)", () => {
    const r = requireMessageBearingSurface("dm")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
  })

  it("rejects null/unknown types", () => {
    expect(requireMessageBearingSurface(null).ok).toBe(false)
    expect(requireMessageBearingSurface(undefined).ok).toBe(false)
    expect(requireMessageBearingSurface("bogus").ok).toBe(false)
    expect(requireMessageBearingSurface("forum_post").ok).toBe(false)
  })
})

describe("rejectDmOnGenericChannelRoute", () => {
  it("rejects only dm; passes every non-dm type", () => {
    expect(rejectDmOnGenericChannelRoute("dm").ok).toBe(false)
    for (const t of ["text", "forum", "thread", null, undefined]) {
      expect(rejectDmOnGenericChannelRoute(t).ok).toBe(true)
    }
  })
})

describe("requireReactableSurface", () => {
  it("accepts emoji-capable chat surfaces and rejects forum openers", () => {
    for (const t of ["text", "thread", "dm"]) {
      expect(requireReactableSurface(t).ok).toBe(true)
    }
    expect(requireReactableSurface("forum").ok).toBe(false)
  })
})

describe("requirePinnableSurface", () => {
  it("accepts text/thread/forum", () => {
    for (const t of ["text", "forum", "thread"]) {
      expect(requirePinnableSurface(t).ok).toBe(true)
    }
  })

  it("rejects dm (governance model does not fit) with 400", () => {
    for (const t of ["dm", null, undefined]) {
      const r = requirePinnableSurface(t)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.status).toBe(400)
    }
  })
})

describe("requireChildSurface", () => {
  it("accepts thread", () => {
    expect(requireChildSurface("thread").ok).toBe(true)
  })

  it("rejects top-level, dm, and forum_post (no longer a valid type) with 400", () => {
    for (const t of ["text", "forum", "dm", "forum_post", null, undefined]) {
      const r = requireChildSurface(t)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.status).toBe(400)
    }
  })
})
