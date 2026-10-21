"use client"

import { useEffect, useRef, useState } from "react"
import { LandingWorkspaceSkeleton } from "./landing-workspace-skeleton"
import styles from "./landing-interactive-shell.module.css"

export function LandingInteractiveDemo() {
  const [started, setStarted] = useState(false)
  const [ready, setReady] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    const start = () => setStarted(true)
    if (document.readyState === "complete") start()
    else window.addEventListener("load", start, { once: true })
    return () => window.removeEventListener("load", start)
  }, [])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.source === frame.current?.contentWindow && event.data?.type === "alook-demo-ready") setReady(true)
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [])
  return <section id="workspace" className={styles.section} aria-label="Explore Alook" data-testid="landing-interactive-section">
    <div className={styles.frame} aria-busy={!ready}>
      {!ready && <LandingWorkspaceSkeleton />}
      {started && <iframe ref={frame} src="/demo" title="Alook workspace" className={styles.workspace} aria-hidden={!ready} tabIndex={ready ? undefined : -1} style={{ opacity: ready ? 1 : 0 }} />}
    </div>
  </section>
}
