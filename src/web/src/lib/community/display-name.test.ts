import { describe, it, expect } from "vitest"
import { displayName, emailPrefix, makeUserNameResolver } from "./display-name"

describe("emailPrefix", () => {
  it("returns the part before @", () => {
    expect(emailPrefix("alice@example.com")).toBe("alice")
  })

  it("trims surrounding whitespace", () => {
    expect(emailPrefix("  bob@example.com  ")).toBe("bob")
  })

  it("returns empty string for null/undefined", () => {
    expect(emailPrefix(null)).toBe("")
    expect(emailPrefix(undefined)).toBe("")
  })
})

describe("displayName", () => {
  it("returns the trimmed name when present", () => {
    expect(displayName({ name: "Alice" })).toBe("Alice")
    expect(displayName({ name: "  Alice  " })).toBe("Alice")
  })

  it("falls back to the email prefix when name is empty", () => {
    expect(displayName({ name: "", email: "carol@example.com" })).toBe("carol")
    expect(displayName({ name: "   ", email: "carol@example.com" })).toBe("carol")
    expect(displayName({ email: "dave@example.com" })).toBe("dave")
  })

  it("returns 'Unknown member' when neither name nor email is present", () => {
    expect(displayName({})).toBe("Unknown member")
    expect(displayName(null)).toBe("Unknown member")
    expect(displayName(undefined)).toBe("Unknown member")
    expect(displayName({ name: null, email: null })).toBe("Unknown member")
  })

  it("never returns a raw id", () => {
    const id = "user_abc123"
    expect(displayName({ name: "", email: "" })).not.toBe(id)
    expect(displayName({})).toBe("Unknown member")
  })
})

describe("makeUserNameResolver", () => {
  const list = [
    { userId: "u1", name: "Alice" },
    { userId: "u2", name: "", email: "bob@example.com" },
    { id: "u3", name: "Carol" },
  ]

  it("resolves a found row via displayName", () => {
    const resolve = makeUserNameResolver(list)
    expect(resolve("u1")).toBe("Alice")
    expect(resolve("u2")).toBe("bob")
    expect(resolve("u3")).toBe("Carol")
  })

  it("returns 'Unknown member' (not the id) for an unknown user", () => {
    const resolve = makeUserNameResolver(list)
    expect(resolve("missing")).toBe("Unknown member")
    expect(resolve("missing")).not.toBe("missing")
  })
})

describe("reaction tooltip resolution", () => {
  // Reaction tooltips resolve reactor ids through makeUserNameResolver over the
  // combined members + friends set. A reactor that arrived only over the WS
  // event (id, no name) and is absent from the loaded set must fall back to
  // "Unknown member" — never the raw user id.
  const roster = [
    { userId: "member_1", name: "Alice" },
    { userId: "friend_1", name: "", email: "bob@example.com" },
  ]

  it("resolves a reactor found in members or friends to a name", () => {
    const resolve = makeUserNameResolver(roster)
    expect(resolve("member_1")).toBe("Alice")
    expect(resolve("friend_1")).toBe("bob")
  })

  it("resolves a live-WS reactor absent from the loaded set to 'Unknown member', never the id", () => {
    const resolve = makeUserNameResolver(roster)
    const liveOnlyReactorId = "user_live_only_99"
    expect(resolve(liveOnlyReactorId)).toBe("Unknown member")
    expect(resolve(liveOnlyReactorId)).not.toBe(liveOnlyReactorId)
  })
})
