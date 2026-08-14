import { describe, it, expect, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { PrivateCategoryRow } from "./private-category-row"
import {
  PRIVATE_CATEGORY_LABEL,
  PRIVATE_CATEGORY_DESC,
  PRIVATE_CATEGORY_LOCKED_SUFFIX,
} from "@/lib/community/category-copy"

const render = (props: Parameters<typeof PrivateCategoryRow>[0]) =>
  renderToStaticMarkup(createElement(PrivateCategoryRow, props))

describe("PrivateCategoryRow", () => {
  it("always renders the shared label", () => {
    expect(render({ isPrivate: false })).toContain(PRIVATE_CATEGORY_LABEL)
  })

  it("shows the fixed description regardless of toggle state", () => {
    expect(render({ isPrivate: false, onToggle: vi.fn() })).toContain(PRIVATE_CATEGORY_DESC)
    expect(render({ isPrivate: true, onToggle: vi.fn() })).toContain(PRIVATE_CATEGORY_DESC)
  })

  it("renders a Switch when onToggle is provided", () => {
    expect(render({ isPrivate: false, onToggle: vi.fn() })).toContain('data-slot="switch"')
  })

  it("hides the Switch and appends the locked suffix in read-only mode", () => {
    const html = render({ isPrivate: true, locked: true })
    expect(html).not.toContain('data-slot="switch"')
    expect(html).toContain(PRIVATE_CATEGORY_DESC)
    expect(html).toContain(PRIVATE_CATEGORY_LOCKED_SUFFIX)
  })

  it("does not claim admins can see private channels", () => {
    expect(PRIVATE_CATEGORY_DESC.toLowerCase()).not.toContain("admin")
  })

  it("draws its copy from the shared constant", () => {
    expect(PRIVATE_CATEGORY_DESC).toBe(
      "Making a category private limits it to invited members. Each stays visible only to its creator and invited members.",
    )
  })
})
