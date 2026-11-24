import { useEffect, useRef, useState } from "react"

export type LandingBotAnnotationLayout = {
  shellW: number
  shellH: number
  avatar: { left: number; top: number; width: number; height: number }
  labelLeft: number
  labelTop: number
  compact: boolean
}

const EXIT_MS = 340

export function useLandingShellBotAnnotation({
  scrollRoot,
  visible,
  reducedMotion,
  onExited,
}: {
  scrollRoot: HTMLDivElement | null
  visible: boolean
  reducedMotion: boolean
  onExited: () => void
}) {
  const labelRef = useRef<HTMLDivElement | null>(null)
  const avatarRef = useRef<HTMLElement | null>(null)
  const [layout, setLayout] = useState<LandingBotAnnotationLayout | null>(null)
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('[data-testid="landing-interactive-shell"]')
    if (!shell) return
    let raf = 0
    const measure = () => {
      const avatarBtn = shell.querySelector<HTMLElement>('button[aria-label="Open Alli profile"]')
      const sidebar = shell.querySelector<HTMLElement>('[data-slot="community-sidebar-panel-content"]')
      const chat = shell.querySelector<HTMLElement>('[data-slot="community-conversation-surface"]')
      const userBar = shell.querySelector<HTMLElement>('[data-testid="community-user-bar"]')
      if (!avatarBtn || !sidebar || !chat || !userBar) return setLayout(null)

      const s = shell.getBoundingClientRect()
      const a = avatarBtn.getBoundingClientRect()
      const sb = sidebar.getBoundingClientRect()
      const c = chat.getBoundingClientRect()
      const u = userBar.getBoundingClientRect()
      if (!a.width || sb.width < 180 || a.top < c.top + 12 || a.bottom > c.bottom - 52) return setLayout(null)

      const items = sidebar.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="treeitem"]')
      const lastBottom = items.length ? items[items.length - 1].getBoundingClientRect().bottom - s.top : 416
      const blankTop = lastBottom + 14
      const blankH = u.top - s.top - 10 - blankTop
      if (blankH < 68) return setLayout(null)

      const compact = blankH < 108
      avatarRef.current = avatarBtn
      setLayout({
        shellW: s.width,
        shellH: s.height,
        avatar: { left: a.left - s.left, top: a.top - s.top, width: a.width, height: a.height },
        labelLeft: sb.left - s.left + 24,
        labelTop: blankTop + Math.min(20, Math.max(0, (blankH - (compact ? 68 : 88)) * 0.42)),
        compact,
      })
    }
    const schedule = () => {
      window.cancelAnimationFrame(raf)
      raf = window.requestAnimationFrame(measure)
    }
    schedule()
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null
    ro?.observe(shell)
    const mo = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null
    mo?.observe(shell, { childList: true, subtree: true })
    scrollRoot?.addEventListener("scroll", schedule, { passive: true })
    return () => {
      window.cancelAnimationFrame(raf)
      ro?.disconnect()
      mo?.disconnect()
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
    if (visible) return
    const timer = window.setTimeout(onExited, reducedMotion ? 0 : EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [visible, reducedMotion, onExited])

  return { labelRef, layout, entered }
}
