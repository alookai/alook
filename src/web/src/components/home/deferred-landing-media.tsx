"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { Component, lazy, Suspense, useCallback, useEffect, useRef, type ReactNode } from "react"
import type { LandingShellMotion } from "./landing-shell-motion"
import type { ComponentProps } from "react"
import styles from "./deferred-landing-media.module.css"

const Shell = lazy(() => import("./landing-shell-motion").then((module) => ({ default: module.LandingShellMotion })))
const Mobile = lazy(() => import("./landing-shell-motion").then((module) => ({ default: module.LandingMobileChatMotion })))
const Profile = lazy(() => import("./landing-profile-content"))

class MediaFallback extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

export function DeferredLandingMedia({ poster, darkPoster, width, height, children, priority = false, alt = "" }: {
  poster: string
  darkPoster: string
  priority?: boolean
  alt?: string
  width: number
  height: number
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useAtom(useCreateAtom(false))
  const [posterReady, setPosterReady] = useAtom(useCreateAtom(false))
  const imageRef = useRef<HTMLImageElement>(null)
  const darkImageRef = useRef<HTMLImageElement>(null)
  const active = near && posterReady
  const finishPoster = useCallback(async (image: HTMLImageElement) => {
    try { await image.decode() } catch {}
    setPosterReady(true)
  }, [setPosterReady])
  useEffect(() => {
    for (const image of [imageRef.current, darkImageRef.current]) {
      if (image?.complete) void finishPoster(image)
    }
  }, [finishPoster])
  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (typeof IntersectionObserver === "undefined") {
      setNear(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNear(true)
        observer.disconnect()
      }
    }, { rootMargin: "100px" })
    observer.observe(element)
    return () => observer.disconnect()
  }, [setNear])
  const fallback = (
    <>{[poster, darkPoster].map((src, index) => (
      <img key={src} ref={index === 0 ? imageRef : darkImageRef} src={src} width={width} height={height} alt={alt}
        className={index === 0 ? styles.lightPoster : styles.darkPoster}
        loading={priority ? "eager" : "lazy"} fetchPriority={priority ? "high" : "auto"} decoding="async"
        onLoad={(event) => { void finishPoster(event.currentTarget) }} onError={() => setPosterReady(true)} />
    ))}</>
  )
  return (
    <div ref={ref} data-landing-deferred={poster} style={{ width: "100%", aspectRatio: `${width} / ${height}` }}>
      {active ? <MediaFallback fallback={fallback}><Suspense fallback={fallback}>{children}</Suspense></MediaFallback> : fallback}
    </div>
  )
}

export function DeferredShellMotion(props: ComponentProps<typeof LandingShellMotion>) {
  return <DeferredLandingMedia poster={`/landing/posters/${props.scene}.webp`} darkPoster={`/landing/posters/${props.scene}-dark.webp`} width={1120} height={660}><Shell {...props} /></DeferredLandingMedia>
}

export function DeferredMobileChatMotion(props: { beat: number }) {
  return <DeferredLandingMedia poster="/landing/posters/mobile.webp" darkPoster="/landing/posters/mobile-dark.webp" width={390} height={788}><Mobile {...props} /></DeferredLandingMedia>
}

export function DeferredProfileCard() {
  return <DeferredLandingMedia poster="/landing/posters/profile.webp" darkPoster="/landing/posters/profile-dark.webp" width={300} height={308} alt="Maya — Free for dinner. I keep the same account, identity, and relationships across every room."><Profile /></DeferredLandingMedia>
}
