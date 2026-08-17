import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { FAQ_PAGE_SCHEMA, HOME_FAQS } from "./landing-content"

function componentSource() {
  return readFileSync(new URL("./homepage-faq.tsx", import.meta.url), "utf8")
}

function stylesSource() {
  return readFileSync(new URL("./landing-page.module.css", import.meta.url), "utf8")
}

describe("HomepageFaq", () => {
  it("renders all approved questions as native disclosure controls", () => {
    const source = componentSource()

    expect(HOME_FAQS).toHaveLength(8)
    expect(source).toContain('data-testid="landing-faq"')
    expect(source).toContain('aria-labelledby="homepage-faq-heading"')
    expect(source).toContain("HOME_FAQS.map")
    expect(source).toContain("<details")
    expect(source).toContain("<summary>")
    expect(HOME_FAQS.every(({ answer }) => answer.split(/\s+/).length <= 60)).toBe(true)
  })

  it("keeps FAQPage structured data identical to the visible content", () => {
    expect(FAQ_PAGE_SCHEMA).toMatchObject({
      "@context": "https://schema.org",
      "@type": "FAQPage",
    })
    expect(FAQ_PAGE_SCHEMA.mainEntity).toEqual(
      HOME_FAQS.map(({ question, answer }) => ({
        "@type": "Question",
        name: question,
        acceptedAnswer: {
          "@type": "Answer",
          text: answer,
        },
      })),
    )

    const source = componentSource()
    expect(source).toContain('type="application/ld+json"')
    expect(source).toContain("JSON.stringify(FAQ_PAGE_SCHEMA)")
    expect(source).toContain("dangerouslySetInnerHTML")
  })

  it("keeps the landing interaction and responsive spacing contracts", () => {
    const styles = stylesSource()

    expect(styles).toMatch(/\.faqIntro h2\s*\{[^}]*text-wrap:\s*balance;/s)
    expect(styles).toMatch(/\.faqItem summary\s*\{[^}]*padding-block:\s*16px;/s)
    expect(styles).toMatch(/\.faqItem summary\s*\{[^}]*touch-action:\s*manipulation;/s)
    expect(styles).toMatch(/@media \(max-width: 639px\)[\s\S]*?\.faqItem summary\s*\{[^}]*min-height:\s*80px;/s)
  })
})
