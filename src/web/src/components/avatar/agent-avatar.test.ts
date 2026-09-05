import { describe, it, expect } from "vitest"
import { AgentAvatar } from "./agent-avatar"
import { GeneratedAvatar } from "./generated-avatar"
import { serializeBeamSeed } from "@/lib/avatar/seed-url"
import { RemoteIdentityImage } from "@/components/remote-image/remote-image"

// A legacy procedural config value (the format the removed engine used to
// store) — the renderer must ignore it and fall back to an id-seeded beam.
const LEGACY_CONFIG = 'avatar:{"shape":"book","eye":"happy","nose":"dash","bg":1}'

type PhotoEl = {
  type: "span"
  props: {
    className: string
    style: { width: number; height: number }
    children: { type: typeof RemoteIdentityImage; props: { src: string; alt: string } }
  }
}
type BeamEl = { type: typeof GeneratedAvatar; props: { seed: string; size: number } }

describe("AgentAvatar", () => {
  it("renders the shared identity state for a photo URL (https)", () => {
    const el = AgentAvatar({ name: "Bot", avatarUrl: "https://cdn.example.com/a.png", size: 40 }) as unknown as PhotoEl
    expect(el.type).toBe("span")
    expect(el.props.children.type).toBe(RemoteIdentityImage)
    expect(el.props.children.props.src).toBe("https://cdn.example.com/a.png")
    expect(el.props.style).toEqual({ width: 40, height: 40 })
  })

  it("renders the shared identity state for a routable leading-/ avatar URL", () => {
    const el = AgentAvatar({
      name: "Bot",
      avatarUrl: "/api/community/bots/b1/avatar",
      size: 24,
    }) as unknown as PhotoEl
    expect(el.props.children.type).toBe(RemoteIdentityImage)
    expect(el.props.children.props.src).toBe("/api/community/bots/b1/avatar")
  })

  it("renders beam with the stored seed for a avatar:beam value", () => {
    const el = AgentAvatar({ name: "Bot", avatarUrl: serializeBeamSeed("seed-123"), seed: "agent-1", size: 32 }) as unknown as BeamEl
    expect(el.type).toBe(GeneratedAvatar)
    expect(el.props.seed).toBe("seed-123")
    expect(el.props.size).toBe(32)
  })

  it("ignores a legacy avatar:{shape…} config and beams by the fallback seed", () => {
    const el = AgentAvatar({ name: "Bot", avatarUrl: LEGACY_CONFIG, seed: "agent-1", size: 32 }) as unknown as BeamEl
    expect(el.type).toBe(GeneratedAvatar)
    expect(el.props.seed).toBe("agent-1")
  })

  it("beams by the id seed when avatarUrl is null", () => {
    const el = AgentAvatar({ name: "Zara", avatarUrl: null, seed: "agent-9", size: 32 }) as unknown as BeamEl
    expect(el.type).toBe(GeneratedAvatar)
    expect(el.props.seed).toBe("agent-9")
  })

  it("falls back to name as seed when no id, and '?' when nothing", () => {
    const byName = AgentAvatar({ name: "Zara", avatarUrl: null }) as unknown as BeamEl
    expect(byName.props.seed).toBe("Zara")
    const empty = AgentAvatar({}) as unknown as BeamEl
    expect(empty.props.seed).toBe("?")
  })

  it("applies one caller-owned shape consistently to photos and generated avatars", () => {
    const photo = AgentAvatar({
      name: "Bot",
      avatarUrl: "/api/avatar",
      className: "rounded-xl",
      alt: "",
    }) as unknown as PhotoEl
    const generated = AgentAvatar({
      name: "Bot",
      seed: "bot-id",
      className: "rounded-xl",
    }) as unknown as BeamEl & { props: { className: string } }
    expect(photo.props.className).toContain("rounded-xl")
    expect(photo.props.className).not.toContain("rounded-full")
    expect(photo.props.children.props.alt).toBe("")
    expect(generated.props.className).toContain("rounded-xl")
    expect(generated.props.className).not.toContain("rounded-full")
  })
})
