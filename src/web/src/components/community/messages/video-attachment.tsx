"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from "react"
import { flushSync } from "react-dom"
import { Play, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { useFileDownload } from "@/lib/file-download"
import type { FileAttachment } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import { attachmentImageFrameStyle } from "./attachment-layout"
import { Video } from "@videojs/react/video"
import { AttachmentVideoPlayer, VideoControls } from "./video-controls"

type PlaybackStatus = "loading" | "ready" | "blocked" | "error"
type PlaybackSnapshot = { time: number; playing: boolean; muted: boolean; volume: number; rate: number }
const initialPlayback: PlaybackSnapshot = { time: 0, playing: false, muted: false, volume: 1, rate: 1 }

function playbackSnapshot(player: HTMLVideoElement): PlaybackSnapshot {
  return { time: player.currentTime, playing: !player.paused && !player.ended, muted: player.muted, volume: player.volume, rate: player.playbackRate }
}

export function videoPreviewUrl(source: string): string {
  return source.includes("#") ? source : `${source}#t=0`
}

function playbackVisible(player: HTMLVideoElement | null): boolean {
  if (!document.hidden) return true
  if (!player) return false
  return Boolean(document.fullscreenElement?.contains(player))
    || ("webkitDisplayingFullscreen" in player && player.webkitDisplayingFullscreen === true)
    || ("webkitPresentationMode" in player && player.webkitPresentationMode === "fullscreen")
}

function subscribePlaybackVisibility(notify: () => void): () => void {
  const lifetime = new window.AbortController()
  document.addEventListener("visibilitychange", notify, { signal: lifetime.signal })
  document.addEventListener("fullscreenchange", notify, { signal: lifetime.signal })
  document.addEventListener("webkitpresentationmodechanged", notify, { signal: lifetime.signal, capture: true })
  document.addEventListener("webkitendfullscreen", notify, { signal: lifetime.signal, capture: true })
  return () => lifetime.abort()
}

function usePlaybackVisible(playerRef: RefObject<HTMLVideoElement | null>): boolean {
  const snapshot = useCallback(() => playbackVisible(playerRef.current), [playerRef])
  return useSyncExternalStore(subscribePlaybackVisibility, snapshot, () => false)
}

function releaseVideo(video: HTMLVideoElement): void {
  video.pause()
  video.removeAttribute("src")
  video.load()
}

function VideoPlayback({ attachment, initial, playerRef, expanded, expandRef, onExpand, download }: {
  attachment: FileAttachment
  initial: PlaybackSnapshot
  playerRef: RefObject<HTMLVideoElement | null>
  expanded: boolean
  expandRef: RefObject<HTMLButtonElement | null>
  onExpand: () => void
  download: ReturnType<typeof useFileDownload>
}) {
  const [status, setStatus] = useAtom(useCreateAtom<PlaybackStatus>("loading"))
  const [attempt, setAttempt] = useAtom(useCreateAtom(0))
  const generationRef = useRef(0)
  const playOnAttachRef = useRef(initial.playing)
  const positionRef = useRef(initial.time)
  const settingsRef = useRef(initial)
  const playbackAllowed = usePlaybackVisible(playerRef)

  useEffect(() => {
    if (playbackAllowed) return
    generationRef.current += 1
    playerRef.current?.pause()
    setStatus(value => value === "loading" ? "ready" : value)
  }, [playbackAllowed, playerRef, setStatus])

  const restorePosition = useCallback((player: HTMLVideoElement) => {
    if (positionRef.current > 0 && player.readyState >= 1) {
      player.currentTime = Number.isFinite(player.duration) ? Math.min(positionRef.current, player.duration) : positionRef.current
      positionRef.current = 0
    }
  }, [])

  const play = useCallback((player: HTMLVideoElement) => {
    const generation = ++generationRef.current
    if (!playbackVisible(player)) { setStatus("ready"); return }
    setStatus("loading")
    void player.play().then(() => {
      if (playerRef.current !== player) return
      if (!playbackVisible(player)) { player.pause(); return }
      if (generationRef.current === generation) setStatus("ready")
    }).catch((error: unknown) => {
      if (playerRef.current !== player || generationRef.current !== generation) return
      setStatus(typeof error === "object" && error !== null && "name" in error && error.name === "NotAllowedError" ? "blocked" : "error")
    })
  }, [playerRef, setStatus])

  const attach = useCallback((player: HTMLVideoElement) => {
    playerRef.current = player
    if (player.getAttribute("src") !== attachment.url) player.src = attachment.url
    player.muted = settingsRef.current.muted
    player.volume = settingsRef.current.volume
    player.playbackRate = settingsRef.current.rate
    restorePosition(player)
    if (playOnAttachRef.current) { playOnAttachRef.current = false; play(player) }
    return () => {
      generationRef.current += 1
      positionRef.current = player.currentTime
      settingsRef.current = playbackSnapshot(player)
      if (playerRef.current === player) playerRef.current = null
      releaseVideo(player)
    }
  }, [attachment.url, play, playerRef, restorePosition])

  return <AttachmentVideoPlayer defaultPlaybackRates={[0.5, 1, 1.25, 1.5, 2]}>
    <VideoControls name={attachment.name} expanded={expanded} expandRef={expandRef} playerRef={playerRef} onExpand={onExpand}
      download={download} forceVisible={status !== "ready"}>
      <Video key={attempt} ref={attach} src={attachment.url} fallback={null} controls={false} playsInline preload="metadata" tabIndex={0}
        aria-label={`Video ${attachment.name}`} data-testid={tid.mediaPlayer(attachment.name)}
        onLoadedMetadata={event => restorePosition(event.currentTarget)}
        onLoadedData={() => setStatus(value => value === "loading" ? "ready" : value)}
        onPause={() => { generationRef.current += 1; setStatus(value => value === "loading" ? "ready" : value) }}
        onPlay={event => {
          if (!playbackVisible(event.currentTarget)) { generationRef.current += 1; event.currentTarget.pause() }
          setStatus("ready")
        }}
        onError={event => { generationRef.current += 1; event.currentTarget.pause(); setStatus("error") }}
      />
      {status === "loading" && <span role="status" data-testid={tid.mediaStatus(attachment.name)}
        className="pointer-events-none absolute top-2 left-2 rounded-md bg-background/90 p-2 text-xs text-foreground">Loading video…</span>}
      {(status === "blocked" || status === "error") && <div role="alert" data-testid={tid.mediaStatus(attachment.name)}
        className="absolute inset-x-2 top-2 z-40 flex items-center justify-center gap-2 rounded-md bg-background/95 p-2 text-sm">
        <p className="min-w-0">{status === "blocked" ? "Playback was blocked. Try playing again." : "Couldn’t play this file. Retry or download the original."}</p>
        <Button variant="secondary" size="icon" className="size-11 shrink-0" aria-label={status === "blocked" ? "Try playing" : "Retry video"}
          data-testid={tid.mediaRetry(attachment.name)} onClick={() => {
          if (status === "blocked" && playerRef.current) play(playerRef.current)
          else { playOnAttachRef.current = true; setStatus("loading"); setAttempt(value => value + 1) }
        }}><RefreshCw /></Button>
      </div>}
    </VideoControls>
  </AttachmentVideoPlayer>
}

export function VideoAttachment({ attachment }: { attachment: FileAttachment }) {
  const [visible, setVisible] = useAtom(useCreateAtom(false))
  const [playback, setPlayback] = useAtom(useCreateAtom<{ mode: "preview" | "inline" | "expanded"; initial: PlaybackSnapshot }>({
    mode: "preview", initial: initialPlayback,
  }))
  const mode = playback.mode
  const [previewStatus, setPreviewStatus] = useAtom(useCreateAtom<"loading" | "ready" | "error">("loading"))
  const previewRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<HTMLVideoElement>(null)
  const expandRef = useRef<HTMLButtonElement>(null)
  const shrinkRef = useRef<HTMLButtonElement>(null)
  const transition = useCallback((next: "inline" | "expanded") => {
    const player = playerRef.current
    const initial = player ? playbackSnapshot(player) : playback.initial
    flushSync(() => setPlayback({ mode: next, initial }))
  }, [playback.initial, setPlayback])
  const open = mode === "expanded"
  const download = useFileDownload(attachment)

  useEffect(() => {
    const target = previewRef.current
    if (!target) return
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      setVisible(true)
      observer.disconnect()
    })
    observer.observe(target)
    return () => observer.disconnect()
  }, [setVisible])

  const previewUrl = videoPreviewUrl(attachment.url)
  const attachPreview = useCallback((video: HTMLVideoElement) => {
    if (video.getAttribute("src") !== previewUrl) video.src = previewUrl
    return () => releaseVideo(video)
  }, [previewUrl])

  return <>
    <div ref={previewRef} data-testid={tid.mediaBlock(attachment.name)} data-media-kind="video"
      data-preview-state={previewStatus}
      className="relative block max-w-full overflow-hidden rounded-lg border border-border bg-muted/30 [--attachment-image-max-height:200px] sm:[--attachment-image-max-height:240px]"
      style={attachmentImageFrameStyle(undefined, undefined)}>
      {mode === "inline" && <div className="absolute inset-0 flex"><VideoPlayback attachment={attachment} initial={playback.initial} playerRef={playerRef}
        expanded={false} expandRef={expandRef} onExpand={() => transition("expanded")} download={download} /></div>}
      {mode === "preview" && visible && <video key={attachment.url} ref={attachPreview} src={previewUrl}
        data-testid={tid.videoPreview(attachment.name)} aria-hidden tabIndex={-1}
        muted playsInline preload="auto" className="pointer-events-none size-full object-contain"
        onLoadedData={() => setPreviewStatus("ready")} onSeeked={() => setPreviewStatus("ready")}
        onPlay={event => event.currentTarget.pause()} onError={() => setPreviewStatus("error")} />}
      {mode === "preview" && <button type="button" data-testid={tid.mediaPlay(attachment.name)} aria-label={`Play ${attachment.name}`}
        onClick={() => flushSync(() => setPlayback({ mode: "inline", initial: { ...initialPlayback, playing: true } }))}
        className="absolute inset-0 flex size-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="flex size-11 items-center justify-center rounded-full bg-background/90 text-foreground"><Play className="size-5 fill-current" /></span>
        {previewStatus === "error" && <span className="rounded-md bg-background/90 px-2 py-1 text-xs text-foreground">Video preview unavailable</span>}
        <span className="sr-only">{attachment.name}</span>
      </button>}
    </div>
    <Dialog open={open} onOpenChange={value => { if (!value) transition("inline") }}>
      <DialogContent aria-label={`Video preview: ${attachment.name}`} data-testid={tid.videoDialog(attachment.name)}
        showCloseButton={false} initialFocus={shrinkRef} finalFocus={expandRef}
        className="top-4 right-4 left-4 flex h-[calc(100%-2rem)] w-auto max-w-none translate-x-0 translate-y-0 flex-col gap-2 border-none bg-transparent p-0 shadow-none ring-0 sm:max-w-none">
        {open && <VideoPlayback key={attachment.url} attachment={attachment} initial={playback.initial} playerRef={playerRef}
          expanded expandRef={shrinkRef} onExpand={() => transition("inline")} download={download} />}
      </DialogContent>
    </Dialog>
  </>
}
