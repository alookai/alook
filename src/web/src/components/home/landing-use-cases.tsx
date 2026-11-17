"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { ArrowRight } from "lucide-react"
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

// Four stories chosen by Gus (gus-issues/#274#204–206), one at a time behind tabs. Copy shows the
// visitor's own situation and result so they picture themselves in it; it never explains features
// (#215). Art comes from the matching /usecases article.
const STORIES = [
  {
    slug: "ask-teammates-seo-bot",
    cta: "Bring my SEO teammate",
    tab: "Planning an SEO update",
    title: "Know which page to improve next",
    body: "Ask your teammate’s SEO bot for the pages and searches bringing in traffic. Get the report directly, then choose which page to improve.",
  },
  {
    slug: "github-issue-to-reviewed-pr",
    cta: "Put my bots on a bug",
    tab: "A bug before bedtime",
    title: "Leave a bug tonight. Review a fix tomorrow.",
    body: "Let a coding bot prepare the patch and a second bot review it overnight. Come back to a pull request with the changes and checks ready for your decision.",
  },
  {
    slug: "agents-across-two-computers",
    cta: "Connect my computers",
    tab: "Away from your desk",
    title: "Get the Windows test result on your phone",
    body: "Ask the bot on your Mac to make the change, then have your Windows bot test the same commit. Read the result on your phone while you’re away.",
  },
  {
    slug: "hackathon-people-and-bots",
    cta: "Start my hackathon server",
    tab: "Running a hackathon",
    title: "Answer once, and help the next team too",
    body: "A participant asks about the rules. You answer in the shared help channel, and the other teams and their bots can use that answer too.",
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
          <h2 id="use-cases-heading">What will you get done with <HandAccent>Alook</HandAccent>?</h2>
        </div>
        <Tabs value={story.slug} onValueChange={(value) => setActive(String(value))}>
          <TabsList ref={setList} className={`${styles.tabs} thin-scrollbar`} aria-label="Use cases" data-overflow={overflow} {...handlers}>
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
                    onClick={() => trackLandingCtaClicked({ cta_name: isLoggedIn ? "use_cases_open_app" : "use_cases_get_started" })}>
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
      </div>
    </section>
  )
}
