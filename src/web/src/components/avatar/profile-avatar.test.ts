import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { JSDOM } from "jsdom"
import { within } from "@testing-library/react/pure"
import { afterEach, describe, expect, it } from "vitest"
import { serializeBeamSeed } from "@/lib/avatar/seed-url"
import { ProfileAvatar, type ProfileAvatarProps } from "./profile-avatar"

const closeDocuments = new Set<() => void>()

afterEach(() => {
  for (const close of closeDocuments) close()
  closeDocuments.clear()
})

function normalize(html: string): string {
  return html.replace(/_R_[0-9a-z]+_/g, "_ID_").replace(/#[0-9a-z]+_ID_/g, "#_ID_")
}

function render(props: ProfileAvatarProps) {
  expect(typeof globalThis.window).toBe("undefined")
  expect(typeof globalThis.document).toBe("undefined")
  const markup = renderToStaticMarkup(createElement(ProfileAvatar, props))
  const dom = new JSDOM(markup)
  closeDocuments.add(() => dom.window.close())
  expect(typeof globalThis.window).toBe("undefined")
  expect(typeof globalThis.document).toBe("undefined")
  const container = dom.window.document.body
  return { container, markup, view: within(container) }
}

describe("ProfileAvatar", () => {
  it("emits a photo and pending placeholder at the supplied size", () => {
    const { view, container } = render({
      label: "Ada", src: "https://cdn.example.com/ada.png", seed: "user_1",
      size: 40, "data-testid": "profile-avatar",
    })
    expect(view.getByRole("img", { name: "Ada" }).getAttribute("src")).toBe("https://cdn.example.com/ada.png")
    const avatar = view.getByTestId("profile-avatar")
    expect(avatar.style.width).toBe("40px")
    expect(avatar.style.height).toBe("40px")
    expect(container.querySelector('[data-slot="avatar-photo-placeholder"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="avatar-fallback"]')).toBeNull()
    expect(view.queryByText("A", { exact: true })).toBeNull()
  })

  it("renders a stored beam seed without emitting an image or fallback", () => {
    const { view, container } = render({ label: "Ada", src: serializeBeamSeed("stored-seed"), seed: "user_1" })
    expect(view.getByRole("img", { name: "Ada" })).not.toBeNull()
    expect(container.querySelector("svg")).not.toBeNull()
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector('[data-slot="avatar-fallback"]')).toBeNull()
  })

  it("uses the stable id for a missing avatar and stays unchanged across rename", () => {
    const before = render({ label: "Ada", src: null, seed: "user_1" })
    const after = render({ label: "Adelaide", src: null, seed: "user_1" })
    expect(before.view.getByRole("img", { name: "Ada" })).not.toBeNull()
    expect(after.view.getByRole("img", { name: "Adelaide" })).not.toBeNull()
    const beforeArt = before.container.querySelector("svg")
    const afterArt = after.container.querySelector("svg")
    expect(beforeArt).not.toBeNull()
    expect(afterArt).not.toBeNull()
    expect(normalize(afterArt!.outerHTML)).toBe(normalize(beforeArt!.outerHTML))
  })

  it("uses one letter only when neither avatar nor stable id is available", () => {
    const { view, container } = render({ label: "Ada", src: null })
    expect(view.getByRole("img", { name: "Ada" })).not.toBeNull()
    expect(view.getByText("A", { exact: true })).not.toBeNull()
    expect(container.querySelector("svg")).toBeNull()
    expect(container.querySelector("img")).toBeNull()
  })

  it("honors decorative alt text and dimming", () => {
    const { view, container } = render({ label: "Ada", src: "/api/avatar", seed: "user_1", alt: "", dim: true })
    expect(view.queryByRole("img")).toBeNull()
    const photo = container.querySelector("img")
    expect(photo?.getAttribute("src")).toBe("/api/avatar")
    expect(photo?.getAttribute("alt")).toBe("")
    expect(container.querySelector('[data-slot="avatar-fallback"]')).toBeNull()
    const opacity = Number((container.querySelector('[data-slot="avatar"]') as HTMLElement).style.opacity)
    expect(opacity).toBeGreaterThan(0)
    expect(opacity).toBeLessThan(1)
  })

  it("makes generated avatars decorative without exposing their source", () => {
    const source = serializeBeamSeed("private-seed")
    const { view, container, markup } = render({ label: source, src: source, seed: "user_1", alt: "" })
    expect(container.querySelector("svg")).not.toBeNull()
    expect(view.queryByRole("img")).toBeNull()
    expect(container.textContent).not.toContain(source)
    expect(markup).not.toContain(source)
  })
})
