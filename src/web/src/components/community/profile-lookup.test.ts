import { describe, it, expect } from "vitest"
import { resolveProfileTarget } from "./profile-lookup"
import type { Member, Friend } from "./_types"

function member(overrides: Partial<Member>): Member {
  return {
    id: overrides.id ?? "mem_default",
    userId: overrides.userId ?? "user_default",
    name: overrides.name ?? "Default",
    discriminator: overrides.discriminator,
    avatar: overrides.avatar ?? "D",
    status: overrides.status ?? "online",
    sub: overrides.sub ?? "",
    role: overrides.role ?? "member",
  }
}

describe("resolveProfileTarget", () => {
  it("resolves the exact member by userId when two members share a name — regression for the bug where profile cards collapsed to the first name match", () => {
    const a = member({ id: "mem_a", userId: "user_a", name: "435669237", discriminator: "7892" })
    const b = member({ id: "mem_b", userId: "user_b", name: "435669237", discriminator: "3759" })
    const members = [a, b]

    expect(resolveProfileTarget(members, undefined, { name: "435669237", userId: "user_b" })).toBe(b)
    expect(resolveProfileTarget(members, undefined, { name: "435669237", userId: "user_a" })).toBe(a)
  })

  it("falls back to discriminator matching when no userId is available (mention pill case)", () => {
    const a = member({ id: "mem_a", userId: "user_a", name: "Gus", discriminator: "0042" })
    const b = member({ id: "mem_b", userId: "user_b", name: "Gus", discriminator: "0099" })
    const members = [a, b]

    expect(resolveProfileTarget(members, undefined, { name: "Gus", discriminator: "0099" })).toBe(b)
  })

  it("falls back to the first name match when neither userId nor discriminator is provided (legacy behavior)", () => {
    const a = member({ id: "mem_a", userId: "user_a", name: "Gus" })
    const b = member({ id: "mem_b", userId: "user_b", name: "Gus" })
    const members = [a, b]

    expect(resolveProfileTarget(members, undefined, { name: "Gus" })).toBe(a)
  })

  it("checks friends when userId doesn't match any member", () => {
    const friend: Friend = { id: "fr_a", userId: "user_c", name: "Ren", avatar: "R", status: "online", sub: "" }
    expect(resolveProfileTarget([], [friend], { name: "Ren", userId: "user_c" })).toBe(friend)
  })
})
