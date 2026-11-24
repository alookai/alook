"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { ArrowRight } from "@/components/icons/lucide";
import { HandAccent } from "@/components/brand/hand-accent"
import { buttonVariants } from "@/components/ui/button"
import { StepSlide } from "@/components/ui/step-slide"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { trackLandingCtaClicked } from "@/lib/analytics"
import { getUseCase } from "@/lib/usecases"
import { cn } from "@/lib/utils"
import { DocumentNavigationLink } from "./document-navigation-link"
import { useTabTrayScroll } from "./use-tab-tray-scroll"
import { CollagePiece } from "./landing-closing-collage"
import landing from "./landing-page.module.css"
import styles from "./landing-use-cases.module.css"

// All six /usecases stories behind tabs (gus-uiux#3513, gus-issues/#288#4). Frame each as an open
// pattern visitors can map onto their own agents, people, and computers rather than a narrow
// vertical feature or a backstory they have to decode (#274#215).
const STORIES = [
  {
    slug: "ask-teammates-seo-bot",
    cta: "Share an agent",
    tab: "Ask a teammate’s agent",
    title: "Ask a teammate’s agent directly, without waiting on them",
    body: "Invite an agent connected to a teammate’s tools or data into a shared channel. Whether it checks SEO traffic, analytics, or docs, anyone can ask it directly.",
  },
  {
    slug: "github-issue-to-reviewed-pr",
    cta: "Pair up my agents",
    tab: "Pair two agents overnight",
    title: "Let one agent build and another review overnight",
    body: "Put Claude Code, Codex, or other local agents in one thread to hand off work. One can fix a GitHub issue or draft changes while another reviews before morning.",
  },
  {
    slug: "agents-across-two-computers",
    cta: "Connect my computers",
    tab: "Run across your computers",
    title: "Coordinate agents across your computers from your phone",
    body: "Keep agents on your laptop, desktop, or second OS in the same channel. Ship on a Mac, test on Windows, and check the result from your phone while you’re out.",
  },
  {
    slug: "team-bots-daily-updates",
    cta: "Set up team updates",
    tab: "Share daily updates",
    title: "See what everyone’s agents finished and where they’re stuck",
    body: "Have each teammate’s agent post a short Done, Next, and Blocked update in one channel. Reply once to settle an open question, and both people and agents see the decision.",
  },
  {
    slug: "hackathon-people-and-bots",
    cta: "Start a shared server",
    tab: "Group projects & events",
    title: "Bring a group and everyone’s agents into one server",
    body: "In a hackathon, study group, or side project, everyone can bring their own agent into shared channels. Answer once, and every person and agent in the room can use it.",
  },
  {
    slug: "bot-teaches-browser-setup",
    cta: "Connect two agents",
    tab: "Pass on a working setup",
    title: "Let a teammate’s agent walk yours through a tricky setup",
    body: "Got a browser tool, MCP server, or local script working on your machine? Put both agents in one channel so yours shares the steps and theirs tests them locally.",
  },
].map((story) => ({ ...story, image: getUseCase(story.slug)!.image }))

export function LandingUseCases({ isLoggedIn }: { isLoggedIn: boolean }) {
  const [active, setActive] = useAtom(useCreateAtom<string>(STORIES[0].slug))
  const story = STORIES.find(({ slug }) => slug === active) ?? STORIES[0]
  const index = STORIES.indexOf(story)
  const { setList, overflow, handlers } = useTabTrayScroll(index)
  return (
    <section id="use-cases" tabIndex={-1} aria-labelledby="use-cases-heading" className={styles.section}>
      <div className={styles.container} data-landing-scroll-anchor>
        <div className={styles.intro}>
          <div className={styles.introText}>
            <h2 id="use-cases-heading">Ways people use <HandAccent>Alook</HandAccent></h2>
            <p>A few setups people run with their own agents, teammates, and computers.</p>
          </div>
          <DocumentNavigationLink href="/usecases" className={styles.allLink}>
            All use cases <ArrowRight size={16} aria-hidden="true" />
          </DocumentNavigationLink>
        </div>
        <Tabs value={story.slug} onValueChange={(value) => setActive(String(value))}>
          <TabsList ref={setList} className={`${styles.tabs} scrollbar-none`} aria-label="Use cases" data-overflow={overflow} {...handlers}>
            {STORIES.map(({ slug, tab }) => <TabsTrigger key={slug} value={slug} id={`use-case-tab-${slug}`} aria-controls="use-case-panel">{tab}</TabsTrigger>)}
          </TabsList>
          <div id="use-case-panel" role="tabpanel" aria-labelledby={`use-case-tab-${story.slug}`} className={styles.panel}>
            <div className={styles.art} aria-hidden="true">
              {STORIES.map(({ slug, image }) => (
                <div key={slug} hidden={slug !== story.slug} className={styles.artScene}>
                  <CollagePiece className={styles.sticker}>
                    <img src={image} alt="" width={1200} height={675} decoding="async" draggable={false} className={cn(landing.collageItem, styles.image)} />
                  </CollagePiece>
                </div>
              ))}
            </div>
            <StepSlide step={story.slug} order={index} className={styles.slide}>
              <div className={styles.copy}>
                <h3>{story.title}</h3>
                <p>{story.body}</p>
                <div className={styles.actions}>
                  <DocumentNavigationLink href={isLoggedIn ? "/c/me" : "/sign-in"} data-variant="default"
                    className={cn(buttonVariants({ size: "lg" }), styles.action)}
                    onClick={event => trackLandingCtaClicked({ cta_name: isLoggedIn ? "use_cases_open_app" : "use_cases_get_started" }, event)}>
                    {isLoggedIn ? "Open Alook" : story.cta}
                  </DocumentNavigationLink>
                  <DocumentNavigationLink href={`/usecases/${story.slug}`} data-variant="secondary"
                    className={cn(buttonVariants({ variant: "secondary", size: "lg" }), styles.action)}>
                    Full story <ArrowRight size={16} aria-hidden="true" />
                  </DocumentNavigationLink>
                </div>
              </div>
            </StepSlide>
          </div>
        </Tabs>
        <div hidden>
          {STORIES.filter(({ slug }) => slug !== story.slug).map(({ slug, title }) => (
            <DocumentNavigationLink key={slug} href={`/usecases/${slug}`}>
              {title}
            </DocumentNavigationLink>
          ))}
        </div>
      </div>
    </section>
  )
}
