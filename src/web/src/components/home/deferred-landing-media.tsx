"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { Component, lazy, Suspense, useCallback, useEffect, useRef, type ReactNode } from "react"
import type { LandingShellMotion } from "./landing-shell-motion"
import type { ComponentProps } from "react"

const Shell = lazy(() => import("./landing-shell-motion").then((module) => ({ default: module.LandingShellMotion })))
const Mobile = lazy(() => import("./landing-shell-motion").then((module) => ({ default: module.LandingMobileChatMotion })))
const Profile = lazy(() => import("./landing-profile-content"))

class MediaFallback extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

export function DeferredLandingMedia({ poster, width, height, children, priority = false, alt = "" }: {
  poster: string
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
  const active = near && posterReady
  const finishPoster = useCallback(async (image: HTMLImageElement) => {
    try { await image.decode() } catch {}
    setPosterReady(true)
  }, [setPosterReady])
  useEffect(() => {
    const image = imageRef.current
    if (image?.complete) void finishPoster(image)
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
    <img ref={imageRef} src={poster} width={width} height={height} alt={alt}
      loading={priority ? "eager" : "lazy"} fetchPriority={priority ? "high" : "auto"} decoding="async"
      onLoad={(event) => { void finishPoster(event.currentTarget) }} onError={() => setPosterReady(true)}
      style={{ display: "block", width: "100%", height: "auto" }} />
  )
  return (
    <div ref={ref} data-landing-deferred={poster} style={{ width: "100%", aspectRatio: `${width} / ${height}` }}>
      {active ? <MediaFallback fallback={fallback}><Suspense fallback={fallback}>{children}</Suspense></MediaFallback> : fallback}
    </div>
  )
}

export function DeferredShellMotion(props: ComponentProps<typeof LandingShellMotion>) {
  return <DeferredLandingMedia poster={`/landing/posters/${props.scene}.webp`} width={1120} height={660} priority={props.scene === "server"}><Shell {...props} /></DeferredLandingMedia>
}

export function DeferredMobileChatMotion(props: { beat: number }) {
  return <DeferredLandingMedia poster="/landing/posters/mobile.webp" width={390} height={788}><Mobile {...props} /></DeferredLandingMedia>
}

export function DeferredProfileCard() {
  return <DeferredLandingMedia poster="/landing/posters/profile.webp" width={300} height={308} alt="Maya — Free for dinner. I keep the same account, identity, and relationships across every room."><Profile /></DeferredLandingMedia>
}
