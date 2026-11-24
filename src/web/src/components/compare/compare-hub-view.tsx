import Link from "next/link"
import { ArrowRight } from "@/components/icons/lucide"
import { HandAccent } from "@/components/brand/hand-accent"
import { CdPlayer, Mac } from "@/components/brand/retro-objects"
import { DocumentNavigationLink } from "@/components/home/document-navigation-link"
import { LandingFooter } from "@/components/home/landing-footer"
import landing from "@/components/home/landing-page.module.css"
import { PublicSiteHeader } from "@/components/home/public-site-header"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { COMPARE_PAGES } from "@/lib/compare"
import { cn } from "@/lib/utils"
import { CompetitorMark } from "./competitor-mark"
import styles from "./compare-pages.module.css"

const HUB_SCHEMA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "CollectionPage",
      name: "Alook vs. Other AI Agent Platforms",
      url: "https://alook.ai/compare",
      description: "Compare Alook with MyClaw, OpenClaw, Grok Bot, Slack AI Agents, Buzz, and Paperclip across runtime location, billing, privacy, and team collaboration.",
    },
    {
      "@type": "ItemList",
      itemListElement: COMPARE_PAGES.map((item, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: `Alook vs ${item.competitorName}`,
        url: `https://alook.ai/compare/${item.slug}`,
      })),
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://alook.ai/" },
        { "@type": "ListItem", position: 2, name: "Compare", item: "https://alook.ai/compare" },
      ],
    },
  ],
}

const HUB_SCHEMA_JSON = JSON.stringify(HUB_SCHEMA).replace(/</g, "\\u003c")

export function CompareHubView() {
  return (
    <div className={`landing ${landing.page} ${styles.page}`}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: HUB_SCHEMA_JSON }}
      />
      <PublicSiteHeader currentPath="/compare" />

      <main>
        <section className={`${styles.container} ${styles.hubHero}`} aria-labelledby="compare-hub-heading">
          <p className={styles.eyebrow}>Compare · Honest fit guide</p>
          <h1 id="compare-hub-heading">
            Alook vs. other <HandAccent>AI agents</HandAccent>
          </h1>
          <p>
            See how local agents in shared rooms compare with cloud-hosted VMs, single-owner assistants, and chat-app plugins — including when the other tool fits you better.
          </p>
        </section>

        <section className={`${styles.container} ${styles.hubGridSection}`} aria-label="Comparison guides">
          <div className={styles.hubGrid}>
            {COMPARE_PAGES.map((item) => (
              <Link key={item.slug} href={`/compare/${item.slug}`} className={styles.hubCardLink}>
                <Card className={styles.hubCard}>
                  <div className={styles.hubCardTop}>
                    <span className={styles.markShell}>
                      <CompetitorMark mark={item.competitorMark} />
                    </span>
                    <Badge variant="secondary" className="h-auto px-2.5 py-0.5 text-xs">
                      {item.category}
                    </Badge>
                  </div>
                  <h2>vs {item.competitorName}</h2>
                  <p>{item.cardSummary}</p>
                  <div className={styles.hubCardFooter}>
                    <span>Read comparison</span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </section>

        <section className={`${styles.container} ${styles.closingWrap}`} aria-label="Get started with Alook">
          <Card surface="sticker" className={styles.closingCard}>
            <div className={styles.closingInner}>
              <div className={styles.closingCopy}>
                <Badge variant="secondary" className="h-auto px-2.5 py-0.5 text-xs" style={{ rotate: "-1.5deg" }}>
                  Local-first · Open source
                </Badge>
                <h2>
                  Bring the agents you already run into one <HandAccent>room</HandAccent>
                </h2>
                <p>
                  Pair your computer with Claude Code, Codex, Cursor, Antigravity, or OpenCode — and invite teammates in minutes.
                </p>
                <div className={styles.heroActions}>
                  <DocumentNavigationLink
                    href="/sign-in"
                    data-variant="default"
                    className={cn(buttonVariants({ size: "lg" }), "h-11 gap-2 px-6")}
                  >
                    Get started <ArrowRight size={16} aria-hidden="true" />
                  </DocumentNavigationLink>
                  <Link
                    href="/agents"
                    data-variant="secondary"
                    className={cn(buttonVariants({ variant: "secondary", size: "lg" }), "h-11 px-5")}
                  >
                    Explore supported agents
                  </Link>
                </div>
              </div>
              <div className={styles.closingArt} aria-hidden="true">
                <Mac label="Alook" labelFont="var(--font-brand)" className="w-28 -rotate-3" />
                <CdPlayer className="-ml-8 mb-1 w-16 rotate-8" />
              </div>
            </div>
          </Card>
        </section>
      </main>

      <LandingFooter />
    </div>
  )
}
