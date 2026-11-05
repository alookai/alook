import { TestimonialSticker } from "@/components/home/landing-testimonials"
import { LANDING_TESTIMONIALS, rankTestimonials } from "@/components/home/landing-testimonials-data"
import styles from "./paper-sticker-specimen.module.css"

export function PaperStickerSpecimen() {
  return (
    <section id="paper-stickers" className={styles.section} aria-labelledby="paper-stickers-heading">
      <div className={styles.heading}>
        <h2 id="paper-stickers-heading">Paper stickers</h2>
        <p>A die-cut portrait and a printed message, pressed onto the case.</p>
      </div>
      <div className={styles.case}>
        {rankTestimonials(LANDING_TESTIMONIALS).slice(0, 1).map((post) => (
          <TestimonialSticker key={post.id} post={post} />
        ))}
      </div>
    </section>
  )
}
