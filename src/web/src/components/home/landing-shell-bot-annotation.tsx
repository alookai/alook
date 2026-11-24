"use client"

import { useEffect, useState, type RefObject } from "react"
import { useReducedMotion } from "@/hooks/use-reduced-motion"
import styles from "./landing-interactive-shell.module.css"

type AnnotationGeometry = {
  shellWidth: number
  shellHeight: number
  avatar: { left: number; top: number; width: number; height: number }
  labelLeft: number
  labelTop: number
  labelWidth: number
  compact: boolean
}

const EXIT_DURATION_MS = 340

export function LandingShellBotAnnotation({
  shellRef,
  scrollRoot,
  entered,
  visible,
  onExited,
}: {
  shellRef: RefObject<HTMLDivElement | null>
  scrollRoot: HTMLDivElement | null
  entered: boolean
  visible: boolean
  onExited: () => void
}) {
  const reducedMotion = useReducedMotion()
  const [geometry, setGeometry] = useState<AnnotationGeometry | null>(null)

  useEffect(() => {
    const shell = shellRef.current?.querySelector<HTMLElement>('[data-testid="landing-interactive-shell"]') ?? shellRef.current
    if (!shell) return

    let frameId = 0
    const measure = () => {
      const avatarBtn = shell.querySelector<HTMLButtonElement>('button[aria-label="Open Alli profile"]')
      const chatSurface = shell.querySelector<HTMLElement>('[data-slot="community-conversation-surface"]')
      const rail = shell.querySelector<HTMLElement>('[data-community-rail]')
      const userBar = shell.querySelector<HTMLElement>('[data-testid="community-user-bar"]')
      if (!avatarBtn || !chatSurface || !rail || !userBar) {
        setGeometry(null)
        return
      }

      const shellRect = shell.getBoundingClientRect()
      const avatarRect = avatarBtn.getBoundingClientRect()
      const chatRect = chatSurface.getBoundingClientRect()
      const railRect = rail.getBoundingClientRect()
      const userBarRect = userBar.getBoundingClientRect()

      if (avatarRect.width === 0 || chatRect.width === 0 || shellRect.width === 0) {
        setGeometry(null)
        return
      }

      const sidebarLeft = railRect.right - shellRect.left
      const sidebarRight = chatRect.left - shellRect.left
      const sidebarWidth = sidebarRight - sidebarLeft

      // Only show on desktop split layout where the channel sidebar sits beside the chat pane.
      if (sidebarWidth < 180) {
        setGeometry(null)
        return
      }

      const avatarVisibleInChat =
        avatarRect.top >= chatRect.top + 12 &&
        avatarRect.bottom <= chatRect.bottom - 52
      if (!avatarVisibleInChat) {
        setGeometry(null)
        return
      }

      // Find the lowest visible channel/sidebar item above the user bar so the note sits in pure blank space.
      let sidebarContentBottom = 0
      const sidebarItems = shell.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="treeitem"]')
      for (const item of sidebarItems) {
        if (rail.contains(item) || userBar.contains(item) || chatSurface.contains(item)) continue
        const r = item.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        if (r.left >= railRect.right - 4 && r.right <= chatRect.left + 8 && r.bottom <= userBarRect.top) {
          sidebarContentBottom = Math.max(sidebarContentBottom, r.bottom - shellRect.top)
        }
      }

      const userBarTop = userBarRect.top - shellRect.top
      const blankTop = sidebarContentBottom > 0 ? sidebarContentBottom + 14 : 430
      const blankBottom = userBarTop - 10
      const blankHeight = blankBottom - blankTop

      if (blankHeight < 68) {
        setGeometry(null)
        return
      }

      const compact = blankHeight < 108
      const noteHeight = compact ? 68 : 88
      const labelTop = blankTop + Math.min(20, Math.max(0, (blankHeight - noteHeight) * 0.42))
      const labelLeft = sidebarLeft + 24
      const labelWidth = compact ? 148 : 182

      setGeometry({
        shellWidth: shellRect.width,
        shellHeight: shellRect.height,
        avatar: {
          left: avatarRect.left - shellRect.left,
          top: avatarRect.top - shellRect.top,
          width: avatarRect.width,
          height: avatarRect.height,
        },
        labelLeft,
        labelTop,
        labelWidth,
        compact,
      })
    }

    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frameId)
      frameId = window.requestAnimationFrame(measure)
    }

    scheduleMeasure()

    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleMeasure) : null
    resizeObserver?.observe(shell)
    const mutationObserver = typeof MutationObserver === "function" ? new MutationObserver(scheduleMeasure) : null
    mutationObserver?.observe(shell, { childList: true, subtree: true })
    scrollRoot?.addEventListener("scroll", scheduleMeasure, { passive: true })

    return () => {
      window.cancelAnimationFrame(frameId)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      scrollRoot?.removeEventListener("scroll", scheduleMeasure)
    }
  }, [shellRef, scrollRoot])

  useEffect(() => {
    if (!geometry || window.parent === window) return
    const noteHeight = geometry.compact ? 72 : 94
    const top = Math.min(geometry.avatar.top - 10, geometry.labelTop)
    const bottom = Math.max(geometry.avatar.top + geometry.avatar.height + 10, geometry.labelTop + noteHeight)
    window.parent.postMessage(
      { type: "alook-demo-annotation-bounds", top, bottom },
      window.location.origin,
    )
  }, [geometry])

  useEffect(() => {
    if (visible) return
    const timer = window.setTimeout(onExited, reducedMotion ? 0 : EXIT_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [visible, reducedMotion, onExited])

  if (!geometry) return null

  const { shellWidth, shellHeight, avatar, labelLeft, labelTop, labelWidth, compact } = geometry
  const state = !visible ? "exiting" : entered ? "visible" : "idle"

  const ringCenterX = avatar.left + avatar.width / 2
  const ringCenterY = avatar.top + avatar.height / 2
  const ringScaleX = (avatar.width + 22) / 56
  const ringScaleY = (avatar.height + 22) / 56
  const ringTranslateX = ringCenterX - 28 * ringScaleX
  const ringTranslateY = ringCenterY - 28 * ringScaleY

  // Graceful hand-drawn curved arrow sweeping from the right of the note up-right to Alli's circled avatar.
  const arrowStartX = labelLeft + labelWidth + (compact ? 6 : 10)
  const arrowStartY = labelTop + (compact ? 26 : 36)
  const arrowEndX = avatar.left - 8
  const arrowEndY = avatar.top + avatar.height * 0.72
  const midX = (arrowStartX + arrowEndX) / 2
  const arrowCtrl1X = midX + 20
  const arrowCtrl1Y = arrowStartY + 12
  const arrowCtrl2X = arrowEndX - 18
  const arrowCtrl2Y = arrowEndY + 28
  const arrowPath = `M ${arrowStartX.toFixed(1)} ${arrowStartY.toFixed(1)} C ${arrowCtrl1X.toFixed(1)} ${arrowCtrl1Y.toFixed(1)}, ${arrowCtrl2X.toFixed(1)} ${arrowCtrl2Y.toFixed(1)}, ${arrowEndX.toFixed(1)} ${arrowEndY.toFixed(1)}`
  const arrowHeadPath = `M ${(arrowEndX - 12).toFixed(1)} ${(arrowEndY + 3).toFixed(1)} L ${arrowEndX.toFixed(1)} ${arrowEndY.toFixed(1)} L ${(arrowEndX - 4).toFixed(1)} ${(arrowEndY + 12.5).toFixed(1)}`

  return (
    <div
      className={styles.botAnnotation}
      data-testid="landing-shell-bot-annotation"
      data-state={state}
      data-compact={compact || undefined}
      aria-hidden="true"
    >
      <svg
        className={styles.botAnnotationSvg}
        viewBox={`0 0 ${shellWidth} ${shellHeight}`}
        width={shellWidth}
        height={shellHeight}
        fill="none"
      >
        <g transform={`translate(${ringTranslateX.toFixed(1)} ${ringTranslateY.toFixed(1)}) scale(${ringScaleX.toFixed(3)} ${ringScaleY.toFixed(3)})`}>
          <path
            className={styles.botAnnotationCircle}
            pathLength={1}
            d="M 35 6 C 18 2, 4 14, 5 29 C 6 44, 19 52, 33 50 C 47 48, 53 35, 51 22 C 49 11, 39 5, 25 8"
          />
        </g>
        <path
          className={styles.botAnnotationArrow}
          pathLength={1}
          d={arrowPath}
        />
        <path
          className={styles.botAnnotationArrowHead}
          pathLength={1}
          d={arrowHeadPath}
        />
      </svg>
      <div
        className={styles.botAnnotationLabel}
        style={{ left: `${labelLeft.toFixed(1)}px`, top: `${labelTop.toFixed(1)}px` }}
      >
        <span className={styles.botAnnotationTitle}>
          Alli is your
          <br />
          local agent!
        </span>
        <span className={styles.botAnnotationHint}>click to inspect</span>
      </div>
    </div>
  )
}
