"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { ArrowRight } from "lucide-react"
import { HandAccent } from "@/components/brand/hand-accent"
import { buttonVariants } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { trackLandingCtaClicked } from "@/lib/analytics"
import { getUseCase } from "@/lib/usecases"
import { cn } from "@/lib/utils"
import { DocumentNavigationLink } from "./document-navigation-link"
import { CollagePiece } from "./landing-closing-collage"
import landing from "./landing-page.module.css"
import styles from "./landing-use-cases.module.css"

// Four stories chosen by Gus (gus-issues/#274#204–206), one at a time behind tabs. Copy shows the
// visitor's own situation and result so they picture themselves in it; it never explains features
// (#215). Art comes from the matching /usecases article.
const STORIES = [
  {
    slug: "ask-teammates-seo-bot",
    cta: "Share a bot with your team",
    tab: "Marketing needs SEO data",
    title: "Get the traffic report without waiting for your SEO teammate",
    body: "Their bot already has Ahrefs open. Ask in the team channel and the table comes back while you’re still planning.",
  },
  {
    slug: "github-issue-to-reviewed-pr",
    cta: "Put your bots on night shift",
    tab: "A bug fixed overnight",
    title: "Go to bed with a bug report. Wake up to a reviewed fix.",
    body: "Your bots pick up last night’s issue, pass the work between them, and leave a checked PR ready for your morning coffee.",
  },
  {
    slug: "agents-across-two-computers",
    cta: "Connect your computers",
    tab: "Your Mac and your PC",
    title: "Your Mac writes the fix. Your Windows PC tests it.",
    body: "Send one message from your phone. The two computers trade the work until the tests pass.",
  },
  {
    slug: "hackathon-people-and-bots",
    cta: "Start a community server",
    tab: "A hackathon help desk",
    title: "Answer a hackathon question once, for every team",
    body: "Participants and their bots read the same answer in one place and keep building.",
  },
].map((story) => ({ ...story, image: getUseCase(story.slug)!.image }))

export function LandingUseCases({ isLoggedIn }: { isLoggedIn: boolean }) {
  const [active, setActive] = useAtom(useCreateAtom<string>(STORIES[0].slug))
  const story = STORIES.find(({ slug }) => slug === active) ?? STORIES[0]
  return (
    <section id="use-cases" tabIndex={-1} aria-labelledby="use-cases-heading" className={styles.section}>
      <div className={styles.container} data-landing-scroll-anchor>
        <div className={styles.intro}>
          <h2 id="use-cases-heading">What will you get done with <HandAccent>Alook</HandAccent>?</h2>
        </div>
        <Tabs value={story.slug} onValueChange={(value) => setActive(String(value))}>
          <TabsList className={`${styles.tabs} thin-scrollbar`} aria-label="Use cases">
            {STORIES.map(({ slug, tab }) => <TabsTrigger key={slug} value={slug}>{tab}</TabsTrigger>)}
          </TabsList>
          <div role="tabpanel" aria-label={story.tab} className={styles.panel}>
            {/* Every sticker stays mounted at a fixed ratio so switching tabs never shifts the layout.
                Like the closing collage, a sticker floats and can be picked up and moved. */}
            <div className={styles.art} aria-hidden="true">
              {STORIES.map(({ slug, image }) => (
                <div key={slug} className={styles.slot} data-active={slug === story.slug}>
                  <CollagePiece className={styles.sticker}>
                    {/* Plain img: Blog-zone asset; the main zone image optimizer cannot fetch it. */}
                    <img src={image} alt="" width={1200} height={675} loading="lazy" decoding="async" draggable={false} className={cn(landing.collageItem, styles.image)} />
                  </CollagePiece>
                </div>
              ))}
            </div>
            <div className={styles.copy}>
              <h3>{story.title}</h3>
              <p>{story.body}</p>
              {/* The action is the point; the story is the secondary way in (Gus #241). */}
              <div className={styles.actions}>
                <DocumentNavigationLink href={isLoggedIn ? "/c/me" : "/sign-in"} data-variant="default"
                  className={cn(buttonVariants({ size: "lg" }), "h-12 px-6 text-base")}
                  onClick={() => trackLandingCtaClicked({ cta_name: isLoggedIn ? "use_cases_open_app" : "use_cases_get_started" })}>
                  {isLoggedIn ? "Open Alook" : story.cta}
                </DocumentNavigationLink>
                <DocumentNavigationLink href={`/usecases/${story.slug}`} data-variant="secondary"
                  className={cn(buttonVariants({ variant: "secondary", size: "lg" }), "h-12 px-6 text-base")}>
                  Full story <ArrowRight size={16} aria-hidden="true" />
                </DocumentNavigationLink>
              </div>
            </div>
          </div>
        </Tabs>
      </div>
    </section>
  )
}
