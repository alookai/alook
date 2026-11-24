import Link from "next/link"
import { ArrowRight, ArrowUpRight, ChevronRight } from "@/components/icons/lucide"
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
import {
  AGENT_RUNTIME_PAGES,
  getRelatedTutorialsForAgent,
  type AgentRuntimePage,
} from "@/lib/agents"
import { getComparisonPage } from "@/lib/compare"
import { cn } from "@/lib/utils"
import { AgentChannelPreview } from "./agent-hero-preview"
import styles from "./agents-pages.module.css"

function buildAgentSchema(agent: AgentRuntimePage) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        name: `${agent.name} in Alook — Local Multi-Agent Collaboration`,
        url: `https://alook.ai/agents/${agent.slug}`,
        description: agent.heroDescription,
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: "https://alook.ai/" },
          { "@type": "ListItem", position: 2, name: "Agents", item: "https://alook.ai/agents" },
          { "@type": "ListItem", position: 3, name: agent.name, item: `https://alook.ai/agents/${agent.slug}` },
        ],
      },
      {
        "@type": "HowTo",
        name: `How to connect ${agent.name} to Alook`,
        step: agent.setupSteps.map((step, index) => ({
          "@type": "HowToStep",
          position: index + 1,
          name: step.title,
          text: step.description,
        })),
      },
      {
        "@type": "FAQPage",
        mainEntity: agent.faqs.map(({ question, answer }) => ({
          "@type": "Question",
          name: question,
          acceptedAnswer: {
            "@type": "Answer",
            text: answer,
          },
        })),
      },
    ],
  }).replace(/</g, "\\u003c")
}

export function AgentDetailView({ agent }: { agent: AgentRuntimePage }) {
  const tutorials = getRelatedTutorialsForAgent(agent)
  const comparisons = agent.relatedCompareSlugs
    .map((slug) => getComparisonPage(slug))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
  const otherAgents = AGENT_RUNTIME_PAGES.filter((item) => item.slug !== agent.slug)

  return (
    <div className={`landing ${landing.page} ${styles.page}`}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: buildAgentSchema(agent) }}
      />
      <PublicSiteHeader currentPath="/agents" />

      <main>
        <nav aria-label="Breadcrumb" className={`${styles.container} ${styles.breadcrumb}`}>
          <Link href="/">Home</Link>
          <ChevronRight size={14} aria-hidden="true" />
          <Link href="/agents">Agents</Link>
          <ChevronRight size={14} aria-hidden="true" />
          <span aria-current="page">{agent.name}</span>
        </nav>

        <section className={`${styles.container} ${styles.hero} ${styles.heroDetail}`} aria-labelledby="agent-hero-heading">
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>
              <ProviderLogo provider={agent.providerId} className="h-3.5 w-3.5" />
              <span>{agent.vendor} · {agent.category}</span>
            </p>
            <h1 id="agent-hero-heading">
              {agent.heroLead} <HandAccent>{agent.heroAccent}</HandAccent>
            </h1>
            <p className={styles.heroLead}>{agent.heroDescription}</p>
            <div className={styles.heroActions}>
              <DocumentNavigationLink
                href="/sign-in"
                data-variant="default"
                className={cn(buttonVariants({ size: "lg" }), "h-11 gap-2 px-6")}
              >
                Connect {agent.name} <ArrowRight size={16} aria-hidden="true" />
              </DocumentNavigationLink>
              <Link
                href="/agents"
                data-variant="secondary"
                className={cn(buttonVariants({ variant: "secondary", size: "lg" }), "h-11 px-5")}
              >
                All supported agents
              </Link>
            </div>
            <div className={styles.chipList}>
              {agent.capabilityBadges.map((badge) => (
                <Badge key={badge} variant="secondary" className="h-auto px-2.5 py-0.5 text-xs">
                  {badge}
                </Badge>
              ))}
            </div>
          </div>

          <div className={styles.appPreviewFrame} role="img" aria-label={`Alook channel conversation with ${agent.name}`}>
            <AgentChannelPreview agent={agent} />
          </div>
        </section>

        <section className={`${styles.band} ${styles.bandMuted}`} aria-labelledby="agent-values-heading">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>Why run {agent.name} in Alook</p>
              <h2 id="agent-values-heading">
                Give {agent.name} a room. Get real work <HandAccent>done</HandAccent>.
              </h2>
            </div>

            <div className={styles.valueGrid}>
              {agent.valueCards.map((card) => (
                <Card key={card.title} className={styles.valueCard}>
                  <h3>{card.title}</h3>
                  <p>{card.description}</p>
                </Card>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.band} aria-labelledby="agent-spec-heading">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>Daemon capabilities &amp; setup</p>
              <h2 id="agent-spec-heading">
                How {agent.name} runs on your <HandAccent>machine</HandAccent>
              </h2>
              <p>{agent.prerequisite}</p>
            </div>

            <div className={styles.specSplit}>
              <Card className={styles.specCard}>
                <h3>Verified runtime capabilities</h3>
                <dl className={styles.specList}>
                  {agent.capabilities.map((cap) => (
                    <div key={cap.label} className={styles.specRow}>
                      <dt>{cap.label}</dt>
                      <dd>{cap.value}</dd>
                    </div>
                  ))}
                </dl>
                {agent.officialDocsUrl.startsWith("http") ? (
                  <a
                    href={agent.officialDocsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.prereqLink}
                  >
                    {agent.officialDocsLabel} <ArrowUpRight size={15} aria-hidden="true" />
                  </a>
                ) : (
                  <Link href={agent.officialDocsUrl} className={styles.prereqLink}>
                    {agent.officialDocsLabel} <ArrowRight size={15} aria-hidden="true" />
                  </Link>
                )}
              </Card>

              <div className={styles.setupColumn}>
                {agent.setupSteps.map((item) => (
                  <div key={item.step} className={styles.setupStepItem}>
                    <span className={styles.stepNum}>{item.step}</span>
                    <div>
                      <h4>{item.title}</h4>
                      <p>{item.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {(tutorials.length > 0 || comparisons.length > 0) && (
          <section className={`${styles.band} ${styles.bandMuted}`} aria-labelledby="agent-related-heading">
            <div className={styles.container}>
              <div className={styles.sectionIntro}>
                <p className={styles.eyebrow}>Pair &amp; compare</p>
                <h2 id="agent-related-heading">
                  Go further with <HandAccent>{agent.name}</HandAccent>
                </h2>
                <p>Pair {agent.name} with sibling runtimes in step-by-step tutorials, or compare Alook against cloud-hosted alternatives.</p>
              </div>

              <div className={styles.crossGrid}>
                {tutorials.map((guide) => (
                  <DocumentNavigationLink key={guide.slug} href={`/tutorials/${guide.slug}`} className={styles.agentCardLink}>
                    <Card className={styles.crossCard}>
                      <div>
                        <Badge variant="secondary" className="mb-2 h-auto px-2 py-0.5 text-[11px]">Tutorial</Badge>
                        <h3>{guide.title}</h3>
                        <p>{guide.description}</p>
                      </div>
                      <ArrowRight size={18} className="shrink-0" aria-hidden="true" />
                    </Card>
                  </DocumentNavigationLink>
                ))}
                {comparisons.map((comparison) => (
                  <Link key={comparison.slug} href={`/compare/${comparison.slug}`} className={styles.agentCardLink}>
                    <Card className={styles.crossCard}>
                      <div>
                        <Badge variant="outline" className="mb-2 h-auto px-2 py-0.5 text-[11px]">Compare</Badge>
                        <h3>Alook vs {comparison.competitorName}</h3>
                        <p>{comparison.cardSummary}</p>
                      </div>
                      <ArrowRight size={18} className="shrink-0" aria-hidden="true" />
                    </Card>
                  </Link>
                ))}
              </div>
            </div>
          </section>
        )}

        <section className={styles.band} aria-labelledby="agent-faq-heading">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>FAQ</p>
              <h2 id="agent-faq-heading">
                {agent.name} on Alook, <HandAccent>answered</HandAccent>
              </h2>
            </div>

            <Card className={styles.faqCard}>
              {agent.faqs.map((item) => (
                <details key={item.question} className={styles.faqItem}>
                  <summary>
                    <span>{item.question}</span>
                    <span className={styles.faqMarker} aria-hidden="true" />
                  </summary>
                  <p className={styles.faqAnswer}>{item.answer}</p>
                </details>
              ))}
            </Card>

            <div className={styles.siblingStrip} aria-label="Other supported agents">
              {otherAgents.map((item) => (
                <Link
                  key={item.slug}
                  href={`/agents/${item.slug}`}
                  data-variant="secondary"
                  className={cn(buttonVariants({ variant: "secondary", size: "sm" }), styles.siblingPill)}
                >
                  <ProviderLogo provider={item.providerId} className="h-4 w-4" />
                  <span>{item.name}</span>
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section className={`${styles.container} ${styles.closingWrap}`} aria-label={`Start with ${agent.name}`}>
          <Card surface="sticker" className={styles.closingCard}>
            <div className={styles.closingInner}>
              <div className={styles.closingCopy}>
                <Badge variant="secondary" className="h-auto px-2.5 py-0.5 text-xs" style={{ rotate: "-1.5deg" }}>
                  Local machine · Shared rooms
                </Badge>
                <h2>
                  Put {agent.name} in the room with your <HandAccent>team</HandAccent>
                </h2>
                <p>
                  Pair your computer in under a minute, keep your local files private, and invite teammates or a second runtime into the same thread.
                </p>
                <div className={styles.heroActions}>
                  <DocumentNavigationLink
                    href="/sign-in"
                    data-variant="default"
                    className={cn(buttonVariants({ size: "lg" }), "h-11 gap-2 px-6")}
                  >
                    Connect {agent.name} <ArrowRight size={16} aria-hidden="true" />
                  </DocumentNavigationLink>
                  <DocumentNavigationLink
                    href="/usecases"
                    data-variant="secondary"
                    className={cn(buttonVariants({ variant: "secondary", size: "lg" }), "h-11 px-5")}
                  >
                    See use cases
                  </DocumentNavigationLink>
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
