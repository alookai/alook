import { describe, it, expect } from "vitest"
import {
  requireMessageBearingSurface,
  requireChildSurface,
  rejectDmOnGenericChannelRoute,
} from "./channel-write-guard"

describe("requireMessageBearingSurface", () => {
  it("accepts message-bearing surfaces (text, forum_post, thread)", () => {
    for (const t of ["text", "forum_post", "thread"]) {
      expect(requireMessageBearingSurface(t).ok).toBe(true)
    }
  })

  it("rejects a forum top-level (post index, not a message surface) with 400", () => {
    const r = requireMessageBearingSurface("forum")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
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
  })
})

describe("rejectDmOnGenericChannelRoute", () => {
  it("rejects only dm; passes every non-dm type", () => {
    expect(rejectDmOnGenericChannelRoute("dm").ok).toBe(false)
    for (const t of ["text", "forum", "forum_post", "thread", null, undefined]) {
      expect(rejectDmOnGenericChannelRoute(t).ok).toBe(true)
    }
  })
})

describe("requireChildSurface", () => {
  it("accepts thread and forum_post", () => {
    expect(requireChildSurface("thread").ok).toBe(true)
    expect(requireChildSurface("forum_post").ok).toBe(true)
  })

  it("rejects top-level and dm types with 400", () => {
    for (const t of ["text", "forum", "dm", null, undefined]) {
      const r = requireChildSurface(t)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.status).toBe(400)
    }
  })
})
