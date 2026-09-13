import type { CSSProperties } from "react"
import { tid } from "@/lib/community/testids"
import type { InitialPositionPhase } from "./initial-position-transition"
import styles from "./initial-position-aurora.module.css"

type AuroraTone = "cyan" | "blue" | "violet" | "magenta"
type AuroraLayer = "fine" | "broad"
type AuroraBarShape = readonly [
  x: number,
  widthRem: number,
  maxHeight: number,
  tone: AuroraTone,
  strength?: number,
]

type AuroraBarStyle = CSSProperties & {
  "--bar-x": string
  "--bar-width": string
  "--bar-height": string
  "--bar-min-scale": string
  "--bar-duration": string
  "--bar-delay": string
  "--bar-strength": string
}

const BAR_MIN_SCALES = [
  0.42, 0.68, 0.52, 0.73, 0.46, 0.63, 0.57, 0.71, 0.49, 0.65, 0.54, 0.75, 0.6,
] as const
const BAR_DURATIONS_MS = [
  1_780, 2_230, 1_960, 2_410, 2_110, 1_840, 2_320, 2_050, 2_170,
  1_890, 2_470, 1_990, 2_280, 1_760, 2_380, 2_080, 2_210,
] as const
const BAR_PHASE_CYCLES = [
  0.15, 1.28, 0.39, 1.61, 0.72, 1.9, 0.06, 1.43, 0.84, 1.13,
  0.52, 1.77, 0.26, 1.55, 0.95, 1.04, 0.63, 1.87, 0.31,
] as const

const FINE_BAR_SHAPES = [
  [0, 0.08, 0, "cyan"],
  [2, 0.16, 5, "cyan"],
  [3.4, 0.1, 12, "cyan"],
  [5.5, 0.24, 8, "cyan"],
  [6.8, 0.12, 19, "cyan"],
  [8.4, 0.12, 14, "cyan"],
  [10.1, 0.1, 26, "blue"],
  [12.3, 0.14, 21, "cyan"],
  [17, 0.18, 36, "blue"],
  [22.5, 0.14, 55, "violet"],
  [24.2, 0.1, 34, "blue"],
  [27, 0.28, 84, "blue"],
  [28.4, 0.12, 46, "blue"],
  [30.6, 0.14, 61, "violet"],
  [34.8, 0.1, 31, "magenta"],
  [36, 0.17, 43, "magenta"],
  [38.2, 0.11, 58, "violet"],
  [40.5, 0.22, 67, "violet"],
  [42.1, 0.1, 39, "blue"],
  [45.5, 0.3, 91, "magenta"],
  [47.1, 0.12, 48, "violet"],
  [55, 0.13, 38, "blue"],
  [57.3, 0.1, 50, "violet"],
  [60.5, 0.2, 58, "violet"],
  [62.2, 0.1, 35, "magenta"],
  [64, 0.26, 78, "magenta"],
  [65.7, 0.12, 45, "violet"],
  [68.2, 0.1, 27, "blue"],
  [73.5, 0.16, 45, "cyan"],
  [75.1, 0.1, 63, "cyan"],
  [77, 0.12, 32, "blue"],
  [82.1, 0.11, 42, "violet"],
  [84.2, 0.12, 33, "magenta"],
  [86, 0.28, 46, "magenta"],
  [88.2, 0.1, 27, "magenta"],
  [90, 0.16, 34, "violet"],
  [92.4, 0.1, 15, "blue"],
  [96.5, 0.22, 6, "cyan"],
  [100, 0.08, 0, "cyan"],
] satisfies readonly AuroraBarShape[]

const BROAD_BAR_SHAPES = [
  [0, 0.5, 0, "cyan", 68],
  [4.5, 1.15, 11, "cyan", 78],
  [11, 0.7, 7, "cyan", 68],
  [18, 1, 32, "blue", 70],
  [27.5, 1.2, 79, "blue", 76],
  [39, 1.65, 61, "violet", 74],
  [46, 1.05, 88, "magenta", 82],
  [62, 1.8, 70, "violet", 70],
  [74, 0.85, 47, "cyan", 72],
  [82, 1, 19, "violet", 72],
  [87, 1.5, 25, "magenta", 78],
  [96, 0.75, 8, "cyan", 68],
  [100, 0.5, 0, "cyan", 68],
] satisfies readonly AuroraBarShape[]

function buildBars(layer: AuroraLayer, shapes: readonly AuroraBarShape[], motionOffset: number) {
  return shapes.map(([x, widthRem, maxHeight, tone, strength = 100], index) => {
    const motionIndex = index + motionOffset
    const minScale = BAR_MIN_SCALES[motionIndex % BAR_MIN_SCALES.length]!
    const durationMs = BAR_DURATIONS_MS[motionIndex % BAR_DURATIONS_MS.length]!
    const phaseCycles = BAR_PHASE_CYCLES[motionIndex % BAR_PHASE_CYCLES.length]!
    return {
      layer,
      x,
      widthRem,
      maxHeight,
      tone,
      strength,
      motionIndex,
      minScale,
      durationMs,
      delayMs: -Math.round(durationMs * phaseCycles),
    }
  })
}

const FINE_BARS = buildBars("fine", FINE_BAR_SHAPES, 0)
const BROAD_BARS = buildBars("broad", BROAD_BAR_SHAPES, FINE_BAR_SHAPES.length)
const AURORA_LAYERS = [
  { layer: "fine", className: styles.fineBars, bars: FINE_BARS },
  { layer: "broad", className: styles.broadBars, bars: BROAD_BARS },
] as const

function barStyle(bar: ReturnType<typeof buildBars>[number]): AuroraBarStyle {
  return {
    "--bar-x": `${bar.x}%`,
    "--bar-width": `${bar.widthRem}rem`,
    "--bar-height": `${bar.maxHeight}%`,
    "--bar-min-scale": String(bar.minScale),
    "--bar-duration": `${bar.durationMs}ms`,
    "--bar-delay": `${bar.delayMs}ms`,
    "--bar-strength": `${bar.strength}%`,
  }
}

export function InitialPositionAurora({ phase }: { phase: InitialPositionPhase }) {
  if (phase !== "aurora" && phase !== "revealing") return null

  return (
    <div
      aria-hidden="true"
      data-testid={tid.initialPositionAurora}
      data-phase={phase}
      className={`${styles.aurora} ${phase === "aurora" ? styles.visible : styles.leaving}`}
    >
      <div className={styles.peaks}>
        {AURORA_LAYERS.map(({ layer, className, bars }) => (
          <div key={layer} data-aurora-layer={layer} className={className}>
            {bars.map((bar) => (
              <span
                key={bar.x}
                data-aurora-bar
                data-layer={bar.layer}
                data-motion={bar.motionIndex}
                data-tone={bar.tone}
                className={styles.bar}
                style={barStyle(bar)}
              />
            ))}
          </div>
        ))}
      </div>
      <div className={styles.haze} />
    </div>
  )
}
