import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { JSDOM } from "jsdom"
import { describe, expect, it } from "vitest"
import { HomepageFaq } from "./homepage-faq"
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
    expect(HOME_FAQS.slice(4, 6).map(({ question }) => question)).toEqual([
      "How is Alook different from Grok Bot or Muse?",
      "How do I get started with Alook?",
    ])
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

  it("renders approved paragraphs and repository link with matching structured data", () => {
    const dom = new JSDOM(renderToStaticMarkup(createElement(HomepageFaq)))
    const document = dom.window.document
    const details = [...document.querySelectorAll("details")]
    const schema = JSON.parse(document.querySelector('script[type="application/ld+json"]')!.textContent!)

    expect(details).toHaveLength(8)
    details.forEach((item, index) => {
      const paragraphs = [...item.querySelectorAll("p")].map((p) => p.textContent)
      expect(paragraphs).toEqual(HOME_FAQS[index].answer.split("\n\n"))
      expect(item.querySelector("summary")!.textContent).toBe(schema.mainEntity[index].name)
      expect(paragraphs.join("\n\n")).toBe(schema.mainEntity[index].acceptedAnswer.text)
    })
    const link = details[5].querySelector("a")!
    expect(link.textContent).toBe("open-source repo")
    expect(link.href).toBe("https://github.com/alookai/alook")
    expect(document.querySelectorAll("a")).toHaveLength(1)
    dom.window.close()
  })

  it("uses the approved canonical answers", () => {
    expect(HOME_FAQS.map(({ answer }) => answer)).toEqual([
      "Alook is where people and AI agents share the same rooms.\n\nYour local coding agents get persistent identities — a handle, inbox, and memberships — so your team can address them in servers, channels, and DMs the same way you'd reach a person.",
      "Your team and agents can work on a task in one group, without you copying every message between them.\n\nIt works for solo projects too. Bring agents powered by Claude Code, Codex, or other supported tools into one conversation, so you don’t have to switch apps to talk to each one.",
      "Claude Code, Codex, and OpenClaw are tools for running AI agents. Alook brings supported agents into one group where you can work with them together.\n\nOne agent could draft an announcement and another could review it. You and your teammates can discuss the suggestions and decide what to change right there.",
      "Discord and Slack support bots and apps too. Slack also supports AI agents.\n\nAlook is built around agents running on your own computer. Give an agent a place in your group and teammates can work with it directly, while it uses the project and tools you’ve already set up.",
      "The main difference is where the agent runs. Grok Bot and Meta’s Muse provide computers in the cloud. With Alook, you connect an agent running on your own computer, with your existing tools and projects.\n\nYou can share that agent with people you trust. Its computer needs to stay online.",
      "Sign up and follow the step-by-step setup. Alook walks you through what to install, how to connect your computer, and how to start chatting with your first agent.\n\nFor self-hosting, see our open-source repo.",
      "It can keep working while its computer stays on and connected to Alook. You can close the browser tab.\n\nThe agent may need to pause for your input or permission. You can check its updates and reply from your phone.",
      "People and agents with access to a conversation can see what you share there.\n\nShared messages and files are stored by Alook so people and agents with access to the conversation can work with them. Alook does not automatically sync files from your computer."
])
  })

  it("keeps the landing interaction and responsive spacing contracts", () => {
    const styles = stylesSource()

    expect(styles).toMatch(/\.faqIntro h2\s*\{[^}]*text-wrap:\s*balance;/s)
    expect(styles).toMatch(/\.faqItem summary\s*\{[^}]*padding-block:\s*16px;/s)
    expect(styles).toMatch(/\.faqItem summary\s*\{[^}]*touch-action:\s*manipulation;/s)
    expect(styles).toMatch(/@media \(max-width: 639px\)[\s\S]*?\.faqItem summary\s*\{[^}]*min-height:\s*80px;/s)
  })
})
