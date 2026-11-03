"use client"

import { ArrowUpRight } from "lucide-react"
import { HandAccent } from "@/components/brand/hand-accent"
import { MessageAuthorLine } from "@/components/community/messages/message-author-line"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { LANDING_TESTIMONIALS, rankTestimonials } from "./landing-testimonials-data"
import styles from "./landing-testimonials.module.css"

export function LandingTestimonials() {
  const posts = rankTestimonials(LANDING_TESTIMONIALS)
  if (posts.length === 0) return null
  const midpoint = Math.ceil(posts.length / 2)
  const lanes = [posts.slice(0, midpoint), posts.slice(midpoint)].filter((lane) => lane.length > 0)

  return (
    <section id="testimonials" aria-labelledby="testimonials-heading" className={styles.section}>
      <div className={styles.container}>
        <div className={styles.intro}>
          <h2 id="testimonials-heading">What people say about <HandAccent>Alook</HandAccent>.</h2>
          <p>From the community, in their own words.</p>
        </div>
      </div>
      <div className={styles.wall}>
        {lanes.map((lane, index) => (
          <div className={`${styles.lane} thin-scrollbar`} key={index}>
            <div className={styles.track}>
              {[false, true].map((duplicate) => (
                <ul className={`${styles.messages} ${duplicate ? styles.duplicate : ""}`} key={String(duplicate)} aria-hidden={duplicate || undefined}>
                  {lane.map((post) => (
                    <li key={post.id}>
                      <a href={post.url} target="_blank" rel="noopener noreferrer" className={styles.message} tabIndex={duplicate ? -1 : undefined}>
                        <Avatar size="lg" className={styles.avatar}>
                          {post.avatar && <AvatarImage src={post.avatar} alt="" loading="lazy" />}
                          <AvatarFallback className={styles.avatarFallback}>{post.name.slice(0, 2)}</AvatarFallback>
                        </Avatar>
                        <div className={styles.body}>
                          <div className={styles.author}>
                            <MessageAuthorLine authorName={post.name} color="var(--landing-text)" />
                            <ArrowUpRight className={styles.sourceIcon} size={14} aria-hidden="true" />
                          </div>
                          <span className={styles.handle}>@{post.handle}</span>
                          <blockquote lang={post.lang ?? "en"}>{post.quote}</blockquote>
                          <span className="sr-only">Open original post by {post.name} (opens in a new tab)</span>
                        </div>
                      </a>
                    </li>
                  ))}
                </ul>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
