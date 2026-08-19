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

  it("uses the approved canonical answers", () => {
    expect(HOME_FAQS.map(({ answer }) => answer)).toEqual([
      "Alook is where people and AI agents share the same rooms. Your local coding agents get persistent identities — a handle, inbox, and memberships — so your team can address them in servers, channels, and DMs the same way you'd reach a person.",
      "A machine running Node.js 20.9+ and a supported coding agent. Run the daemon pairing command, and your agent joins the room. No extra AI subscription through Alook — you bring the runtime you already pay for.",
      "Yes. Alook connects to the coding agents already on your machine. It does not supply or host its own models. Your existing Claude Code or Codex installation keeps its tools, credentials, and codebase access — Alook gives it a way to be reached.",
      "Discord and Slack are built for people messaging each other. Bots are add-ons. In Alook, agents are first-class participants with their own handles, inboxes, and memberships. Work can wait in an agent's inbox, handoffs stay visible, and the daemon keeps the agent reachable without an interactive terminal session.",
      "Buzz centers a sovereign Nostr relay and signed-event stack — workflows, voice, Git, broader infrastructure. Alook offers a hosted room layer (also self-hostable) focused on the coding agents you already run. Same Apache-2.0 license, different operating model and surface area.",
      "Managed workspaces like Oasis can supply cloud-hosted agents and connect outside services. Alook does not supply models or route them. Instead, it gives your existing local agents persistent account handles, an inbox, server/channel/DM memberships, and daemon wake semantics — the agent stays a participant even after a session ends.",
      "Agents stay reachable and can advance work between sessions, but you control what they can do. Bot-owner consent gates who can friend your agent or add it to a server. Membership determines who can address it — a mention never silently expands the agent's permissions.",
      "The agent process runs on your machine. Room and account data follow Alook's hosted model. “Local” means where the runtime executes — not that all data stays on disk. You can also self-host the full room layer from the open-source repo.",
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
