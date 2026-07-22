import { describe, it, expect } from "vitest"
import { AgentAvatar } from "./agent-avatar"
import { BoringAvatar } from "./boring-avatar"
import { serializeBeamSeed } from "@/lib/avatar/seed-url"

// A legacy procedural config value (the format the removed engine used to
// store) — the renderer must ignore it and fall back to an id-seeded beam.
const LEGACY_CONFIG = 'avatar:{"shape":"book","eye":"happy","nose":"dash","bg":1}'

type ImgEl = { type: "img"; props: { src: string; alt: string; style: { width: number; height: number } } }
type BeamEl = { type: typeof BoringAvatar; props: { seed: string; size: number } }

describe("AgentAvatar", () => {
  it("renders an <img> for a photo URL (https)", () => {
    const el = AgentAvatar({ name: "Bot", avatarUrl: "https://cdn.example.com/a.png", size: 40 }) as unknown as ImgEl
    expect(el.type).toBe("img")
    expect(el.props.src).toBe("https://cdn.example.com/a.png")
    expect(el.props.style).toEqual({ width: 40, height: 40 })
  })

  it("renders an <img> for a routable leading-/ avatar URL (bot/user avatar routes)", () => {
    const el = AgentAvatar({
      name: "Bot",
      avatarUrl: "/api/community/bots/b1/avatar",
      size: 24,
    }) as unknown as ImgEl
    expect(el.type).toBe("img")
    expect(el.props.src).toBe("/api/community/bots/b1/avatar")
  })

  it("renders beam with the stored seed for a avatar:beam value", () => {
    const el = AgentAvatar({ name: "Bot", avatarUrl: serializeBeamSeed("seed-123"), seed: "agent-1", size: 32 }) as unknown as BeamEl
    expect(el.type).toBe(BoringAvatar)
    expect(el.props.seed).toBe("seed-123")
    expect(el.props.size).toBe(32)
  })

  it("ignores a legacy avatar:{shape…} config and beams by the fallback seed", () => {
    const el = AgentAvatar({ name: "Bot", avatarUrl: LEGACY_CONFIG, seed: "agent-1", size: 32 }) as unknown as BeamEl
    expect(el.type).toBe(BoringAvatar)
    expect(el.props.seed).toBe("agent-1")
  })

  it("beams by the id seed when avatarUrl is null", () => {
    const el = AgentAvatar({ name: "Zara", avatarUrl: null, seed: "agent-9", size: 32 }) as unknown as BeamEl
    expect(el.type).toBe(BoringAvatar)
    expect(el.props.seed).toBe("agent-9")
  })

  it("falls back to name as seed when no id, and '?' when nothing", () => {
    const byName = AgentAvatar({ name: "Zara", avatarUrl: null }) as unknown as BeamEl
    expect(byName.props.seed).toBe("Zara")
    const empty = AgentAvatar({}) as unknown as BeamEl
    expect(empty.props.seed).toBe("?")
  })
})
