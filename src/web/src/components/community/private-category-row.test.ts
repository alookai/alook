import { describe, it, expect, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { PrivateCategoryRow } from "./private-category-row"
import {
  PRIVATE_CATEGORY_LABEL,
  PRIVATE_CATEGORY_DESC_PRIVATE,
  PRIVATE_CATEGORY_DESC_PUBLIC,
  PRIVATE_CATEGORY_LOCKED_SUFFIX,
} from "@/lib/community/category-copy"

const render = (props: Parameters<typeof PrivateCategoryRow>[0]) =>
  renderToStaticMarkup(createElement(PrivateCategoryRow, props))

describe("PrivateCategoryRow", () => {
  it("always renders the shared label", () => {
    expect(render({ isPrivate: false })).toContain(PRIVATE_CATEGORY_LABEL)
  })

  it("shows the public copy when not private", () => {
    const html = render({ isPrivate: false, onToggle: vi.fn() })
    expect(html).toContain(PRIVATE_CATEGORY_DESC_PUBLIC)
    expect(html).not.toContain(PRIVATE_CATEGORY_DESC_PRIVATE)
  })

  it("shows the private copy when private", () => {
    const html = render({ isPrivate: true, onToggle: vi.fn() })
    expect(html).toContain(PRIVATE_CATEGORY_DESC_PRIVATE)
    expect(html).not.toContain(PRIVATE_CATEGORY_DESC_PUBLIC)
  })

  it("renders a Switch when onToggle is provided", () => {
    expect(render({ isPrivate: false, onToggle: vi.fn() })).toContain('data-slot="switch"')
  })

  it("hides the Switch and appends the locked suffix in read-only mode", () => {
    const html = render({ isPrivate: true, locked: true })
    expect(html).not.toContain('data-slot="switch"')
    expect(html).toContain(PRIVATE_CATEGORY_DESC_PRIVATE)
    expect(html).toContain(PRIVATE_CATEGORY_LOCKED_SUFFIX)
  })

  it("draws its copy from the shared constants (same private string both dialogs use)", () => {
    expect(PRIVATE_CATEGORY_DESC_PRIVATE).toBe(
      "Members create their own channels here, visible only to invited members.",
    )
    expect(PRIVATE_CATEGORY_DESC_PUBLIC).toBe(
      "Channels here are admin-managed and visible to everyone.",
    )
  })
})
