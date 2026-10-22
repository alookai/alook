"use client"

import { useEffect, useRef, useState } from "react"
import { LandingWorkspaceSkeleton } from "./landing-workspace-skeleton"
import styles from "./landing-interactive-shell.module.css"

export function LandingInteractiveDemo({ heroReady }: { heroReady: boolean }) {
  const [ready, setReady] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
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
      {heroReady && <iframe ref={frame} src="/demo" title="Alook workspace" className={styles.workspace} aria-hidden={!ready} tabIndex={ready ? undefined : -1} style={{ opacity: ready ? 1 : 0 }} />}
    </div>
  </section>
}
