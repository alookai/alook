"use client"

import type { CSSProperties } from "react"
import { ArrowUpRight } from "lucide-react"
import { HandAccent } from "@/components/brand/hand-accent"
import { PaperSticker } from "@/components/brand/paper-sticker"
import { MessageAuthorLine } from "@/components/community/messages/message-author-line"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { LANDING_TESTIMONIALS, rankTestimonials, type LandingTestimonial } from "./landing-testimonials-data"
import styles from "./landing-testimonials.module.css"

// Sticker placement from the author's name (Gus #2743, #2760): a well-mixed 32-bit hash (FNV-1a plus a
// murmur3 finaliser). Separate seeds keep tint and tilt independent across the author grid.
function nameHash(name: string): number {
  let hash = 0x811c9dc5
  for (const char of name) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193)
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b)
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35)
  return (hash ^ (hash >>> 16)) >>> 0
}

const STICKER_TINTS = ["#d9e6f7", "#f2e6cc", "#e5eec8", "#f6dccf", "#e6def3", "#d6eee4"] as const

function stickerPlacement(name: string) {
  const hash = nameHash(name)
  // Tilt spreads over ±6.5°, skipping the near-flat band so every sticker reads as hand-placed.
  const unit = nameHash(`tilt:${name}`) / 0xffffffff
  const tilt = (unit < 0.5 ? -1 : 1) * (1.5 + Math.abs(unit * 2 - 1) * 5)
  return {
    tilt: Number(tilt.toFixed(2)),
    tint: STICKER_TINTS[nameHash(`tint:${name}`) % STICKER_TINTS.length],
    jitter: ((hash >>> 20) % 13) - 6,
  }
}

export function TestimonialSticker({ post }: { post: LandingTestimonial }) {
  const sticker = stickerPlacement(post.name)
  return (
    <a href={post.url} target="_blank" rel="noopener noreferrer" className={styles.message}>
      <PaperSticker tilt={sticker.tilt} tint={sticker.tint} className={styles.sticker}>
        <Avatar size="lg" className={styles.avatar}>
          {post.avatar && <AvatarImage src={post.avatar} alt="" loading="lazy" />}
          <AvatarFallback className={styles.avatarFallback}>{post.name.slice(0, 2)}</AvatarFallback>
        </Avatar>
        <div className={styles.body}>
          <div className={styles.author}>
            <MessageAuthorLine authorName={post.name} color="currentColor" />
            <ArrowUpRight className={styles.sourceIcon} size={14} aria-hidden="true" />
          </div>
          <span className={styles.handle}>@{post.handle}</span>
          <blockquote lang={post.lang ?? "en"}>{post.quote}</blockquote>
          <span className="sr-only">Open original post by {post.name} (opens in a new tab)</span>
        </div>
      </PaperSticker>
    </a>
  )
}

export function LandingTestimonials() {
  const posts = rankTestimonials(LANDING_TESTIMONIALS)
  if (posts.length === 0) return null
  const midpoint = Math.ceil(posts.length / 2)
  const lanes = [posts.slice(0, midpoint), posts.slice(midpoint)].filter((lane) => lane.length > 0)

  return (
    <section id="testimonials" tabIndex={-1} aria-labelledby="testimonials-heading" className={styles.section}>
      <div className={styles.container} data-landing-scroll-anchor>
        <div className={styles.intro}>
          <h2 id="testimonials-heading">What people say about <HandAccent>Alook</HandAccent></h2>
          <p>From the community, in their own words.</p>
        </div>
      </div>
      <div className={`${styles.wall} thin-scrollbar`}>
        <div className={styles.wallSurface}>
          {lanes.map((lane, index) => (
            // Each lane repeats once and pans by one copy, so the loop never reverses (Gus #3196).
            <ul className={styles.messages} key={index} style={{ "--lane-count": lane.length } as CSSProperties}>
              {[0, 1].flatMap((copy) => lane.map((post) => {
                const sticker = stickerPlacement(post.name)
                return (
                  <li
                    key={`${copy}:${post.id}`}
                    data-loop-copy={copy ? "" : undefined}
                    aria-hidden={copy ? true : undefined}
                    inert={copy ? true : undefined}
                    style={{ "--sticker-jitter": `${sticker.jitter}px` } as CSSProperties}
                  >
                    <TestimonialSticker post={post} />
                  </li>
                )
              }))}
            </ul>
          ))}
        </div>
      </div>
    </section>
  )
}
