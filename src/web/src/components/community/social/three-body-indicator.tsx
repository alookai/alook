"use client"

import { useEffect, useRef } from "react"
import orbit from "./three-body-orbit.json"
import styles from "./bot-audit-preview.module.css"

function frameAt(seconds: number) {
  const out = orbit.orbit.split("")
  const count = orbit.cells.length
  const cell = (index: number) => orbit.cells[((index % count) + count) % count]!
  const head = Math.floor(((seconds / orbit.lap) % 1) * count)
  for (let body = 0; body < 3; body++) {
    const position = head + body * count / 3
    let seen = cell(position), tail = 0
    for (let step = 1; step <= orbit.trail; step++) {
      const next = cell(position - step)
      if (next === seen) continue
      seen = next
      tail++
      out[next] = tail <= 1 ? "o" : tail <= 3 || step < orbit.trail * 0.45 ? ":" : "·"
    }
  }
  for (let body = 0; body < 3; body++) out[cell(head + body * count / 3)] = "O"
  return Array.from({ length: orbit.rows }, (_, row) =>
    out.slice(row * orbit.cols, (row + 1) * orbit.cols).join(""),
  ).join("\n")
}

const firstFrame = frameAt(0)

export function ThreeBodyIndicator() {
  const element = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)")
    if (!media) return
    let visible = true, request = 0, elapsed = 0, painted = -Infinity
    let last: number | undefined
    const tick = (now: number) => {
      if (last !== undefined) elapsed += now - last
      last = now
      const frame = Math.floor(elapsed * orbit.fps / 1000)
      if (frame !== painted && element.current) {
        element.current.textContent = frameAt(elapsed / 1000)
        painted = frame
      }
      request = requestAnimationFrame(tick)
    }
    const sync = () => {
      cancelAnimationFrame(request)
      last = undefined
      painted = -Infinity
      if (media.matches && element.current) element.current.textContent = firstFrame
      else if (visible && !document.hidden) request = requestAnimationFrame(tick)
    }
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      sync()
    })
    if (element.current) observer?.observe(element.current)
    media.addEventListener("change", sync)
    document.addEventListener("visibilitychange", sync)
    sync()
    return () => {
      cancelAnimationFrame(request)
      observer?.disconnect()
      media.removeEventListener("change", sync)
      document.removeEventListener("visibilitychange", sync)
    }
  }, [])
  return <span className={styles.asciiOrbit}><pre ref={element} aria-hidden className="font-mono">{firstFrame}</pre></span>
}
