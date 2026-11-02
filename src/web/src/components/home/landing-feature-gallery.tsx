"use client"

import { StepSlide } from "@/components/ui/step-slide"
import { DocumentNavigationLink } from "./document-navigation-link"

import { lazy, Suspense, useEffect, useRef, useState, type ReactNode, type KeyboardEvent } from "react"
import { trackLandingCtaClicked } from "@/lib/analytics"
import pageStyles from "./landing-page.module.css"
import { tid } from "@/lib/community/testids"
import { MediaFallback } from "./deferred-landing-media"
import { sceneDurationMs, type LandingScene } from "./landing-shell-motion-timeline"
import styles from "./landing-feature-gallery.module.css"
import mediaStyles from "./deferred-landing-media.module.css"

const FeatureScene = lazy(() => import("./landing-feature-scene"))
const features: { id: string; tab: string; title: string; description: string; cta: string; scene: LandingScene }[] = [
  { id: "product", description: "Bring an agent into a group chat so friends and teammates can work with it together.", title: "Chat with shared agents", cta: "Share your agent", tab: "Collaboration", scene: "server" },
  { id: "ownership", description: "Keep the agent tools you already use, running on your own computer.", title: "Run agents on your computer", cta: "Connect your agent", tab: "Free and local", scene: "machine" },
  { id: "reach", description: "Send a task from your phone and check the result while your agent works on your computer.", title: "Control your agent from your phone", cta: "Work anywhere", tab: "Remote control", scene: "server" },
  { id: "identity", description: "Give your agent one profile across rooms, so everyone knows who they’re talking to.", title: "One agent, every room", cta: "Invite your agent", tab: "Agent identity", scene: "identity" },
  { id: "continuity", description: "Return to a task after a break. Your agent can find earlier messages and pick up where you left off.", title: "Continue earlier conversations", cta: "Start a task", tab: "Persistent Memory", scene: "continuity" },
]

export function LandingFeatureGallery({ isLoggedIn }: { isLoggedIn: boolean }) {
  const [selected, setSelected] = useState(0)
  const [visible, setVisible] = useState(false)
  const [loadedFeature, setLoadedFeature] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [reduced, setReduced] = useState(true)
  const [documentVisible, setDocumentVisible] = useState(true)
  const [mediaReady, setMediaReady] = useState(false)
  const section = useRef<HTMLDivElement>(null)
  const tabList = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const drag = useRef<{ x: number; scroll: number; moved: boolean } | null>(null)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const current = features[selected]

  useEffect(() => {
    const tab = tabs.current[selected]
    const list = tab?.parentElement
    if (!tab || !list) return
    const item = tab.getBoundingClientRect()
    const row = list.getBoundingClientRect()
    if (item.left < row.left + 24) list.scrollLeft += item.left - row.left - 24
    else if (item.right > row.right - 24) list.scrollLeft += item.right - row.right + 24
  }, [selected])

  useEffect(() => {
    const list = tabList.current
    if (!list) return
    const sync = () => setEdges({ left: list.scrollLeft > 1, right: list.scrollLeft + list.clientWidth < list.scrollWidth - 1 })
    sync()
    list.addEventListener("scroll", sync, { passive: true })
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || list.scrollWidth <= list.clientWidth) return
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? list.clientWidth : 1)
      const next = Math.max(0, Math.min(list.scrollWidth - list.clientWidth, list.scrollLeft + delta))
      if (next === list.scrollLeft) return
      event.preventDefault()
      list.scrollLeft = next
    }
    list.addEventListener("wheel", wheel, { passive: false })
    const observer = new ResizeObserver(sync)
    observer.observe(list)
    return () => { list.removeEventListener("scroll", sync); list.removeEventListener("wheel", wheel); observer.disconnect() }
  }, [])

  useEffect(() => {
    const element = section.current
    if (!element) return
    if (!("IntersectionObserver" in window)) { setVisible(true); return }
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.3)), { threshold: 0.3 })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (visible) setLoadedFeature(current.id)
  }, [visible, current.id])

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const syncMotion = () => setReduced(query.matches)
    const syncVisibility = () => setDocumentVisible(document.visibilityState !== "hidden")
    syncMotion()
    syncVisibility()
    query.addEventListener("change", syncMotion)
    document.addEventListener("visibilitychange", syncVisibility)
    return () => {
      query.removeEventListener("change", syncMotion)
      document.removeEventListener("visibilitychange", syncVisibility)
    }
  }, [])

  useEffect(() => {
    if (!visible || !documentVisible || reduced || paused || hovered || focused || !mediaReady) return
    const timer = window.setTimeout(() => {
      setMediaReady(false)
      setSelected(index => (index + 1) % features.length)
    }, Math.max(15000, sceneDurationMs(current.scene) + 1500))
    return () => window.clearTimeout(timer)
  }, [visible, documentVisible, reduced, paused, hovered, focused, mediaReady, current.scene])

  function select(index: number) {
    setPaused(true)
    if (index !== selected) setMediaReady(false)
    setSelected(index)
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "ArrowRight" ? (index + 1) % features.length
      : event.key === "ArrowLeft" ? (index + features.length - 1) % features.length
      : event.key === "Home" ? 0 : event.key === "End" ? features.length - 1 : null
    if (next === null) return
    event.preventDefault()
    select(next)
    tabs.current[next]?.focus()
  }

  return <section id="product" className={`${styles.section} ${current.id === "ownership" ? styles.dark : ""}`} aria-label="Explore Alook features"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}>
    <div className={styles.container} data-testid={tid.landingMainContainer}>
      <div className={styles.controls} data-left={edges.left} data-right={edges.right}>
        <div ref={tabList} className={`${styles.tabs} thin-scrollbar`} role="tablist" aria-label="Features"
          data-overflow={edges.left || edges.right}
          onPointerDown={event => {
            if (event.pointerType !== "mouse" || event.button !== 0 || event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) { drag.current = null; return }
            drag.current = { x: event.clientX, scroll: event.currentTarget.scrollLeft, moved: false }
          }}
          onPointerMove={event => {
            const start = drag.current
            if (event.pointerType !== "mouse" || !start || !event.buttons) return
            const distance = event.clientX - start.x
            if (!start.moved && Math.abs(distance) < 6) return
            start.moved = true
            event.currentTarget.setPointerCapture(event.pointerId)
            event.currentTarget.scrollLeft = start.scroll - distance
          }}
          onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
          onPointerCancel={() => { drag.current = null }}
          onClickCapture={event => { if (event.detail > 0 && drag.current?.moved) { event.preventDefault(); event.stopPropagation(); drag.current = null } }}>
          {features.map((feature, index) => <button key={feature.id} ref={element => { tabs.current[index] = element }}
            id={`feature-tab-${feature.id}`} type="button" role="tab" aria-selected={selected === index}
            aria-controls="feature-panel" tabIndex={selected === index ? 0 : -1}
            onClick={() => select(index)} onKeyDown={event => navigate(event, index)}>{feature.tab}</button>)}
        </div>
      </div>
      <StepSlide testId="landing-feature-transition" step={current.id} order={selected} className={styles.slide}>
      <div id="feature-panel" role="tabpanel" aria-labelledby={`feature-tab-${current.id}`} className={styles.panel}>
        <div className={styles.copy}>
          <h2>{current.title}</h2>
          <p>{current.description}</p>
          <DocumentNavigationLink href={isLoggedIn ? "/c/me" : "/sign-in"} className={`${pageStyles.sectionCta} ${styles.cta}`}
            data-testid={`landing-section-cta-${current.id}`}
            onClick={() => trackLandingCtaClicked({ cta_name: `${current.id}_${isLoggedIn ? "open_app" : "get_started"}` })}>{current.cta}</DocumentNavigationLink>
        </div>
        <div ref={section} className={styles.stage}>
          {loadedFeature === current.id ? <MediaFallback key={current.id} fallback={<FeaturePoster scene={current.scene} />}><Suspense fallback={<FeaturePoster scene={current.scene} />}>
            <SceneReady key={current.id} onReady={setMediaReady}><FeatureScene feature={current.id} /></SceneReady>
          </Suspense></MediaFallback> : <FeaturePoster scene={current.scene} />}
        </div>
      </div>
      </StepSlide>
    </div>
  </section>
}

function SceneReady({ onReady, children }: { onReady: (ready: boolean) => void; children: ReactNode }) {
  useEffect(() => { onReady(true); return () => onReady(false) }, [onReady])
  return children
}

function FeaturePoster({ scene }: { scene: LandingScene }) {
  return <div className={styles.poster}>{[false, true].map(dark => <img key={String(dark)} className={dark ? mediaStyles.darkPoster : mediaStyles.lightPoster} src={`/landing/posters/${scene}${dark ? "-dark" : ""}.webp`} width={1120} height={660} loading="lazy" alt="" />)}</div>
}
