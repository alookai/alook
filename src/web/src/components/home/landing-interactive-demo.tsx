"use client"

import { useEffect, useRef, useState } from "react"
import { HandAccent } from "@/components/brand/hand-accent"
import { LandingWorkspaceSkeleton } from "./landing-workspace-skeleton"
import styles from "./landing-interactive-shell.module.css"

export function LandingInteractiveDemo({ heroReady }: { heroReady: boolean }) {
  const [ready, setReady] = useState(false)
  const [inView, setInView] = useState(false)
  const [annotationBounds, setAnnotationBounds] = useState<{ top: number; bottom: number } | null>(null)
  const frameWrap = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return
      if (event.data?.type === "alook-demo-ready") setReady(true)
      if (
        event.data?.type === "alook-demo-annotation-bounds" &&
        typeof event.data.top === "number" &&
        typeof event.data.bottom === "number"
      ) {
        setAnnotationBounds({ top: event.data.top, bottom: event.data.bottom })
      }
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [])
  useEffect(() => {
    if (!ready || !annotationBounds || inView) return
    const checkVisible = () => {
      const target = frameWrap.current
      if (!target) return
      const rect = target.getBoundingClientRect()
      const top = rect.top + annotationBounds.top
      const bottom = rect.top + annotationBounds.bottom
      if (top >= 0 && bottom <= window.innerHeight - 16) {
        setInView(true)
      }
    }
    const raf = window.requestAnimationFrame(checkVisible)
    window.addEventListener("scroll", checkVisible, { passive: true })
    window.addEventListener("resize", checkVisible, { passive: true })
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener("scroll", checkVisible)
      window.removeEventListener("resize", checkVisible)
    }
  }, [ready, annotationBounds, inView])
  useEffect(() => {
    if (!ready || !inView) return
    frame.current?.contentWindow?.postMessage({ type: "alook-demo-in-view" }, window.location.origin)
  }, [ready, inView])
  return <section id="workspace" tabIndex={-1} className={styles.section} aria-label="Explore Alook" data-testid="landing-interactive-section">
    <h2 id="workspace-heading" tabIndex={-1} className={styles.demoHeading} data-landing-scroll-anchor>Imagine your <HandAccent>team and friends</HandAccent> here</h2>
    <div ref={frameWrap} className={styles.frame} aria-busy={!ready}>
      {!ready && <LandingWorkspaceSkeleton />}
      {heroReady && <iframe ref={frame} src="/demo" title="Alook workspace" className={styles.workspace} aria-hidden={!ready} tabIndex={ready ? undefined : -1} style={{ opacity: ready ? 1 : 0 }} />}
    </div>
  </section>
}
