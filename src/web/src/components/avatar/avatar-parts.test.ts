import { describe, it, expect } from "vitest"
import type React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  Shapes,
  Eyes,
  Noses,
  BG_COLORS,
  SHAPE_KEYS,
  EYE_KEYS,
  NOSE_KEYS,
  PRESETS,
  randomConfig,
  configFromName,
  isPhotoAvatarUrl,
} from "./avatar-parts"

const NEW_SHAPE_KEYS = [
  "chat", "shield", "heart", "star", "diamond", "cloud",
  "pentagon", "octagon", "bolt", "flag", "leaf", "drop",
  "triangle", "crown", "gem", "moon", "trophy", "rocket",
]
const NEW_EYE_KEYS = [
  "cat", "glasses", "heart", "star", "surprised", "sparkle",
  "square", "cross", "triangle", "target", "puppy", "angry",
]
const NEW_NOSE_KEYS = ["grin", "gasp", "zigzag", "pucker", "smirk"]

describe("Shapes", () => {
  it("includes every new shape key", () => {
    for (const key of NEW_SHAPE_KEYS) expect(SHAPE_KEYS).toContain(key)
  })

  it("every shape renders without throwing and has a valid face box", () => {
    for (const key of SHAPE_KEYS) {
      const shape = Shapes[key]!
      expect(() => shape.render()).not.toThrow()
      expect(typeof shape.face.cx).toBe("number")
      expect(typeof shape.face.cy).toBe("number")
      expect(shape.face.w).toBeGreaterThan(0)
    }
  })
})

describe("Eyes", () => {
  it("includes every new eye key", () => {
    for (const key of NEW_EYE_KEYS) expect(EYE_KEYS).toContain(key)
  })

  it("every eye renders without throwing", () => {
    for (const key of EYE_KEYS) {
      const eyeDef = Eyes[key]!
      expect(() => eyeDef.render(16, "#27272a")).not.toThrow()
    }
  })
})

describe("Noses", () => {
  it("includes every new nose key", () => {
    for (const key of NEW_NOSE_KEYS) expect(NOSE_KEYS).toContain(key)
  })

  it("every nose renders without throwing", () => {
    for (const key of NOSE_KEYS) {
      const noseDef = Noses[key]!
      expect(() => noseDef.render("#27272a")).not.toThrow()
    }
  })
})

describe("BG_COLORS", () => {
  it("has at least the 16 newly added palette entries (8 + 8 across two rounds)", () => {
    expect(BG_COLORS.length).toBeGreaterThanOrEqual(28)
  })

  it("every entry has a 3-stop gradient and a face color", () => {
    for (const c of BG_COLORS) {
      expect(c.gradient).toHaveLength(3)
      expect(typeof c.faceColor).toBe("string")
      expect(c.faceColor.length).toBeGreaterThan(0)
    }
  })
})

describe("randomConfig", () => {
  it("always returns keys/index present in the (expanded) lookup tables", () => {
    for (let i = 0; i < 50; i++) {
      const cfg = randomConfig()
      expect(SHAPE_KEYS).toContain(cfg.shape)
      expect(EYE_KEYS).toContain(cfg.eye)
      expect(NOSE_KEYS).toContain(cfg.nose)
      expect(cfg.bg).toBeGreaterThanOrEqual(0)
      expect(cfg.bg).toBeLessThan(BG_COLORS.length)
    }
  })
})

describe("configFromName", () => {
  it("is deterministic for the same name", () => {
    expect(configFromName("alook-bot")).toEqual(configFromName("alook-bot"))
  })

  it("always returns keys/index present in the (expanded) lookup tables", () => {
    for (const name of ["alice", "bob", "charlie", "delta-agent", "email-bot", "z"]) {
      const cfg = configFromName(name)
      expect(SHAPE_KEYS).toContain(cfg.shape)
      expect(EYE_KEYS).toContain(cfg.eye)
      expect(NOSE_KEYS).toContain(cfg.nose)
      expect(cfg.bg).toBeGreaterThanOrEqual(0)
      expect(cfg.bg).toBeLessThan(BG_COLORS.length)
    }
  })
})

describe("PRESETS", () => {
  it("every preset references valid shape/eye/nose keys and a valid bg index", () => {
    for (const preset of PRESETS) {
      expect(SHAPE_KEYS).toContain(preset.config.shape)
      expect(EYE_KEYS).toContain(preset.config.eye)
      expect(NOSE_KEYS).toContain(preset.config.nose)
      expect(preset.config.bg).toBeGreaterThanOrEqual(0)
      expect(preset.config.bg).toBeLessThan(BG_COLORS.length)
    }
  })

  it("includes the new presets built from the new parts", () => {
    const names = PRESETS.map((p) => p.name)
    expect(names).toEqual(
      expect.arrayContaining([
        "Chat", "Guard", "Adore", "Shine", "Energy", "Milestone", "Growth", "Flow",
        "Champion", "Royalty", "Launch", "Night", "Sharp", "Precious",
      ])
    )
  })
})

describe("isPhotoAvatarUrl", () => {
  it("recognizes https URLs, http URLs, and leading-/ routable paths as photos", () => {
    expect(isPhotoAvatarUrl("https://cdn.example.com/a.png")).toBe(true)
    expect(isPhotoAvatarUrl("http://cdn.example.com/a.png")).toBe(true)
    expect(isPhotoAvatarUrl("/api/community/users/u1/avatar")).toBe(true)
  })

  it("rejects null, undefined, empty string, and avatar: configs", () => {
    expect(isPhotoAvatarUrl(null)).toBe(false)
    expect(isPhotoAvatarUrl(undefined)).toBe(false)
    expect(isPhotoAvatarUrl("")).toBe(false)
    expect(isPhotoAvatarUrl("avatar:shape=star")).toBe(false)
  })

  it("rejects a avatar:beam seed (procedural, not a photo — bot-picker regression)", () => {
    expect(isPhotoAvatarUrl("avatar:beam:some-seed")).toBe(false)
  })
})

describe("star shape", () => {
  it("uses rounded (curved) corners instead of sharp straight-line points", () => {
    const markup = renderToStaticMarkup(Shapes.star!.render() as React.ReactElement)
    const d = markup.match(/d="([^"]+)"/)?.[1] ?? ""
    expect(d).toContain("Q")
    // A pure straight-edge polygon star would have no curve commands at all.
    expect(d.match(/Q/g)?.length).toBeGreaterThanOrEqual(10)
  })
})
