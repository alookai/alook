"use client"

import { useEffect, type RefObject } from "react"

const DESKTOP_SCROLL_QUERY = "(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)"
const ANCHORS = '[data-landing-scroll-anchor], [data-testid="landing-hero"]'

export function useLandingScrollSnap(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (root.current) return attachLandingScrollSnap(root.current)
  }, [root])
}

export function attachLandingScrollSnap(root: HTMLElement) {
  const media = window.matchMedia(DESKTOP_SCROLL_QUERY)
  let frame = 0
  let fallback = 0
  let direction = 0
  let activeDirection = 0
  let accumulated = 0
  let lastWheel = -Infinity
  let lastY = window.scrollY
  let locked = false
  let intent = false

  const cancel = () => {
    window.cancelAnimationFrame(frame)
    window.clearTimeout(fallback)
    frame = 0
    activeDirection = 0
    accumulated = 0
    locked = false
    intent = false
  }
  const destination = (sign: number) => {
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    const points = Array.from(root.querySelectorAll<HTMLElement>(ANCHORS))
      .filter(element => element.getClientRects().length > 0)
      .map(element => {
        const section = element.closest("section") ?? element
        const offset = element.dataset.testid === "landing-hero" ? 0 : 88
        const top = Math.max(0, Math.min(max, window.scrollY + element.getBoundingClientRect().top - offset))
        const bottom = window.scrollY + section.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(section).paddingBottom) || 0)
        return { top, end: Math.max(top, Math.min(max, bottom - window.innerHeight + 24)) }
      })
    if (sign > 0) {
      const index = points.findIndex(point => point.top > window.scrollY + 4)
      if (index > 0 && window.scrollY >= points[index - 1].end - 24) return points[index].top
    } else {
      const index = points.findIndex(point => point.top >= window.scrollY - 72)
      if (index > 0 && window.scrollY > points[index - 1].end + 4) return points[index - 1].top
    }
    return null
  }
  const animate = (top: number) => {
    window.clearTimeout(fallback)
    const start = window.scrollY
    const distance = top - start
    if (Math.abs(distance) < 4) return
    activeDirection = Math.sign(distance)
    locked = true
    accumulated = 0
    intent = false
    const began = performance.now()
    const duration = Math.min(440, Math.max(280, Math.abs(distance) * 0.38))
    const tick = (now: number) => {
      const progress = Math.min(1, (now - began) / duration)
      window.scrollTo({ top: start + distance * (1 - (1 - progress) ** 3), behavior: "instant" })
      if (progress < 1) frame = window.requestAnimationFrame(tick)
      else { frame = 0; activeDirection = 0; lastY = window.scrollY }
    }
    frame = window.requestAnimationFrame(tick)
  }
  const scroll = () => {
    const delta = window.scrollY - lastY
    lastY = window.scrollY
    if (frame || !intent || !media.matches || Math.abs(delta) < 1) return
    direction = Math.sign(delta)
    window.clearTimeout(fallback)
    fallback = window.setTimeout(() => {
      if (!media.matches || document.hidden || frame || !intent) return
      const top = destination(direction)
      if (top !== null) animate(top)
    }, 48)
  }
  const wheel = (event: WheelEvent) => {
    if (!media.matches || document.hidden || event.defaultPrevented || event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    if (!(event.target instanceof Node) || !root.contains(event.target)) return
    let element = event.target instanceof HTMLElement ? event.target : event.target.parentElement
    while (element && element !== root) {
      if (/(auto|scroll)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1) {
        const canScroll = event.deltaY > 0
          ? element.scrollTop + element.clientHeight < element.scrollHeight - 1
          : element.scrollTop > 0
        if (canScroll) return
      }
      element = element.parentElement
    }
    const sign = Math.sign(event.deltaY)
    const now = performance.now()
    if (frame && sign === activeDirection) { event.preventDefault(); lastWheel = now; return }
    if (frame) cancel()
    if (now - lastWheel > 180 || sign !== direction) { locked = false; accumulated = 0 }
    lastWheel = now
    direction = sign
    if (locked) { event.preventDefault(); return }
    intent = true
    const top = destination(sign)
    if (top === null) return
    event.preventDefault()
    accumulated += Math.abs(event.deltaY) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1)
    if (accumulated >= 20) animate(top)
  }
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") { cancel(); return }
    if (!media.matches || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.target instanceof Element && event.target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="tab"], [role="slider"]')) return
    const sign = ["ArrowDown", "PageDown"].includes(event.key) || event.key === " " && !event.shiftKey ? 1
      : ["ArrowUp", "PageUp"].includes(event.key) || event.key === " " && event.shiftKey ? -1 : 0
    if (!sign) { cancel(); return }
    if (frame && sign === activeDirection) { event.preventDefault(); return }
    cancel()
    intent = true
    direction = sign
    const top = destination(sign)
    if (top !== null) { event.preventDefault(); animate(top) }
  }
  const visibility = () => { if (document.hidden) cancel() }
  window.addEventListener("scroll", scroll, { passive: true })
  window.addEventListener("wheel", wheel, { passive: false })
  window.addEventListener("keydown", key)
  window.addEventListener("pointerdown", cancel, { passive: true })
  window.addEventListener("resize", cancel)
  document.addEventListener("visibilitychange", visibility)
  media.addEventListener("change", cancel)
  return () => {
    cancel()
    window.removeEventListener("scroll", scroll)
    window.removeEventListener("wheel", wheel)
    window.removeEventListener("keydown", key)
    window.removeEventListener("pointerdown", cancel)
    window.removeEventListener("resize", cancel)
    document.removeEventListener("visibilitychange", visibility)
    media.removeEventListener("change", cancel)
  }
}
