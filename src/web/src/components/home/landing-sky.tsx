import { useId, type CSSProperties } from "react"
import styles from "./landing-sky.module.css"
import { Avatar } from "@/components/community/avatar"
import { LANDING_HUMAN_AVATARS } from "./landing-human-avatars"

type Sheet = { size: number; delay: number; duration: number; path: string; mobilePath: string; spin: number; line: { who: string; seed: string; text: string } }

// Arcs start at the typewriter's paper slot (0,0) and drift up and outwards
// with the wind. Phone paths drift out sideways from the paper top and stay
// below the copy (they never cross the headline).
const SHEETS: readonly Sheet[] = [
  { size: 118, delay: 0, duration: 13, spin: -1, path: "M0 0 C -30 -90, -150 -150, -260 -330", mobilePath: "M0 0 C -50 -10, -120 0, -175 -40", line: { who: "Gus", seed: "gus", text: "ship it tonight?" } },
  { size: 100, delay: 2.6, duration: 15, spin: 1, path: "M0 0 C 40 -110, 160 -170, 220 -380", mobilePath: "M0 0 C 50 -5, 120 5, 170 -35", line: { who: "Shelly", seed: "shelly", text: "looks good to me" } },
  { size: 126, delay: 5.2, duration: 14, spin: 1, path: "M0 0 C -10 -140, -60 -240, -120 -460", mobilePath: "M0 0 C -40 10, -100 30, -160 10", line: { who: "Alli · agent", seed: "alli", text: "on it, 2 fixes" } },
  { size: 96, delay: 7.8, duration: 12, spin: -1, path: "M0 0 C 70 -60, 200 -120, 330 -260", mobilePath: "M0 0 C 40 10, 110 25, 165 5", line: { who: "Tracy", seed: "tracy", text: "who has the logs?" } },
  { size: 112, delay: 10.4, duration: 16, spin: -1, path: "M0 0 C 20 -120, 90 -260, 60 -480", mobilePath: "M0 0 C 30 -60, 80 -100, 130 -180", line: { who: "Claude Code", seed: "claude-code", text: "tests pass ✓" } },
  { size: 92, delay: 12.2, duration: 13, spin: 1, path: "M0 0 C -80 -60, -220 -90, -360 -220", mobilePath: "M0 0 C -50 -30, -120 -40, -175 -80", line: { who: "Codex", seed: "codex", text: "logs attached" } },
]

function CurledSheet({ line, size }: { line: Sheet["line"]; size: number }) {
  const id = useId()
  return (
    <>
      <svg viewBox="0 0 100 126" className={styles.paper}>
        <defs>
          {/* The bend: lit on one side, shaded across the curl */}
          <linearGradient id={`${id}-bend`} x1="0" y1="0" x2="1" y2="0.25">
            <stop offset="0" stopColor="#fffdf8" />
            <stop offset="0.45" stopColor="#f6efe1" />
            <stop offset="0.78" stopColor="#ded2bb" />
            <stop offset="1" stopColor="#f3ecdf" />
          </linearGradient>
          <linearGradient id={`${id}-curl`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#cfc2a8" />
            <stop offset="1" stopColor="#fffdf8" />
          </linearGradient>
        </defs>
        <path d="M6 12 C 30 4, 68 2, 92 9 C 95 46, 96 84, 93 117 C 66 124, 34 125, 8 119 C 3 84, 3 46, 6 12 Z" fill={`url(#${id}-bend)`} />
        <path d="M30 8 C 32 46, 33 86, 31 122" stroke="#ffffff" strokeOpacity="0.8" strokeWidth="2.4" fill="none" />
        <path d="M72 5 C 76 44, 78 86, 75 123" stroke="#bfb196" strokeOpacity="0.35" strokeWidth="5" fill="none" />
        <path d="M80 6 C 86 8, 90 10, 92 9 C 91 16, 89 22, 86 26 C 84 18, 83 12, 80 6 Z" fill={`url(#${id}-curl)`} />
      </svg>
      <span className={styles.line}>
        <span className={styles.lineAuthor}>
          <Avatar label={line.who} seed={line.seed} src={LANDING_HUMAN_AVATARS[line.seed]} size={Math.round(size * 0.17)} />
          <b>{line.who}</b>
        </span>
        {line.text}
      </span>
    </>
  )
}

/** Paper flurry (Gus #2461, #2465): curled sheets arc up out of the paper
 * slot and drift with the wind, fluttering in 3D. A separate layer anchored to
 * the hero artwork — it does not reach into the typewriter. */
export function PaperFlurry() {
  return (
    <div className={styles.flurry} aria-hidden="true">
      {SHEETS.map((sheet, index) => (
        <div
          key={index}
          className={styles.sheet}
          style={{
            "--sheet-size": `${sheet.size}px`,
            "--sheet-delay": `${sheet.delay}s`,
            "--sheet-duration": `${sheet.duration}s`,
            "--sheet-path": `path("${sheet.path}")`,
            "--sheet-mobile-path": `path("${sheet.mobilePath}")`,
            "--sheet-spin": sheet.spin,
            "--sheet-rest": `${42 + index * 9}%`,
          } as CSSProperties}
          data-mobile-hidden={index >= 4 || undefined}
        >
          <div className={styles.flutter}>
            <CurledSheet line={sheet.line} size={sheet.size} />
          </div>
        </div>
      ))}
    </div>
  )
}
