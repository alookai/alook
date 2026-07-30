import { describe, it, expect } from "vitest"
import { isMessageBearingSurface, isChannelType } from "./community-roles"

describe("isMessageBearingSurface", () => {
  it("is true for surfaces that bear messages: text, forum_post, thread, dm", () => {
    expect(isMessageBearingSurface("text")).toBe(true)
    expect(isMessageBearingSurface("forum_post")).toBe(true)
    expect(isMessageBearingSurface("thread")).toBe(true)
    expect(isMessageBearingSurface("dm")).toBe(true)
  })

  it("is false for a forum top-level (a post index, not a message surface)", () => {
    expect(isMessageBearingSurface("forum")).toBe(false)
  })

  it("is false for null/undefined/unknown", () => {
    expect(isMessageBearingSurface(null)).toBe(false)
    expect(isMessageBearingSurface(undefined)).toBe(false)
    expect(isMessageBearingSurface("bogus")).toBe(false)
  })
})

describe("isChannelType (creatable top-level types)", () => {
  it("accepts only text and forum", () => {
    expect(isChannelType("text")).toBe(true)
    expect(isChannelType("forum")).toBe(true)
    expect(isChannelType("forum_post")).toBe(false)
    expect(isChannelType("thread")).toBe(false)
    expect(isChannelType("dm")).toBe(false)
  })
})
