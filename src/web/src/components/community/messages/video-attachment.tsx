"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from "react"
import { flushSync } from "react-dom"
import { CircleCheck, Download, LoaderCircle, Maximize2, Play, RefreshCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { fileDownloadStatusText, useFileDownload } from "@/lib/file-download"
import type { FileAttachment } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import { attachmentImageFrameStyle } from "./attachment-layout"

type PlaybackStatus = "loading" | "ready" | "blocked" | "error"
type PlaybackSnapshot = { time: number; playing: boolean }

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

function VideoPlayback({ attachment, initial, playerRef, inline = false }: {
  attachment: FileAttachment
  initial: PlaybackSnapshot
  playerRef: RefObject<HTMLVideoElement | null>
  inline?: boolean
}) {
  const [status, setStatus] = useAtom(useCreateAtom<PlaybackStatus>("loading"))
  const [attempt, setAttempt] = useAtom(useCreateAtom(0))
  const generationRef = useRef(0)
  const playOnAttachRef = useRef(initial.playing)
  const positionRef = useRef(initial.time)
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
    restorePosition(player)
    if (playOnAttachRef.current) { playOnAttachRef.current = false; play(player) }
    return () => {
      generationRef.current += 1
      positionRef.current = player.currentTime
      if (playerRef.current === player) playerRef.current = null
      releaseVideo(player)
    }
  }, [attachment.url, play, playerRef, restorePosition])

  return <div className="relative flex min-h-0 flex-1 items-center justify-center">
    <video key={attempt} ref={attach} src={attachment.url} controls controlsList={inline ? "nofullscreen" : undefined} playsInline preload="metadata"
      data-testid={tid.mediaPlayer(attachment.name)}
      className="size-full min-h-0 object-contain"
      onLoadedMetadata={event => restorePosition(event.currentTarget)}
      onLoadedData={() => setStatus(value => value === "loading" ? "ready" : value)}
      onPlay={event => {
        if (!playbackVisible(event.currentTarget)) { generationRef.current += 1; event.currentTarget.pause() }
        setStatus("ready")
      }}
      onError={event => { generationRef.current += 1; event.currentTarget.pause(); setStatus("error") }}
    />
    {status === "loading" && <span role="status" data-testid={tid.mediaStatus(attachment.name)}
      className="pointer-events-none absolute top-2 left-2 rounded-md bg-background/90 p-2 text-xs text-foreground">Loading video…</span>}
    {(status === "blocked" || status === "error") && <div role="alert" data-testid={tid.mediaStatus(attachment.name)}
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-lg bg-background/95 p-4 text-center text-sm">
      <p>{status === "blocked" ? "Playback was blocked. Try playing again." : "Couldn’t play this file. Retry or download the original."}</p>
      <Button variant="secondary" className="min-h-11 min-w-11" data-testid={tid.mediaRetry(attachment.name)} onClick={() => {
        if (status === "blocked" && playerRef.current) play(playerRef.current)
        else { playOnAttachRef.current = true; setStatus("loading"); setAttempt(value => value + 1) }
      }}><RefreshCw />{status === "blocked" ? "Try playing" : "Retry video"}</Button>
    </div>}
  </div>
}

export function VideoAttachment({ attachment }: { attachment: FileAttachment }) {
  const [visible, setVisible] = useAtom(useCreateAtom(false))
  const [playback, setPlayback] = useAtom(useCreateAtom<{ mode: "preview" | "inline" | "fullscreen"; initial: PlaybackSnapshot }>({
    mode: "preview", initial: { time: 0, playing: false },
  }))
  const mode = playback.mode
  const [previewStatus, setPreviewStatus] = useAtom(useCreateAtom<"loading" | "ready" | "error">("loading"))
  const previewRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<HTMLVideoElement>(null)
  const transition = useCallback((next: "inline" | "fullscreen") => {
    const player = playerRef.current
    const initial = player ? { time: player.currentTime, playing: !player.paused && !player.ended } : playback.initial
    flushSync(() => setPlayback({ mode: next, initial }))
  }, [playback.initial, setPlayback])
  const open = mode === "fullscreen"
  const download = useFileDownload(attachment)
  const downloadText = fileDownloadStatusText(download.state)
  const DownloadIcon = download.state.status === "downloading" ? LoaderCircle
    : download.state.status === "saved" || download.state.status === "started" ? CircleCheck
    : download.state.status === "error" ? RefreshCw : Download

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
      {mode === "inline" && <div className="absolute inset-0 flex"><VideoPlayback attachment={attachment} initial={playback.initial} playerRef={playerRef} inline /></div>}
      {mode === "preview" && visible && <video key={attachment.url} ref={attachPreview} src={previewUrl}
        data-testid={tid.videoPreview(attachment.name)} aria-hidden tabIndex={-1}
        muted playsInline preload="auto" className="pointer-events-none size-full object-contain"
        onLoadedData={() => setPreviewStatus("ready")} onSeeked={() => setPreviewStatus("ready")}
        onPlay={event => event.currentTarget.pause()} onError={() => setPreviewStatus("error")} />}
      {mode === "preview" && <button type="button" data-testid={tid.mediaPlay(attachment.name)} aria-label={`Play ${attachment.name}`}
        onClick={() => flushSync(() => setPlayback({ mode: "inline", initial: { time: 0, playing: true } }))}
        className="absolute inset-0 flex size-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="flex size-11 items-center justify-center rounded-full bg-background/90 text-foreground"><Play className="size-5 fill-current" /></span>
        {previewStatus === "error" && <span className="rounded-md bg-background/90 px-2 py-1 text-xs text-foreground">Video preview unavailable</span>}
        <span className="sr-only">{attachment.name}</span>
      </button>}
      <div hidden={open} className="absolute top-1 right-1 z-10 flex gap-1 rounded-lg bg-background/90">
        <Button variant="ghost" size="icon" className="size-11" data-testid={tid.mediaDownload(attachment.name)}
          aria-label={`${download.state.status === "downloading" ? "Cancel download" : download.state.status === "error" ? "Retry download" : "Download"} ${attachment.name}`}
          aria-busy={download.state.status === "downloading"}
          onClick={() => download.state.status === "downloading" ? download.cancel() : void download.start()}>
          <DownloadIcon className={download.state.status === "downloading" ? "animate-spin motion-reduce:animate-none" : undefined} />
        </Button>
        <Button variant="ghost" size="icon" className="size-11" data-testid={tid.videoFullscreen(attachment.name)}
          aria-label={`Fullscreen ${attachment.name}`} onClick={() => transition("fullscreen")}><Maximize2 /></Button>
      </div>
      {!open && downloadText && <p role={download.state.status === "error" ? "alert" : "status"}
        className="pointer-events-none absolute top-14 right-1 left-1 rounded-md bg-background/90 p-2 text-xs text-foreground">{downloadText}</p>}
    </div>
    <Dialog open={open} onOpenChange={value => { if (!value) transition("inline") }}>
      <DialogContent aria-label={`Video preview: ${attachment.name}`} data-testid={tid.videoDialog(attachment.name)}
        showCloseButton={false}
        className="top-4 right-4 left-4 flex h-[calc(100%-2rem)] w-auto max-w-none translate-x-0 translate-y-0 flex-col gap-2 border-none bg-transparent p-0 shadow-none ring-0 sm:max-w-none">
        <div role="toolbar" aria-label="Video controls" className="flex max-w-full shrink-0 items-center gap-2 self-center rounded-lg border border-border bg-background p-1">
          <span className="min-w-0 max-w-48 truncate px-2 text-sm">{attachment.name}</span>
          <Button variant="ghost" size="icon" className="size-11 sm:size-9" data-testid={tid.mediaDownload(attachment.name)}
            aria-label={`${download.state.status === "downloading" ? "Cancel download" : download.state.status === "error" ? "Retry download" : "Download"} ${attachment.name}`}
            aria-busy={download.state.status === "downloading"}
            onClick={() => download.state.status === "downloading" ? download.cancel() : void download.start()}>
            <DownloadIcon className={download.state.status === "downloading" ? "animate-spin motion-reduce:animate-none" : undefined} />
          </Button>
          <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label="Close video preview" onClick={() => transition("inline")}><X /></Button>
        </div>
        {downloadText && <p role={download.state.status === "error" ? "alert" : "status"} className="self-center rounded-md bg-background p-2 text-xs text-foreground">{downloadText}</p>}
        {open && <VideoPlayback key={attachment.url} attachment={attachment} initial={playback.initial} playerRef={playerRef} />}
      </DialogContent>
    </Dialog>
  </>
}
