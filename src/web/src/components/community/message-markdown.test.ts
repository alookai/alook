import { describe, it, expect, vi } from "vitest"
import {
  extractInviteTokens,
  mentionNameFromText,
  buildMdComponents,
  MD_COMPONENTS,
} from "./message-markdown"

// `components.mention(...)` returns a plain React element (JSX under the
// hood) — inspecting `.props` here reaches into the MentionPill it wraps
// without a jsdom/testing-library render pass (this repo runs vitest under
// node, see the other describe blocks in this file).
type MentionElement = { props: { onClick?: (e: unknown) => void } }

describe("mentionNameFromText", () => {
  it("strips the leading @", () => {
    expect(mentionNameFromText("@Gus")).toBe("Gus")
  })

  it("strips a trailing #0042 discriminator", () => {
    expect(mentionNameFromText("@Gus#0042")).toBe("Gus")
  })

  it("leaves a 5+ digit trailing run alone (not a valid discriminator)", () => {
    expect(mentionNameFromText("@Gus#00423")).toBe("Gus#00423")
  })

  it("leaves @everyone / @here as-is (no discriminator to strip)", () => {
    expect(mentionNameFromText("@everyone")).toBe("everyone")
    expect(mentionNameFromText("@here")).toBe("here")
  })
})

describe("buildMdComponents — mention pill onClick wiring", () => {
  it("wires onClick to call onOpenProfile with the name (no @, no #dddd) and no discriminator when the tag wasn't stashed", () => {
    const onOpenProfile = vi.fn()
    const components = buildMdComponents(onOpenProfile)
    const el = components.mention({ children: "@Gus#0042" }) as unknown as MentionElement
    const fakeEvent = {} as never
    el.props.onClick?.(fakeEvent)
    expect(onOpenProfile).toHaveBeenCalledWith("Gus", fakeEvent, undefined)
  })

  it("forwards the stashed data-tag discriminator so same-named members can be disambiguated", () => {
    const onOpenProfile = vi.fn()
    const components = buildMdComponents(onOpenProfile)
    const el = components.mention({ children: "@Gus", "data-tag": "0042" }) as unknown as MentionElement
    const fakeEvent = {} as never
    el.props.onClick?.(fakeEvent)
    expect(onOpenProfile).toHaveBeenCalledWith("Gus", fakeEvent, "0042")
  })

  it("does not wire onClick for @everyone / @here", () => {
    const onOpenProfile = vi.fn()
    const components = buildMdComponents(onOpenProfile)
    const el = components.mention({ children: "@everyone", "data-everyone": "1" }) as unknown as MentionElement
    expect(el.props.onClick).toBeUndefined()
  })

  it("has no onClick when no onOpenProfile callback is given", () => {
    const components = buildMdComponents(undefined)
    const el = components.mention({ children: "@Gus" }) as unknown as MentionElement
    expect(el.props.onClick).toBeUndefined()
  })

  it("MD_COMPONENTS.mention (the static, no-callback default) has no onClick", () => {
    const el = MD_COMPONENTS.mention({ children: "@Gus" }) as unknown as MentionElement
    expect(el.props.onClick).toBeUndefined()
  })
})

describe("extractInviteTokens", () => {
  it("extracts a bare-path token", () => {
    expect(extractInviteTokens("join /c/invite/abc123XYZ")).toEqual(["abc123XYZ"])
  })

  it("extracts a full-origin URL token", () => {
    expect(extractInviteTokens("https://alook.ai/c/invite/xY9k2vW7aQ")).toEqual([
      "xY9k2vW7aQ",
    ])
  })

  it("extracts tokens with underscore/dash (nanoid alphabet)", () => {
    expect(extractInviteTokens("/c/invite/ab_cd-EF12")).toEqual(["ab_cd-EF12"])
  })

  it("dedupes repeated tokens in the same message", () => {
    expect(
      extractInviteTokens(
        "/c/invite/abc123XYZ /c/invite/abc123XYZ /c/invite/other456",
      ),
    ).toEqual(["abc123XYZ", "other456"])
  })

  it("ignores tokens below the 6-char floor", () => {
    expect(extractInviteTokens("/c/invite/abc")).toEqual([])
  })

  it("returns [] when the message has no invite URL", () => {
    expect(extractInviteTokens("hello world")).toEqual([])
  })
})
