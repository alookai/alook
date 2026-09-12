import { tid } from "@/lib/community/testids"
import type { InitialPositionPhase } from "./initial-position-transition"
import styles from "./initial-position-aurora.module.css"

export function InitialPositionAurora({ phase }: { phase: InitialPositionPhase }) {
  if (phase !== "aurora" && phase !== "revealing") return null

  return (
    <div
      aria-hidden="true"
      data-testid={tid.initialPositionAurora}
      data-phase={phase}
      className={`${styles.aurora} ${phase === "aurora" ? styles.visible : styles.leaving}`}
    >
      <div className={styles.drift}>
        <div className={styles.peaks} />
        <div className={styles.haze} />
      </div>
    </div>
  )
}
