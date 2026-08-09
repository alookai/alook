import { describe, expect, it } from "vitest"
import { avatarPickerStateFromImage, isPhotoDraftSource } from "./use-avatar-draft-picker"
import { serializeBeamSeed } from "@/lib/avatar/seed-url"

describe("avatar draft picker state", () => {
  it.each(["https://cdn.example.com/avatar.png", "/api/avatar", "blob:preview"])(
    "recognizes photo source %s",
    (value) => expect(isPhotoDraftSource(value)).toBe(true),
  )

  it("keeps serialized generated seeds out of the photo branch", () => {
    const image = serializeBeamSeed("stored-seed")
    expect(isPhotoDraftSource(image)).toBe(false)
    expect(avatarPickerStateFromImage(image, "fallback")).toEqual({
      tab: "generate",
      seed: "stored-seed",
      photoDraft: null,
      activeKind: "procedural",
    })
  })

  it("restores photo and empty initial state without losing the fallback seed", () => {
    expect(avatarPickerStateFromImage("/api/avatar", "fallback")).toEqual({
      tab: "photo",
      seed: "fallback",
      photoDraft: { file: null, previewUrl: "/api/avatar" },
      activeKind: "photo",
    })
    expect(avatarPickerStateFromImage(null, "fallback")).toEqual({
      tab: "generate",
      seed: "fallback",
      photoDraft: null,
      activeKind: "procedural",
    })
  })
})
