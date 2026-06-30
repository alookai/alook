import { describe, it, expect } from "vitest"
import type { Friend } from "@/components/community/_types"
import { rankMentionItems, detectMentionType } from "./mention-extension"

const friend = (id: string, name: string): Friend => ({
  id,
  name,
  avatar: name[0],
  status: "online",
  sub: name,
})

describe("rankMentionItems", () => {
  const roster = [
    friend("u1", "Alice"),
    friend("u2", "Albert"),
    friend("u3", "Bob"),
    friend("u4", "Heath"),
  ]

  it("puts everyone/here at the top in channel context with empty query", () => {
    const items = rankMentionItems(roster, "channel", "")
    expect(items.slice(0, 2).map((i) => i.id)).toEqual(["everyone", "here"])
  })

  it("includes everyone/here in thread context", () => {
    const items = rankMentionItems(roster, "thread", "")
    expect(items.some((i) => i.id === "everyone")).toBe(true)
    expect(items.some((i) => i.id === "here")).toBe(true)
  })

  it("returns no items in DM context — popover is disabled entirely", () => {
    expect(rankMentionItems(roster, "dm", "")).toEqual([])
    expect(rankMentionItems(roster, "dm", "al")).toEqual([])
  })

  it("filters everyone in by prefix, drops here", () => {
    const ids = rankMentionItems(roster, "channel", "ev").map((i) => i.id)
    expect(ids).toContain("everyone")
    expect(ids).not.toContain("here")
  })

  it("filters here in by prefix, drops everyone — and beats a member 'Heath' on prefix", () => {
    const items = rankMentionItems(roster, "channel", "he")
    const ids = items.map((i) => i.id)
    expect(ids).toContain("here")
    expect(ids).not.toContain("everyone")
    // Heath also starts with "he" — should still appear, after the virtual row.
    expect(ids).toContain("u4")
    expect(ids.indexOf("here")).toBeLessThan(ids.indexOf("u4"))
  })

  it("ranks member prefix matches before substring matches", () => {
    const items = rankMentionItems(roster, "channel", "al")
    const memberOrder = items.filter((i) => i.kind === "member").map((i) => i.label)
    // Alice and Albert start with "al"; no substring-only members in this set.
    expect(memberOrder.slice(0, 2).sort()).toEqual(["Albert", "Alice"])
  })

  it("caps the list at 8 items", () => {
    const many = Array.from({ length: 50 }, (_, i) => friend(`u${i}`, `User${i}`))
    expect(rankMentionItems(many, "channel", "").length).toBe(8)
  })
})

describe("detectMentionType", () => {
  it("finds @everyone as a standalone token", () => {
    expect(detectMentionType("hi @everyone")).toBe("everyone")
  })

  it("finds @here as a standalone token", () => {
    expect(detectMentionType("ping @here please")).toBe("here")
  })

  it("returns everyone when both occur (precedence)", () => {
    expect(detectMentionType("yo @here and @everyone")).toBe("everyone")
    expect(detectMentionType("yo @everyone and @here")).toBe("everyone")
  })

  it("ignores @everyone inside a longer identifier", () => {
    expect(detectMentionType("email me at user@everyone.com")).toBe(undefined)
    expect(detectMentionType("@everyoneone hey")).toBe(undefined)
  })

  it("returns undefined for plain text", () => {
    expect(detectMentionType("just a regular message")).toBe(undefined)
    expect(detectMentionType("")).toBe(undefined)
  })

  it("matches at start of string", () => {
    expect(detectMentionType("@everyone hello")).toBe("everyone")
    expect(detectMentionType("@here hello")).toBe("here")
  })

  it("matches at end of string", () => {
    expect(detectMentionType("hello @here")).toBe("here")
  })

  it("respects punctuation as a boundary", () => {
    expect(detectMentionType("(@everyone)")).toBe("everyone")
    expect(detectMentionType("@everyone,")).toBe("everyone")
  })
})
