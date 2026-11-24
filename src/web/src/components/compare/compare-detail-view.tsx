import Image from "next/image"
import Link from "next/link"
import { ArrowRight, ArrowUpRight, Check, ChevronRight } from "@/components/icons/lucide"
import { HandAccent } from "@/components/brand/hand-accent"
import { CdPlayer, Mac } from "@/components/brand/retro-objects"
import { DocumentNavigationLink } from "@/components/home/document-navigation-link"
import { LandingFooter } from "@/components/home/landing-footer"
import landing from "@/components/home/landing-page.module.css"
import { PublicSiteHeader } from "@/components/home/public-site-header"
import { ProviderLogo } from "@/components/provider-logo"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { getAgentRuntimePage } from "@/lib/agents"
import { COMPARE_PAGES, type ComparisonPage } from "@/lib/compare"
import { cn } from "@/lib/utils"
import { CompetitorMark } from "./competitor-mark"
import styles from "./compare-pages.module.css"

function buildDetailSchema(page: ComparisonPage) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        name: `Alook vs ${page.competitorName}`,
        url: `https://alook.ai/compare/${page.slug}`,
        description: page.heroDescription,
        dateModified: page.reviewedDate,
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: "https://alook.ai/" },
          { "@type": "ListItem", position: 2, name: "Compare", item: "https://alook.ai/compare" },
          { "@type": "ListItem", position: 3, name: `Alook vs ${page.competitorName}`, item: `https://alook.ai/compare/${page.slug}` },
        ],
      },
      {
        "@type": "FAQPage",
        mainEntity: page.faqs.map(({ question, answer }) => ({
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

export function CompareDetailView({ page }: { page: ComparisonPage }) {
  const featuredAgents = page.featuredAgentSlugs
    .map((slug) => getAgentRuntimePage(slug))
    .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
  const siblingComparisons = COMPARE_PAGES.filter((item) => item.slug !== page.slug)

  return (
    <div className={`landing ${landing.page} ${styles.page}`}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: buildDetailSchema(page) }}
      />
      <PublicSiteHeader currentPath="/compare" />

      <main>
        <nav aria-label="Breadcrumb" className={`${styles.container} ${styles.breadcrumb}`}>
          <Link href="/">Home</Link>
          <ChevronRight size={14} aria-hidden="true" />
          <Link href="/compare">Compare</Link>
          <ChevronRight size={14} aria-hidden="true" />
          <span aria-current="page">Alook vs {page.competitorName}</span>
        </nav>

        <section className={`${styles.container} ${styles.detailHero}`} aria-labelledby="compare-hero-heading">
          <div className={styles.detailHeroCopy}>
            <p className={styles.eyebrow}>Side-by-side comparison</p>
            <h1 id="compare-hero-heading">
              {page.heroLead} <HandAccent>{page.heroAccent}</HandAccent>
            </h1>
            <p className={styles.detailHeroLead}>{page.heroDescription}</p>
            <div className={styles.heroActions}>
              <DocumentNavigationLink
                href="/sign-in"
                data-variant="default"
                className={cn(buttonVariants({ size: "lg" }), "h-11 gap-2 px-6")}
              >
                Get started free <ArrowRight size={16} aria-hidden="true" />
              </DocumentNavigationLink>
              <Link
                href="/pricing"
                data-variant="secondary"
                className={cn(buttonVariants({ variant: "secondary", size: "lg" }), "h-11 px-5")}
              >
                See pricing
              </Link>
            </div>
            <div className={styles.factorPills}>
              {page.keyFactors.map((factor) => (
                <Badge key={factor} variant="secondary" className="h-auto px-3 py-1 text-xs">
                  {factor}
                </Badge>
              ))}
            </div>
          </div>

          <Card className={styles.vsStage} aria-label={`Architecture snapshot comparing Alook and ${page.competitorName}`}>
            <div className={styles.vsHeader}>
              <span className={styles.vsBrandPair}>
                <Image src="/alook.svg" alt="" width={24} height={24} />
                <span>Alook</span>
              </span>
              <span className={styles.vsBadge}>VS</span>
              <span className={styles.vsBrandPair}>
                <CompetitorMark mark={page.competitorMark} className="h-5 w-5" />
                <span>{page.competitorName}</span>
              </span>
            </div>

            <div className={styles.vsColumns}>
              <div className={`${styles.vsPane} ${styles.vsPaneAlook}`}>
                <Badge variant="secondary" className="w-fit h-auto px-2 py-0.5 text-[11px]">
                  {page.visualCompare.alookBadge}
                </Badge>
                <div className={styles.vsPaneTitle}>{page.visualCompare.alookTitle}</div>
                <ul className={styles.vsList}>
                  {page.visualCompare.alookBullets.map((item) => (
                    <li key={item}>
                      <span className={styles.vsDot} aria-hidden="true" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className={styles.vsPane}>
                <Badge variant="outline" className="w-fit h-auto px-2 py-0.5 text-[11px]">
                  {page.visualCompare.competitorBadge}
                </Badge>
                <div className={styles.vsPaneTitle}>{page.visualCompare.competitorTitle}</div>
                <ul className={styles.vsList}>
                  {page.visualCompare.competitorBullets.map((item) => (
                    <li key={item}>
                      <span className={styles.vsDotMuted} aria-hidden="true" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className={styles.vsRuntimeStrip}>
              {featuredAgents.map((agent) => (
                <span key={agent.slug} className={styles.vsRuntimeChip}>
                  <ProviderLogo provider={agent.providerId} className="h-3.5 w-3.5" />
                  <span>{agent.name}</span>
                </span>
              ))}
            </div>
          </Card>
        </section>

        <section className={`${styles.band} ${styles.bandMuted}`} aria-labelledby="compare-verdict-heading">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>{page.verdictEyebrow}</p>
              <h2 id="compare-verdict-heading">{page.verdictHeading}</h2>
              <p>{page.verdictSubtitle}</p>
            </div>

            <div className={styles.verdictGrid}>
              <Card surface="sticker" className={styles.verdictCard}>
                <Badge variant="secondary" className="w-fit h-auto px-2.5 py-0.5 text-xs">
                  Choose Alook when
                </Badge>
                <h3>{page.chooseAlook.title}</h3>
                <p className={styles.verdictSummary}>{page.chooseAlook.summary}</p>
                <ul className={styles.verdictPoints}>
                  {page.chooseAlook.points.map((point) => (
                    <li key={point}>
                      <Check size={16} className={styles.checkIcon} aria-hidden="true" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card className={styles.verdictCard}>
                <Badge variant="outline" className="w-fit h-auto px-2.5 py-0.5 text-xs">
                  Choose {page.competitorName} when
                </Badge>
                <h3>{page.chooseCompetitor.title}</h3>
                <p className={styles.verdictSummary}>{page.chooseCompetitor.summary}</p>
                <ul className={styles.verdictPoints}>
                  {page.chooseCompetitor.points.map((point) => (
                    <li key={point}>
                      <Check size={16} className={styles.checkIcon} aria-hidden="true" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
        </section>

        <section className={styles.band} aria-labelledby="compare-table-heading">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>Side-by-side breakdown</p>
              <h2 id="compare-table-heading">{page.tableHeading}</h2>
              <p>{page.tableSubtitle}</p>
            </div>

            <Card className={styles.tableCard}>
              <div className={`${styles.tableScroll} scrollbar-none`}>
                <table className={styles.compareTable}>
                  <thead>
                    <tr>
                      <th scope="col">Decision factor</th>
                      <th scope="col" className={styles.alookCol}>
                        <span className={styles.alookColHeader}>
                          <Image src="/alook.svg" alt="" width={16} height={16} />
                          <span>Alook</span>
                        </span>
                      </th>
                      <th scope="col">{page.competitorName}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.rows.map((row) => (
                      <tr key={row.factor}>
                        <td className={styles.factorCell}>{row.factor}</td>
                        <td className={styles.alookCol}>{row.alook}</td>
                        <td className={styles.competitorCell}>{row.competitor}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <div className={styles.sourceBar}>
              <span>Reviewed {page.reviewedDate} · Product capabilities and pricing can change.</span>
              <div className={styles.sourceLinks}>
                {page.sources.map((source) => source.href.startsWith("http") ? (
                  <a key={source.href} href={source.href} target="_blank" rel="noopener noreferrer">
                    {source.label} <ArrowUpRight size={13} aria-hidden="true" />
                  </a>
                ) : (
                  <DocumentNavigationLink key={source.href} href={source.href}>
                    {source.label} <ArrowRight size={13} aria-hidden="true" />
                  </DocumentNavigationLink>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className={`${styles.band} ${styles.bandMuted}`} aria-labelledby="compare-pillars-heading">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>{page.pillarsEyebrow}</p>
              <h2 id="compare-pillars-heading">{page.pillarsHeading}</h2>
              <p>{page.pillarsSubtitle}</p>
            </div>

            <div className={styles.pillarsGrid}>
              {page.pillars.map((pillar) => (
                <Card key={pillar.index} className={styles.pillarCard}>
                  <span className={styles.pillarIndex}>{pillar.index}</span>
                  <h3>{pillar.title}</h3>
                  <p>{pillar.description}</p>
                </Card>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.band} aria-labelledby="compare-agents-heading">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>Supported local runtimes</p>
              <h2 id="compare-agents-heading">
                Bring the agents you already <HandAccent>run</HandAccent>
              </h2>
              <p>Alook connects local CLI agents directly on your machine — mix and swap runtimes without rebuilding your rooms.</p>
            </div>

            <div className={styles.runtimeGrid}>
              {featuredAgents.map((agent) => (
                <Link key={agent.slug} href={`/agents/${agent.slug}`} className={styles.hubCardLink}>
                  <Card className={styles.runtimeLinkCard}>
                    <span className={styles.markShell}>
                      <ProviderLogo provider={agent.providerId} className="h-5 w-5" />
                    </span>
                    <div className={styles.runtimeLinkCopy}>
                      <h3>{agent.name}</h3>
                      <p>{agent.shortSummary}</p>
                      <span className={styles.runtimeLinkCta}>
                        Explore {agent.name} <ArrowRight size={14} aria-hidden="true" />
                      </span>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section className={`${styles.band} ${styles.bandMuted}`} aria-labelledby="compare-faq-heading">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>FAQ</p>
              <h2 id="compare-faq-heading">
                Alook vs {page.competitorName}, <HandAccent>answered</HandAccent>
              </h2>
            </div>

            <Card className={styles.faqCard}>
              {page.faqs.map((item) => (
                <details key={item.question} className={styles.faqItem}>
                  <summary>
                    <span>{item.question}</span>
                    <span className={styles.faqMarker} aria-hidden="true" />
                  </summary>
                  <p className={styles.faqAnswer}>{item.answer}</p>
                </details>
              ))}
            </Card>

            <div className={styles.siblingStrip} aria-label="More comparisons">
              {siblingComparisons.map((item) => (
                <Link
                  key={item.slug}
                  href={`/compare/${item.slug}`}
                  data-variant="secondary"
                  className={cn(buttonVariants({ variant: "secondary", size: "sm" }), styles.siblingPill)}
                >
                  <CompetitorMark mark={item.competitorMark} className="h-4 w-4" />
                  <span>vs {item.competitorName}</span>
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section className={`${styles.container} ${styles.closingWrap}`} aria-label="Start with Alook">
          <Card surface="sticker" className={styles.closingCard}>
            <div className={styles.closingInner}>
              <div className={styles.closingCopy}>
                <Badge variant="secondary" className="h-auto px-2.5 py-0.5 text-xs" style={{ rotate: "-1.5deg" }}>
                  Free to start · Local &amp; open source
                </Badge>
                <h2>
                  Keep your machines, share your <HandAccent>agents</HandAccent>
                </h2>
                <p>
                  Connect your first local runtime in minutes and invite a teammate into the same room.
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
                    All comparisons
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
