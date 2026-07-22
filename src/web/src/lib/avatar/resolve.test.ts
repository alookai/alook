import { describe, it, expect } from "vitest"
import { resolveAvatar } from "./resolve"
import { serializeBeamSeed } from "./seed-url"

describe("resolveAvatar", () => {
  it("resolves a photo URL (https) to photo", () => {
    expect(resolveAvatar("https://cdn.example.com/a.png", "id_1")).toEqual({
      kind: "photo",
      url: "https://cdn.example.com/a.png",
    })
  })

  it("resolves a routable leading-/ URL to photo", () => {
    expect(resolveAvatar("/api/community/users/u1/avatar", "id_1")).toEqual({
      kind: "photo",
      url: "/api/community/users/u1/avatar",
    })
  })

  it("resolves a avatar:beam value to beam with the stored seed", () => {
    expect(resolveAvatar(serializeBeamSeed("seed-x"), "id_1")).toEqual({
      kind: "beam",
      seed: "seed-x",
    })
  })

  it("ignores a legacy avatar:{shape…} config and beams by the fallback seed", () => {
    expect(
      resolveAvatar('avatar:{"shape":"star","eye":"happy","nose":"dot","bg":3}', "id_1"),
    ).toEqual({ kind: "beam", seed: "id_1" })
  })

  it("beams by the fallback seed for null/undefined", () => {
    expect(resolveAvatar(null, "id_1")).toEqual({ kind: "beam", seed: "id_1" })
    expect(resolveAvatar(undefined, "id_1")).toEqual({ kind: "beam", seed: "id_1" })
  })
})
