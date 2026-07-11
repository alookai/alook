import { describe, it, expect } from "vitest"
import { computeDuplicateNames } from "./member-list"
import type { Member } from "./_types"

const member = (id: string, name: string, discriminator?: string): Member => ({
  id,
  userId: id,
  name,
  discriminator,
  avatar: name[0],
  status: "online",
  sub: "",
  role: "member",
})

describe("computeDuplicateNames", () => {
  it("flags both members when two share a name", () => {
    const members = [member("m1", "Alex", "0001"), member("m2", "Alex", "0002")]
    const dupes = computeDuplicateNames(members)
    expect(dupes.has("alex")).toBe(true)
  })

  it("is case-insensitive — 'Alex' and 'alex' still collide", () => {
    const members = [member("m1", "Alex", "0001"), member("m2", "alex", "0002")]
    const dupes = computeDuplicateNames(members)
    expect(dupes.has("alex")).toBe(true)
  })

  it("leaves a unique name unflagged", () => {
    const members = [member("m1", "Alex", "0001"), member("m2", "Bob", "0002")]
    const dupes = computeDuplicateNames(members)
    expect(dupes.has("alex")).toBe(false)
    expect(dupes.has("bob")).toBe(false)
  })

  it("returns an empty set for an empty roster", () => {
    expect(computeDuplicateNames([]).size).toBe(0)
  })

  it("flags a name shared by three or more members", () => {
    const members = [
      member("m1", "Alex", "0001"),
      member("m2", "Alex", "0002"),
      member("m3", "Alex", "0003"),
    ]
    const dupes = computeDuplicateNames(members)
    expect(dupes.has("alex")).toBe(true)
  })
})
