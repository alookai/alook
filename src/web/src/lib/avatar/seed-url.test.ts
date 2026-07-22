import { describe, it, expect } from "vitest"
import { serializeBeamSeed, parseBeamSeed } from "./seed-url"

describe("seed-url", () => {
  it("round-trips seed → url → seed", () => {
    expect(parseBeamSeed(serializeBeamSeed("usr_1"))).toBe("usr_1")
    expect(parseBeamSeed(serializeBeamSeed("a-b-c-uuid"))).toBe("a-b-c-uuid")
  })

  it("serializes with the avatar:beam: prefix", () => {
    expect(serializeBeamSeed("x")).toBe("avatar:beam:x")
  })

  it("returns null for non-beam values", () => {
    expect(parseBeamSeed(null)).toBeNull()
    expect(parseBeamSeed(undefined)).toBeNull()
    expect(parseBeamSeed("")).toBeNull()
    expect(parseBeamSeed("https://cdn.example.com/a.png")).toBeNull()
    expect(parseBeamSeed("/api/community/users/u1/avatar")).toBeNull()
    expect(parseBeamSeed('avatar:{"shape":"star","eye":"happy","nose":"dot","bg":3}')).toBeNull()
  })

  it("returns null for an empty seed after the prefix", () => {
    expect(parseBeamSeed("avatar:beam:")).toBeNull()
  })
})
