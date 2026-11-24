"use client"

import { useLandingShellBotAnnotation } from "@/hooks/home/use-landing-shell-bot-annotation"
import { useReducedMotion } from "@/hooks/use-reduced-motion"
import styles from "./landing-interactive-shell.module.css"

const RING_PATH = "M 35 6 C 18 2, 4 14, 5 29 C 6 44, 19 52, 33 50 C 47 48, 53 35, 51 22 C 49 11, 39 5, 25 8"

export function LandingShellBotAnnotation({
  scrollRoot,
  visible,
  onExited,
}: {
  scrollRoot: HTMLDivElement | null
  visible: boolean
  onExited: () => void
}) {
  const reducedMotion = useReducedMotion()
  const { labelRef, layout, entered } = useLandingShellBotAnnotation({
    scrollRoot,
    visible,
    reducedMotion,
    onExited,
  })

  if (!layout) return null

  const { shellW, shellH, avatar, labelLeft, labelTop, compact } = layout
  const state = !visible ? "exiting" : entered ? "visible" : "idle"
  const rx = (avatar.width + 22) / 56
  const ry = (avatar.height + 22) / 56
  const tx = avatar.left + avatar.width / 2 - 28 * rx
  const ty = avatar.top + avatar.height / 2 - 28 * ry

  const sx = labelLeft + (compact ? 154 : 192)
  const sy = labelTop + (compact ? 26 : 36)
  const ex = avatar.left - 8
  const ey = avatar.top + avatar.height * 0.72
  const mx = (sx + ex) / 2
  const arrowD = `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${(mx + 20).toFixed(1)} ${(sy + 12).toFixed(1)}, ${(ex - 18).toFixed(1)} ${(ey + 28).toFixed(1)}, ${ex.toFixed(1)} ${ey.toFixed(1)}`
  const headD = `M ${(ex - 12).toFixed(1)} ${(ey + 3).toFixed(1)} L ${ex.toFixed(1)} ${ey.toFixed(1)} L ${(ex - 4).toFixed(1)} ${(ey + 12.5).toFixed(1)}`

  return (
    <div className={styles.botAnnotation} data-testid="landing-shell-bot-annotation" data-state={state} data-compact={compact || undefined} aria-hidden="true">
      <svg className={styles.botAnnotationSvg} viewBox={`0 0 ${shellW} ${shellH}`} width={shellW} height={shellH} fill="none">
        <g transform={`translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${rx.toFixed(3)} ${ry.toFixed(3)})`}>
          <path className={styles.botAnnotationCircle} pathLength={1} d={RING_PATH} />
        </g>
        <path className={styles.botAnnotationArrow} pathLength={1} d={arrowD} />
        <path className={styles.botAnnotationArrowHead} pathLength={1} d={headD} />
      </svg>
      <div ref={labelRef} className={styles.botAnnotationLabel} style={{ left: `${labelLeft.toFixed(1)}px`, top: `${labelTop.toFixed(1)}px` }}>
        <span className={styles.botAnnotationTitle}>Alli is your<br />local agent!</span>
        <span className={styles.botAnnotationHint}>click to inspect</span>
      </div>
    </div>
  )
}
