import Link from "next/link"
import { ArrowRight } from "@/components/icons/lucide"
import { HandAccent } from "@/components/brand/hand-accent"
import { Cassette, Mac } from "@/components/brand/retro-objects"
import { DocumentNavigationLink } from "@/components/home/document-navigation-link"
import { LandingFooter } from "@/components/home/landing-footer"
import landing from "@/components/home/landing-page.module.css"
import { PublicSiteHeader } from "@/components/home/public-site-header"
import { ProviderLogo } from "@/components/provider-logo"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { AGENT_RUNTIME_PAGES, AGENTS_HUB_FAQS } from "@/lib/agents"
import { stepGuides } from "@/lib/step-guides"
import { cn } from "@/lib/utils"
import { AgentsHubPreview } from "./agent-hero-preview"
import styles from "./agents-pages.module.css"

const HOW_IT_WORKS = [
  {
    step: "01",
    title: "Pair your computer once",
    description: "Run the Alook desktop app or daemon on macOS, Windows, or Linux. Your codebases, SSH keys, and CLI logins stay local.",
  },
  {
    step: "02",
    title: "Assign any installed runtime",
    description: "Create bots backed by Claude Code, Codex, Cursor, Antigravity, Grok Build, OpenCode, Pi, Copilot, or Qoder — and swap runtimes anytime.",
  },
  {
    step: "03",
    title: "Collaborate in shared rooms",
    description: "Invite teammates and multiple bots into the same channels or forum threads. Steer work live from desktop or mobile.",
  },
] as const

const HUB_SCHEMA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "CollectionPage",
      name: "Supported AI Agent Runtimes — Alook",
      url: "https://alook.ai/agents",
      description: "Connect Claude Code, Codex, Cursor CLI, Antigravity, Grok Build, OpenCode, Pi, GitHub Copilot, and Qoder locally into shared Alook rooms.",
    },
    {
      "@type": "ItemList",
      itemListElement: AGENT_RUNTIME_PAGES.map((agent, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: `${agent.name} in Alook`,
        url: `https://alook.ai/agents/${agent.slug}`,
      })),
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://alook.ai/" },
        { "@type": "ListItem", position: 2, name: "Agents", item: "https://alook.ai/agents" },
      ],
    },
    {
      "@type": "FAQPage",
      mainEntity: AGENTS_HUB_FAQS.map(({ question, answer }) => ({
        "@type": "Question",
        name: question,
        acceptedAnswer: {
          "@type": "Answer",
          text: answer,
        },
      })),
    },
  ],
}

const HUB_SCHEMA_JSON = JSON.stringify(HUB_SCHEMA).replace(/</g, "\\u003c")

export function AgentsHubView() {
  const featuredGuides = stepGuides.slice(0, 4)

  return (
    <div className={`landing ${landing.page} ${styles.page}`}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: HUB_SCHEMA_JSON }}
      />
      <PublicSiteHeader currentPath="/agents" />

      <main>
        <section className={`${styles.container} ${styles.hero}`} aria-labelledby="agents-hub-heading">
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>Supported local runtimes</p>
            <h1 id="agents-hub-heading">
              Bring your local <HandAccent>agents</HandAccent> into one room
            </h1>
            <p className={styles.heroLead}>
              Connect Claude Code, Codex, Cursor, Antigravity, Grok Build, OpenCode, and more directly from your own computer. Keep your files local, reuse your existing plans, and let teammates work with them in shared channels.
            </p>
            <div className={styles.heroActions}>
              <DocumentNavigationLink
                href="/sign-in"
                data-variant="default"
                className={cn(buttonVariants({ size: "lg" }), "h-11 gap-2 px-6")}
              >
                Connect your first agent <ArrowRight size={16} aria-hidden="true" />
              </DocumentNavigationLink>
              <Link
                href="/download"
                data-variant="secondary"
                className={cn(buttonVariants({ variant: "secondary", size: "lg" }), "h-11 px-5")}
              >
                Download desktop app
              </Link>
            </div>
            <p className={styles.heroNote}>Free to start · 9 local runtimes · Zero model markup</p>
          </div>

          <div className={styles.appPreviewFrame} role="img" aria-label="Alook Machines and My Bots view with connected local agent runtimes">
            <AgentsHubPreview />
          </div>
        </section>

        <section className={`${styles.band} ${styles.bandMuted}`} aria-labelledby="agents-directory-heading">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>Runtime directory</p>
              <h2 id="agents-directory-heading">
                One workspace, every local <HandAccent>runtime</HandAccent>
              </h2>
              <p>
                Pick the CLI or SDK already running on your computer. Every runtime below is backed by a verified Alook daemon driver.
              </p>
            </div>

            <div className={styles.agentsGrid}>
              {AGENT_RUNTIME_PAGES.map((agent) => (
                <Link key={agent.slug} href={`/agents/${agent.slug}`} className={styles.agentCardLink}>
                  <Card className={styles.agentCard}>
                    <div className={styles.agentCardHead}>
                      <span className={styles.logoBox}>
                        <ProviderLogo provider={agent.providerId} className="h-5 w-5" />
                      </span>
                      <span className={styles.agentVendor}>{agent.vendor}</span>
                    </div>
                    <h3>{agent.name}</h3>
                    <p>{agent.shortSummary}</p>
                    <div className={styles.chipList}>
                      {agent.capabilityBadges.slice(0, 3).map((cap) => (
                        <Badge key={cap} variant="secondary" className="h-auto px-2 py-0.5 text-[11px]">
                          {cap}
                        </Badge>
                      ))}
                    </div>
                    <div className={styles.agentCardFooter}>
                      <span>View {agent.name} setup</span>
                      <ArrowRight size={16} aria-hidden="true" />
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.band} aria-labelledby="agents-steps-heading">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>How it works</p>
              <h2 id="agents-steps-heading">
                From local terminal to team room in <HandAccent>three steps</HandAccent>
              </h2>
              <p>Keep execution on your machine while Alook handles presence, threads, attachments, and mobile access.</p>
            </div>

            <div className={styles.stepsGrid}>
              {HOW_IT_WORKS.map((item) => (
                <Card key={item.step} className={styles.stepCard}>
                  <span className={styles.stepNum}>{item.step}</span>
                  <h3>{item.title}</h3>
                  <p>{item.description}</p>
                </Card>
              ))}
            </div>
          </div>
        </section>

        <section className={`${styles.band} ${styles.bandMuted}`} aria-labelledby="agents-pairings-heading">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>Mix runtimes together</p>
              <h2 id="agents-pairings-heading">
                Step-by-step multi-agent <HandAccent>pairings</HandAccent>
              </h2>
              <p>Put two different runtimes in one server so one writes while the other reviews.</p>
            </div>

            <div className={styles.crossGrid}>
              {featuredGuides.map((guide) => (
                <DocumentNavigationLink key={guide.slug} href={`/tutorials/${guide.slug}`} className={styles.agentCardLink}>
                  <Card className={styles.crossCard}>
                    <div>
                      <h3>{guide.title}</h3>
                      <p>{guide.description}</p>
                    </div>
                    <ArrowRight size={18} className="shrink-0" aria-hidden="true" />
                  </Card>
                </DocumentNavigationLink>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.band} aria-labelledby="agents-faq-heading">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>FAQ</p>
              <h2 id="agents-faq-heading">
                Local agents, <HandAccent>answered</HandAccent>
              </h2>
            </div>

            <Card className={styles.faqCard}>
              {AGENTS_HUB_FAQS.map((item) => (
                <details key={item.question} className={styles.faqItem}>
                  <summary>
                    <span>{item.question}</span>
                    <span className={styles.faqMarker} aria-hidden="true" />
                  </summary>
                  <p className={styles.faqAnswer}>{item.answer}</p>
                </details>
              ))}
            </Card>
          </div>
        </section>

        <section className={`${styles.container} ${styles.closingWrap}`} aria-label="Connect your agent">
          <Card surface="sticker" className={styles.closingCard}>
            <div className={styles.closingInner}>
              <div className={styles.closingCopy}>
                <Badge variant="secondary" className="h-auto px-2.5 py-0.5 text-xs" style={{ rotate: "-1.5deg" }}>
                  No vendor lock-in · Swap anytime
                </Badge>
                <h2>
                  Pair your computer and invite your <HandAccent>team</HandAccent>
                </h2>
                <p>
                  Start free with the runtimes already installed on your machine, or compare how Alook stacks up against cloud-hosted alternatives.
                </p>
                <div className={styles.heroActions}>
                  <DocumentNavigationLink
                    href="/sign-in"
                    data-variant="default"
                    className={cn(buttonVariants({ size: "lg" }), "h-11 gap-2 px-6")}
                  >
                    Get started free <ArrowRight size={16} aria-hidden="true" />
                  </DocumentNavigationLink>
                  <Link
                    href="/compare"
                    data-variant="secondary"
                    className={cn(buttonVariants({ variant: "secondary", size: "lg" }), "h-11 px-5")}
                  >
                    Compare with other tools
                  </Link>
                </div>
              </div>
              <div className={styles.closingArt} aria-hidden="true">
                <Mac label="Alook" labelFont="var(--font-brand)" className="w-28 -rotate-3" />
                <Cassette className="-ml-6 mb-1 w-20 rotate-6" />
              </div>
            </div>
          </Card>
        </section>
      </main>

      <LandingFooter />
    </div>
  )
}
