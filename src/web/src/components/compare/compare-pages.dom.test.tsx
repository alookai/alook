import type { ComponentProps } from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@/test/react-dom-harness"
import { COMPARE_PAGES, getComparisonPage } from "@/lib/compare"
import { CompareDetailView } from "./compare-detail-view"
import { CompareHubView } from "./compare-hub-view"

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : String(href)} {...props}>{children}</a>
  ),
}))
vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}))
vi.mock("@/lib/analytics", () => ({
  trackLandingCtaClicked: vi.fn(),
  trackGithubOutboundClicked: vi.fn(),
}))

describe("Compare marketing pages", () => {
  it("renders every comparison entry on /compare with JSON-LD", () => {
    const { container } = render(<CompareHubView />)
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Alook vs\. other AI agents/i)
    for (const item of COMPARE_PAGES) {
      const link = container.querySelector(`a[href="/compare/${item.slug}"]`)
      expect(link).not.toBeNull()
    }
    const schema = container.querySelector('script[type="application/ld+json"]')?.textContent ?? ""
    expect(schema).toContain('"CollectionPage"')
    expect(schema).toContain('"ItemList"')
    expect(schema).toContain('"BreadcrumbList"')
  })

  it("renders honest two-sided verdict, comparison table, runtime links, and FAQ on /compare/[slug]", () => {
    const page = getComparisonPage("alook-vs-myclaw")!
    const { container } = render(<CompareDetailView page={page} />)

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Alook vs MyClaw")
    expect(screen.getByText("Choose Alook when")).toBeVisible()
    expect(screen.getByText("Choose MyClaw when")).toBeVisible()

    const table = screen.getByRole("table")
    expect(within(table).getAllByRole("row")).toHaveLength(page.rows.length + 1)

    for (const slug of page.featuredAgentSlugs) {
      expect(container.querySelector(`a[href="/agents/${slug}"]`)).not.toBeNull()
    }

    const schema = container.querySelector('script[type="application/ld+json"]')?.textContent ?? ""
    expect(schema).toContain('"WebPage"')
    expect(schema).toContain('"FAQPage"')
    expect(schema).toContain('"BreadcrumbList"')
  })
})
