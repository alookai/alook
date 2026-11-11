import { createElement } from "react"
import { render, screen } from "@/test/react-dom-harness"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LandingTestimonials } from "./landing-testimonials"
import { rankTestimonials, type LandingTestimonial } from "./landing-testimonials-data"

const { posts } = vi.hoisted(() => ({ posts: [] as LandingTestimonial[] }))
vi.mock("./landing-testimonials-data", async (importOriginal) => ({
  ...await importOriginal<typeof import("./landing-testimonials-data")>(),
  LANDING_TESTIMONIALS: posts,
}))

function post(id: string, followers: number | null): LandingTestimonial {
  return {
    id, followers, name: `Author ${id}`, handle: `author${id}`,
    quote: `Test-only quotation ${id}.`, url: `https://x.com/author${id}/status/${id}`,
    checkedAt: "2026-10-21",
  }
}

afterEach(() => { posts.length = 0 })

describe("landing testimonials", () => {
  it("ranks known follower counts ahead of unknown counts without changing the source", () => {
    const source = [post("1", null), post("2", 0), post("3", 200), post("4", 100)]
    expect(rankTestimonials(source).map(({ id }) => id)).toEqual(["3", "4", "2", "1"])
    expect(source.map(({ id }) => id)).toEqual(["1", "2", "3", "4"])
  })

  it("does not present endorsements before real source data is available", () => {
    const { container } = render(createElement(LandingTestimonials))
    expect(container.childElementCount).toBe(0)
  })

  it("exposes all20 original sources once in follower order without extra controls", () => {
    posts.push(...Array.from({ length: 20 }, (_, i) => post(String(i + 1), i * 100)))
    const { container } = render(createElement(LandingTestimonials))
    const links = screen.getAllByRole("link")
    expect(links).toHaveLength(20)
    expect(links.map((link) => link.getAttribute("href"))).toEqual(rankTestimonials(posts).map(({ url }) => url))
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank")
      expect(link.getAttribute("rel")).toBe("noopener noreferrer")
      expect(link.getAttribute("tabindex")).toBeNull()
    }
    expect(screen.getAllByRole("listitem")).toHaveLength(20)
    expect(container.querySelector("button, details, iframe, script")).toBeNull()
    // The loop copy repeats each lane once for the seamless pan; it stays out of reach.
    const copies = Array.from(container.querySelectorAll("li[data-loop-copy]"))
    expect(copies).toHaveLength(20)
    for (const copy of copies) {
      expect(copy.getAttribute("aria-hidden")).toBe("true")
      expect(copy.hasAttribute("inert")).toBe(true)
    }
    expect(container.querySelectorAll("li:not([data-loop-copy]) blockquote")).toHaveLength(20)
    expect(container.querySelectorAll('li:not([data-loop-copy]) [aria-hidden="true"] a')).toHaveLength(0)
    expect(container.querySelectorAll("li:not([data-loop-copy]) [data-message-author-line]")).toHaveLength(20)
  })
})
