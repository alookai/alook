"use client"

import { useRef, type CSSProperties, type PointerEvent, type ReactNode } from "react"
import { Cassette, CdPlayer, FlipPhone, Mac } from "@/components/brand/retro-objects"
import styles from "./landing-page.module.css"

/** One cut-paper piece. It can be picked up and dropped anywhere, like paper
 * on a desk (Gus #2439): it lifts while held and stays where it lands. */
function Piece({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; x: number; y: number; dx: number; dy: number } | null>(null)
  const offset = useRef({ x: 0, y: 0 })

  const apply = () => {
    ref.current?.style.setProperty("--drag-x", `${offset.current.x}px`)
    ref.current?.style.setProperty("--drag-y", `${offset.current.y}px`)
  }
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: offset.current.x, dy: offset.current.y }
    event.currentTarget.dataset.dragging = "true"
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (!start || start.id !== event.pointerId) return
    offset.current = { x: start.dx + event.clientX - start.x, y: start.dy + event.clientY - start.y }
    apply()
  }
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return
    drag.current = null
    delete event.currentTarget.dataset.dragging
  }

  const reset = () => { offset.current = { x: 0, y: 0 }; apply() }

  return (
    <div ref={ref} className={`${styles.collagePiece} ${className}`} style={{ "--drag-x": "0px", "--drag-y": "0px" } as CSSProperties}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={reset}>
      {children}
    </div>
  )
}

export function LandingClosingCollage() {
  return (
    <div className={styles.closingCollage} aria-hidden="true">
      <Piece className={styles.collageMac}><Mac className={styles.collageItem} label="Alook" labelFont="var(--font-brand)" /></Piece>
      <Piece className={styles.collageCd}><CdPlayer className={styles.collageItem} /></Piece>
      <Piece className={styles.collageCassette}><Cassette className={styles.collageItem} /></Piece>
      <Piece className={styles.collagePhone}><FlipPhone className={styles.collageItem} /></Piece>
    </div>
  )
}
