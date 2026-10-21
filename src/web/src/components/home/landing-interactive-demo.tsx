"use client"

import { useEffect, useRef, useState } from "react"
import { AlookLoading } from "@/components/brand/alook-loading/AlookLoading"
import styles from "./landing-interactive-shell.module.css"

export function LandingInteractiveDemo() {
  const [started, setStarted] = useState(false)
  const [ready, setReady] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    let idle: number | undefined
    let timer: number | undefined
    const start = () => { idle = undefined; timer = undefined; setStarted(true) }
    const schedule = () => {
      if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(start, { timeout: 2000 })
      else timer = window.setTimeout(start, 200)
    }
    if (document.readyState === "complete") schedule()
    else window.addEventListener("load", schedule, { once: true })
    return () => {
      window.removeEventListener("load", schedule)
      if (idle !== undefined) window.cancelIdleCallback(idle)
      if (timer !== undefined) window.clearTimeout(timer)
    }
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
      {!ready && <div className={styles.loading}><AlookLoading size={96} label="Loading Alook workspace" paused={!started} /></div>}
      {started && <iframe ref={frame} src="/demo" title="Alook workspace" className={styles.workspace} aria-hidden={!ready} tabIndex={ready ? undefined : -1} style={{ opacity: ready ? 1 : 0 }} />}
    </div>
  </section>
}
