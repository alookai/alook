import { describe, it, expect, vi } from "vitest"
import type { Member } from "@/components/community/_types"
import {
  buildCommunityMentionExtension,
  rankMentionItems,
  detectMentionType,
  EMPTY_MENTION_STATE,
  type MentionContext,
  type MentionPopupState,
} from "./mention-extension"

const member = (id: string, name: string): Member => ({
  id,
  userId: id,
  name,
  avatar: name[0],
  status: "online",
  sub: name,
  role: "member",
})

describe("rankMentionItems", () => {
  const roster = [
    member("u1", "Alice"),
    member("u2", "Albert"),
    member("u3", "Bob"),
    member("u4", "Heath"),
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
    const many = Array.from({ length: 50 }, (_, i) => member(`u${i}`, `User${i}`))
    expect(rankMentionItems(many, "channel", "").length).toBe(8)
  })

  it("accepts a full Member[] with role/userId fields — ranking invariants unchanged", () => {
    // Sanity: rankMentionItems only reads id/name/avatar/status. Passing a
    // roster with the additional Member fields (`userId`, `role`, `sub`) must
    // still rank virtual → prefix → substring.
    const memberRoster: Member[] = [
      { id: "m_alice", userId: "u_alice", name: "Alice", avatar: "A", status: "online", sub: "eng", role: "admin" },
      { id: "m_bob", userId: "u_bob", name: "Bob", avatar: "B", status: "offline", sub: "", role: "member" },
      { id: "m_alba", userId: "u_alba", name: "Alba", avatar: "A", status: "online", sub: "", role: "owner" },
    ]
    const items = rankMentionItems(memberRoster, "channel", "al")
    // Virtual items are gated by prefix on the query — "al" filters both out.
    expect(items.some((i) => i.id === "everyone")).toBe(false)
    expect(items.some((i) => i.id === "here")).toBe(false)
    const memberIds = items.filter((i) => i.kind === "member").map((i) => i.id)
    expect(memberIds).toEqual(["m_alice", "m_alba"])
  })

  it("preserves virtual → prefix → substring order on a non-empty Member[]", () => {
    const memberRoster: Member[] = [
      { id: "m_al", userId: "u_al", name: "Alberta", avatar: "A", status: "online", sub: "", role: "member" },
      { id: "m_mal", userId: "u_mal", name: "Mallory", avatar: "M", status: "online", sub: "", role: "member" },
    ]
    const items = rankMentionItems(memberRoster, "channel", "")
    // Empty query — @everyone / @here lead, then all members (starts-with
    // branch fires for empty query too).
    expect(items[0].id).toBe("everyone")
    expect(items[1].id).toBe("here")
    expect(items[2].id).toBe("m_al")
    expect(items[3].id).toBe("m_mal")
  })

  it("ranks substring members after prefix members", () => {
    const memberRoster: Member[] = [
      { id: "m_al", userId: "u_al", name: "Alberta", avatar: "A", status: "online", sub: "", role: "member" },
      { id: "m_mal", userId: "u_mal", name: "Mallory", avatar: "M", status: "online", sub: "", role: "member" },
    ]
    const items = rankMentionItems(memberRoster, "channel", "al")
    // "Alberta" prefix-matches "al"; "Mallory" substring-matches. Prefix wins.
    const memberIds = items.filter((i) => i.kind === "member").map((i) => i.id)
    expect(memberIds).toEqual(["m_al", "m_mal"])
  })
})

// Reach into the extension the same way the composer does — read
// `configuration.suggestion.items` off the configured node. This exercises
// the exact callback the Composer wires to tiptap, without spinning up a
// browser environment (this repo's vitest runs under node).
function getItemsCallback(
  ext: ReturnType<typeof buildCommunityMentionExtension>,
): (props: { query: string }) => unknown[] {
  const config = (ext as unknown as { config: { addOptions?: () => { suggestion?: { items?: unknown } } } }).config
  const opts = config.addOptions?.() ?? (ext as unknown as { options?: { suggestion?: { items?: unknown } } }).options
  const items = (opts?.suggestion as { items: (props: { query: string }) => unknown[] } | undefined)?.items
  if (!items) throw new Error("suggestion.items not found")
  return items
}

describe("buildCommunityMentionExtension — suggestion.items callback", () => {
  it("fires onSearchMembersRef.current with the current query on each items() call", () => {
    const membersRef = { current: [] as Member[] }
    const contextRef = { current: "channel" as MentionContext }
    const popupRef = { current: EMPTY_MENTION_STATE as MentionPopupState }
    const onSearchMembersRef = { current: vi.fn() as ((q: string) => void) | undefined }
    const queryRef = { current: "" }
    const ext = buildCommunityMentionExtension({
      membersRef,
      contextRef,
      popupRef,
      setPopup: () => {},
      onSearchMembersRef,
      queryRef,
    })
    const items = getItemsCallback(ext)
    items({ query: "al" })
    items({ query: "alb" })
    const mock = onSearchMembersRef.current as unknown as ReturnType<typeof vi.fn>
    expect(mock).toHaveBeenCalledTimes(2)
    expect(mock).toHaveBeenNthCalledWith(1, "al")
    expect(mock).toHaveBeenNthCalledWith(2, "alb")
  })

  it("updates the shared queryRef.current on each items() call", () => {
    const membersRef = { current: [] as Member[] }
    const contextRef = { current: "channel" as MentionContext }
    const popupRef = { current: EMPTY_MENTION_STATE as MentionPopupState }
    const queryRef = { current: "" }
    const ext = buildCommunityMentionExtension({
      membersRef,
      contextRef,
      popupRef,
      setPopup: () => {},
      queryRef,
    })
    const items = getItemsCallback(ext)
    items({ query: "hi" })
    expect(queryRef.current).toBe("hi")
    items({ query: "hello" })
    expect(queryRef.current).toBe("hello")
  })

  it("is a no-op when onSearchMembersRef is undefined (DM composer)", () => {
    const membersRef = { current: [] as Member[] }
    const contextRef = { current: "dm" as MentionContext }
    const popupRef = { current: EMPTY_MENTION_STATE as MentionPopupState }
    // No onSearchMembersRef, no queryRef — the mention builder must still
    // return the DM-context ranking ([]) without throwing.
    const ext = buildCommunityMentionExtension({
      membersRef,
      contextRef,
      popupRef,
      setPopup: () => {},
    })
    const items = getItemsCallback(ext)
    expect(items({ query: "anything" })).toEqual([])
  })

  it("returns the ranked items straight from rankMentionItems for the live refs", () => {
    const membersRef = {
      current: [member("m1", "Alice"), member("m2", "Bob")] as Member[],
    }
    const contextRef = { current: "channel" as MentionContext }
    const popupRef = { current: EMPTY_MENTION_STATE as MentionPopupState }
    const ext = buildCommunityMentionExtension({
      membersRef,
      contextRef,
      popupRef,
      setPopup: () => {},
    })
    const items = getItemsCallback(ext)
    // Live refs — mutate the roster after the extension is built. items()
    // must see the new value on next call (this is the whole point of the
    // ref-based design).
    membersRef.current = [member("m1", "Alice"), member("m2", "Bob"), member("m3", "Alba")]
    const result = items({ query: "al" }) as { id: string; kind: string }[]
    const memberIds = result.filter((r) => r.kind === "member").map((r) => r.id)
    expect(memberIds).toEqual(["m1", "m3"])
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
