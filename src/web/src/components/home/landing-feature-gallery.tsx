"use client"

import { lazy, Suspense, useEffect, useRef, useState, type ReactNode, type KeyboardEvent } from "react"
import { Pause, Play } from "lucide-react"
import { tid } from "@/lib/community/testids"
import { MediaFallback } from "./deferred-landing-media"
import { trackLandingCtaClicked } from "@/lib/analytics"
import { sceneDurationMs, type LandingScene } from "./landing-shell-motion-timeline"
import styles from "./landing-feature-gallery.module.css"
import mediaStyles from "./deferred-landing-media.module.css"
import pageStyles from "./landing-page.module.css"

const FeatureScene = lazy(() => import("./landing-feature-scene"))
const features: { id: string; tab: string; title: string; description: string; cta: string; scene: LandingScene }[] = [
  { id: "product", tab: "Collaborate", title: "Let teammates talk to your agent.", description: "Ask for a preview, request changes, and review results in one conversation.", cta: "Share your agent", scene: "server" },
  { id: "identity", tab: "Your agent", title: "A companion of your own.", description: "Your agent belongs to you. Bring them along to any room or team you join.", cta: "Invite your agent", scene: "identity" },
  { id: "continuity", tab: "Keep context", title: "Pick up where you left off.", description: "Your agent uses earlier conversations and saved notes to bring back an update.", cta: "Start a task", scene: "continuity" },
  { id: "reach", tab: "On your phone", title: "Check in from your phone.", description: "Read updates and give the next instruction. Keep your agent’s computer online.", cta: "Work anywhere", scene: "server" },
  { id: "ownership", tab: "Your setup", title: "Keep your existing setup.", description: "Connect the agent you already use, running on your computer with your projects and tools.", cta: "Connect your agent", scene: "machine" },
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
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const current = features[selected]

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
      <div className={styles.controls}>
        <div className={styles.tabs} role="tablist" aria-label="Features">
          {features.map((feature, index) => <button key={feature.id} ref={element => { tabs.current[index] = element }}
            id={`feature-tab-${feature.id}`} type="button" role="tab" aria-selected={selected === index}
            aria-controls="feature-panel" tabIndex={selected === index ? 0 : -1}
            onClick={() => select(index)} onKeyDown={event => navigate(event, index)}>{feature.tab}</button>)}
        </div>
        {!reduced && <button type="button" className={styles.rotation} aria-label={paused ? "Resume feature rotation" : "Pause feature rotation"}
          onClick={() => setPaused(value => !value)}>{paused ? <Play size={18} /> : <Pause size={18} />}</button>}
      </div>
      <div id="feature-panel" role="tabpanel" aria-labelledby={`feature-tab-${current.id}`} className={`${styles.panel} ${current.id === "identity" ? styles.identity : ""}`}>
        <div className={styles.copy}>
          <h2>{current.title}</h2>
          <p>{current.description}</p>
          <a href={isLoggedIn ? "/c/me" : "/sign-in"} className={pageStyles.sectionCta}
            data-testid={`landing-section-cta-${current.id}`}
            onClick={() => trackLandingCtaClicked({ cta_name: `${current.id}_${isLoggedIn ? "open_app" : "get_started"}` })}>{current.cta}</a>
        </div>
        <div ref={section} className={styles.stage}>
          {loadedFeature === current.id ? <MediaFallback key={current.id} fallback={<FeaturePoster scene={current.scene} />}><Suspense fallback={<FeaturePoster scene={current.scene} />}>
            <SceneReady key={current.id} onReady={setMediaReady}><FeatureScene feature={current.id} container={section.current} /></SceneReady>
          </Suspense></MediaFallback> : <FeaturePoster scene={current.scene} />}
        </div>
      </div>
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
