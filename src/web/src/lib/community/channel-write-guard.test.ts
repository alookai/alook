import { describe, it, expect } from "vitest"
import {
  requireMessageBearingSurface,
  requireChildSurface,
  rejectDmOnGenericChannelRoute,
  requireReactableSurface,
  requirePinnableSurface,
} from "./channel-write-guard"

describe("requireMessageBearingSurface", () => {
  it("accepts text/forum/thread — forum is now directly sendable (phase2 forum≡thread write-guard reversal)", () => {
    for (const t of ["text", "forum", "thread"]) {
      expect(requireMessageBearingSurface(t).ok).toBe(true)
    }
  })

  it("rejects forum_post (the sole remaining exclusion, until it's deleted entirely at step 6) with 400", () => {
    const r = requireMessageBearingSurface("forum_post")
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

describe("requireReactableSurface", () => {
  it("accepts every message-bearing surface incl. dm and forum (reacting in a DM is legit; forum is now directly sendable)", () => {
    for (const t of ["text", "forum", "thread", "dm"]) {
      expect(requireReactableSurface(t).ok).toBe(true)
    }
  })

  it("rejects forum_post (the sole remaining exclusion) with 400", () => {
    const r = requireReactableSurface("forum_post")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
  })
})

describe("requirePinnableSurface", () => {
  it("accepts text/thread/forum (forum is now directly sendable)", () => {
    for (const t of ["text", "forum", "thread"]) {
      expect(requirePinnableSurface(t).ok).toBe(true)
    }
  })

  it("rejects dm (governance model does not fit) and forum_post with 400", () => {
    for (const t of ["dm", "forum_post", null, undefined]) {
      const r = requirePinnableSurface(t)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.status).toBe(400)
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
