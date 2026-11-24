"use client"

import { useEffect, useRef, useState } from "react"
import { useReducedMotion } from "@/hooks/use-reduced-motion"
import styles from "./landing-interactive-shell.module.css"

type Layout =
  | {
      mode: "desktop"
      shellW: number
      shellH: number
      avatar: { left: number; top: number; width: number; height: number }
      labelLeft: number
      labelTop: number
      compact: boolean
    }
  | {
      mode: "mobile"
      shellW: number
      shellH: number
      avatar: { left: number; top: number; width: number; height: number }
      name: { left: number; top: number; width: number }
      labelLeft: number
      labelTop: number
      compact: boolean
    }

const EXIT_MS = 340
const RING_PATH = "M 35 6 C 18 2, 4 14, 5 29 C 6 44, 19 52, 33 50 C 47 48, 53 35, 51 22 C 49 11, 39 5, 25 8"

export function LandingShellBotAnnotation({
  scrollRoot,
  visible,
  onShown,
  onExited,
}: {
  scrollRoot: HTMLDivElement | null
  visible: boolean
  onShown?: () => void
  onExited: () => void
}) {
  const reducedMotion = useReducedMotion()
  const labelRef = useRef<HTMLDivElement | null>(null)
  const avatarRef = useRef<HTMLElement | null>(null)
  const shownReportedRef = useRef(false)
  const [layout, setLayout] = useState<Layout | null>(null)
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('[data-testid="landing-interactive-shell"]')
    if (!shell) return
    let raf = 0
    let slideRetries = 0
    const schedule = () => {
      window.cancelAnimationFrame(raf)
      raf = window.requestAnimationFrame(measure)
    }
    const measure = () => {
      const avatarBtn = shell.querySelector<HTMLElement>('button[aria-label="Open Alli profile"]')
      const sidebar = shell.querySelector<HTMLElement>('[data-slot="community-sidebar-panel-content"]')
      const chat = shell.querySelector<HTMLElement>('[data-slot="community-conversation-surface"]')
      const userBar = shell.querySelector<HTMLElement>('[data-testid="community-user-bar"]')
      if (!avatarBtn || !chat) return setLayout(null)

      const s = shell.getBoundingClientRect()
      const a = avatarBtn.getBoundingClientRect()
      const c = chat.getBoundingClientRect()
      if (!a.width || !c.width || a.top < c.top + 12 || a.bottom > c.bottom - 52) return setLayout(null)

      const sb = sidebar?.getBoundingClientRect()
      const u = userBar?.getBoundingClientRect()
      const isSplitDesktop = Boolean(sb && u && sb.width >= 180 && c.left >= sb.right - 8)

      if (isSplitDesktop && sb && u && sidebar) {
        const items = sidebar.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="treeitem"]')
        const lastBottom = items.length ? items[items.length - 1].getBoundingClientRect().bottom - s.top : 416
        const blankTop = lastBottom + 14
        const blankH = u.top - s.top - 10 - blankTop
        if (blankH < 68) return setLayout(null)

        const compact = blankH < 108
        avatarRef.current = avatarBtn
        setLayout({
          mode: "desktop",
          shellW: s.width,
          shellH: s.height,
          avatar: { left: a.left - s.left, top: a.top - s.top, width: a.width, height: a.height },
          labelLeft: sb.left - s.left + 24,
          labelTop: blankTop + Math.min(20, Math.max(0, (blankH - (compact ? 68 : 88)) * 0.42)),
          compact,
        })
        return
      }

      // Mobile single-pane detail view: keep retrying on rAF until the slide transition lands onscreen.
      if (c.left < s.left - 4 || c.left > s.left + 12) {
        setLayout(null)
        if (slideRetries < 60) {
          slideRetries += 1
          schedule()
        }
        return
      }
      slideRetries = 0
      const row = avatarBtn.closest<HTMLElement>("[data-page-swipe-reply-row]") ?? avatarBtn.parentElement
      const nameBtn = row ? [...row.querySelectorAll<HTMLElement>("button")].find((button) => button.textContent?.trim() === "Alli") : null
      const timeEl = nameBtn?.parentElement?.querySelector<HTMLElement>("time")
      if (!nameBtn) return setLayout(null)

      const n = nameBtn.getBoundingClientRect()
      const stampRight = (timeEl?.getBoundingClientRect().right ?? n.right) - s.left
      const rightSpace = c.right - s.left - stampRight
      if (rightSpace < 96) return setLayout(null)

      const compact = rightSpace < 140
      const labelW = compact ? 92 : 112
      const labelLeft = Math.min(stampRight + (compact ? 12 : 24), c.right - s.left - labelW - 8)
      const labelTop = n.top - s.top - (compact ? 14 : 18)

      avatarRef.current = avatarBtn
      setLayout({
        mode: "mobile",
        shellW: s.width,
        shellH: s.height,
        avatar: { left: a.left - s.left, top: a.top - s.top, width: a.width, height: a.height },
        name: { left: n.left - s.left, top: n.top - s.top, width: n.width },
        labelLeft,
        labelTop,
        compact,
      })
    }
    schedule()
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null
    ro?.observe(shell)
    const mo = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null
    mo?.observe(shell, { childList: true, subtree: true })
    shell.addEventListener("transitionend", schedule, true)
    shell.addEventListener("scroll", schedule, { capture: true, passive: true })
    scrollRoot?.addEventListener("scroll", schedule, { passive: true })
    return () => {
      window.cancelAnimationFrame(raf)
      ro?.disconnect()
      mo?.disconnect()
      shell.removeEventListener("transitionend", schedule, true)
      shell.removeEventListener("scroll", schedule, true)
      scrollRoot?.removeEventListener("scroll", schedule)
    }
  }, [scrollRoot])

  useEffect(() => {
    if (entered || !layout || !avatarRef.current || !labelRef.current) return
    if (typeof IntersectionObserver !== "function") {
      const raf = window.requestAnimationFrame(() => setEntered(true))
      return () => window.cancelAnimationFrame(raf)
    }
    const targets = [avatarRef.current, labelRef.current]
    const inView = new Set<Element>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) inView.add(entry.target)
          else inView.delete(entry.target)
        }
        if (targets.every((target) => inView.has(target))) {
          setEntered(true)
          observer.disconnect()
        }
      },
      { threshold: 1 },
    )
    targets.forEach((target) => observer.observe(target))
    return () => observer.disconnect()
  }, [entered, layout])

  useEffect(() => {
    if (!entered || shownReportedRef.current) return
    shownReportedRef.current = true
    onShown?.()
  }, [entered, onShown])

  useEffect(() => {
    if (visible) return
    const timer = window.setTimeout(onExited, reducedMotion ? 0 : EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [visible, reducedMotion, onExited])

  if (!layout) return null

  const { shellW, shellH, avatar, labelLeft, labelTop, compact, mode } = layout
  const state = !visible ? "exiting" : entered ? "visible" : "idle"
  const ringPad = mode === "mobile" ? 16 : 22
  const rx = (avatar.width + ringPad) / 56
  const ry = (avatar.height + ringPad) / 56
  const tx = avatar.left + avatar.width / 2 - 28 * rx
  const ty = avatar.top + avatar.height / 2 - 28 * ry

  let arrowD: string
  let headD: string
  if (mode === "desktop") {
    const sx = labelLeft + (compact ? 154 : 192)
    const sy = labelTop + (compact ? 26 : 36)
    const ex = avatar.left - 8
    const ey = avatar.top + avatar.height * 0.72
    const mx = (sx + ex) / 2
    arrowD = `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${(mx + 20).toFixed(1)} ${(sy + 12).toFixed(1)}, ${(ex - 18).toFixed(1)} ${(ey + 28).toFixed(1)}, ${ex.toFixed(1)} ${ey.toFixed(1)}`
    headD = `M ${(ex - 12).toFixed(1)} ${(ey + 3).toFixed(1)} L ${ex.toFixed(1)} ${ey.toFixed(1)} L ${(ex - 4).toFixed(1)} ${(ey + 12.5).toFixed(1)}`
  } else {
    const sx = labelLeft - 5
    const sy = layout.name.top - 4
    const ex = layout.name.left + layout.name.width * 0.65
    const ey = layout.name.top - 2
    const peakY = layout.name.top - 16
    const span = sx - ex
    arrowD = `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${(sx - span * 0.25).toFixed(1)} ${peakY.toFixed(1)}, ${(ex + span * 0.25).toFixed(1)} ${(peakY - 2).toFixed(1)}, ${ex.toFixed(1)} ${ey.toFixed(1)}`
    headD = `M ${(ex - 1).toFixed(1)} ${(ey - 8).toFixed(1)} L ${ex.toFixed(1)} ${ey.toFixed(1)} L ${(ex + 8).toFixed(1)} ${(ey - 2).toFixed(1)}`
  }

  return (
    <div
      className={styles.botAnnotation}
      data-testid="landing-shell-bot-annotation"
      data-state={state}
      data-mode={mode}
      data-compact={compact || undefined}
      aria-hidden="true"
    >
      <svg className={styles.botAnnotationSvg} viewBox={`0 0 ${shellW} ${shellH}`} width={shellW} height={shellH} fill="none">
        <g transform={`translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${rx.toFixed(3)} ${ry.toFixed(3)})`}>
          <path className={styles.botAnnotationCircle} pathLength={1} d={RING_PATH} />
        </g>
        <path className={styles.botAnnotationArrow} pathLength={1} d={arrowD} />
        <path className={styles.botAnnotationArrowHead} pathLength={1} d={headD} />
      </svg>
      <div ref={labelRef} className={styles.botAnnotationLabel} style={{ left: `${labelLeft.toFixed(1)}px`, top: `${labelTop.toFixed(1)}px` }}>
        <span className={styles.botAnnotationTitle}>Alli is your<br />local agent!</span>
        {mode === "desktop" && <span className={styles.botAnnotationHint}>click to inspect</span>}
      </div>
    </div>
  )
}
