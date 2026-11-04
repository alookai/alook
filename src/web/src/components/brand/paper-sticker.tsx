import type { CSSProperties, ReactNode } from "react"
import styles from "./paper-sticker.module.css"

/**
 * A printed paper sticker stuck onto a machine case: a tinted face inside a white die-cut margin, a gloss
 * sheen and a contact shadow. Illustration only: use it
 * for marketing scenes such as the testimonial wall, never for application badges or status.
 */
export function PaperSticker({
  children,
  tilt = 0,
  tint,
  className,
}: {
  children: ReactNode
  /** Degrees; positive turns clockwise. */
  tilt?: number
  /** Face colour behind the printed content; defaults to plain paper. */
  tint?: string
  className?: string
}) {
  return (
    <div
      data-slot="paper-sticker"
      data-contour
      className={`${styles.sticker}${className ? ` ${className}` : ""}`}
      style={{ "--sticker-tilt": `${tilt}deg`, ...(tint ? { "--sticker-tint": tint } : {}) } as CSSProperties}
    >
      {children}
    </div>
  )
}
