import { describe, it, expect } from "vitest"
import { AgentAvatar } from "./agent-avatar"
import { AvatarRenderer, serializeAvatarConfig, DEFAULT_CONFIG } from "./avatar-parts"

type ImgEl = { type: "img"; props: { src: string; alt: string; style: { width: number; height: number } } }
type SpanEl = { type: "span"; props: { children: string; style: { width: number; height: number } } }
type RendererEl = { type: typeof AvatarRenderer; props: { size: number } }

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

  it("renders AvatarRenderer for a procedural avatar: config", () => {
    const url = serializeAvatarConfig(DEFAULT_CONFIG)
    const el = AgentAvatar({ name: "Bot", avatarUrl: url, size: 32 }) as unknown as RendererEl
    expect(el.type).toBe(AvatarRenderer)
    expect(el.props.size).toBe(32)
  })

  it("falls back to the initial-letter span when avatarUrl is null/undefined", () => {
    const el = AgentAvatar({ name: "Zara", avatarUrl: null, size: 32 }) as unknown as SpanEl
    expect(el.type).toBe("span")
    expect(el.props.children).toBe("Z")
  })

  it("falls back to '?' when both name and avatarUrl are missing", () => {
    const el = AgentAvatar({}) as unknown as SpanEl
    expect(el.type).toBe("span")
    expect(el.props.children).toBe("?")
  })
})
