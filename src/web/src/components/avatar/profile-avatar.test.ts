import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { serializeBeamSeed } from "@/lib/avatar/seed-url"
import { ProfileAvatar, type ProfileAvatarProps } from "./profile-avatar"

function normalize(html: string): string {
  return html.replace(/_R_[0-9a-z]+_/g, "_ID_").replace(/#[0-9a-z]+_ID_/g, "#_ID_")
}

function render(props: ProfileAvatarProps): string {
  return renderToStaticMarkup(createElement(ProfileAvatar, props))
}

describe("ProfileAvatar", () => {
  it("mounts a photo immediately without showing the loading fallback", () => {
    const html = render({
      label: "Ada",
      src: "https://cdn.example.com/ada.png",
      seed: "user_1",
      size: 40,
      className: "ring-2",
      "data-testid": "profile-avatar",
    })

    expect(html).toContain('data-testid="profile-avatar"')
    expect(html).toContain('data-avatar-kind="photo"')
    expect(html).toContain('<img data-slot="avatar-image" src="https://cdn.example.com/ada.png" alt="Ada"')
    expect(html).not.toContain('data-slot="avatar-fallback"')
    expect(html).toContain("width:40px;height:40px")
    expect(html).toContain("ring-2")
  })

  it("renders a stored beam seed without emitting an image or fallback", () => {
    const html = render({
      label: "Ada",
      src: serializeBeamSeed("stored-seed"),
      seed: "user_1",
    })

    expect(html).toContain("<svg")
    expect(html).not.toContain("<img")
    expect(html).not.toContain('data-slot="avatar-fallback"')
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="Ada"')
  })

  it("uses the stable id for a missing avatar and stays unchanged across rename", () => {
    const before = normalize(render({ label: "Ada", src: null, seed: "user_1" }))
    const after = normalize(render({ label: "Adelaide", src: null, seed: "user_1" }))

    expect(before).toContain("<svg")
    expect(after.replace('aria-label="Adelaide"', 'aria-label="Ada"')).toBe(before)
  })

  it("uses one letter only when neither avatar nor stable id is available", () => {
    const html = render({ label: "Ada", src: null })

    expect(html).toContain('data-slot="avatar-fallback"')
    expect(html).toContain(">A<")
    expect(html).not.toContain("<svg")
  })

  it("honors decorative alt text and dimming", () => {
    const html = render({
      label: "Ada",
      src: "/api/avatar",
      seed: "user_1",
      alt: "",
      dim: true,
    })

    expect(html).toContain('data-avatar-kind="photo"')
    expect(html).toContain('<img data-slot="avatar-image" src="/api/avatar" alt=""')
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('role="img"')
    expect(html).not.toContain("aria-label")
    expect(html).toContain("opacity:0.4")
  })

  it("makes generated avatars decorative without exposing their source", () => {
    const source = serializeBeamSeed("private-seed")
    const html = render({ label: source, src: source, seed: "user_1", alt: "" })

    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('role="img"')
    expect(html).not.toContain("aria-label")
    expect(html).not.toContain(source)
  })
})
