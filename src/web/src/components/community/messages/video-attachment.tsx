"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useCallback, useEffect, useRef } from "react"
import { flushSync } from "react-dom"
import { CircleCheck, Download, LoaderCircle, Play, RefreshCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { fileDownloadStatusText, useFileDownload } from "@/lib/file-download"
import type { FileAttachment } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import { attachmentImageFrameStyle } from "./attachment-layout"

type PlaybackStatus = "loading" | "ready" | "blocked" | "error"

export function prepareVideoPreviewFrame(video: HTMLVideoElement): void {
  if (video.autoplay || !video.paused || video.seeking || video.currentTime !== 0 || video.played.length > 0
    || !Number.isFinite(video.duration) || video.duration <= 0) return
  const fragment = video.src.split("#", 2)[1]
  if (fragment && new URLSearchParams(fragment).has("t")) return
  try { video.currentTime = Math.min(0.1, video.duration / 2) } catch { return }
}

function releaseVideo(video: HTMLVideoElement): void {
  video.pause()
  video.removeAttribute("src")
  video.load()
}

function VideoPlayback({ attachment }: { attachment: FileAttachment }) {
  const [status, setStatus] = useAtom(useCreateAtom<PlaybackStatus>("loading"))
  const [attempt, setAttempt] = useAtom(useCreateAtom(0))
  const playerRef = useRef<HTMLVideoElement>(null)
  const generationRef = useRef(0)
  const playOnAttachRef = useRef(true)

  const play = useCallback((player: HTMLVideoElement) => {
    const generation = ++generationRef.current
    setStatus("loading")
    void player.play().then(() => {
      if (playerRef.current === player && generationRef.current === generation) setStatus("ready")
    }).catch((error: unknown) => {
      if (playerRef.current !== player || generationRef.current !== generation) return
      setStatus(typeof error === "object" && error !== null && "name" in error && error.name === "NotAllowedError" ? "blocked" : "error")
    })
  }, [setStatus])

  const attach = useCallback((player: HTMLVideoElement) => {
    playerRef.current = player
    if (player.getAttribute("src") !== attachment.url) player.src = attachment.url
    const pauseWhenHidden = () => {
      const fullscreen = document.fullscreenElement?.contains(player)
        || ("webkitDisplayingFullscreen" in player && player.webkitDisplayingFullscreen === true)
      if (!document.hidden || fullscreen) return
      generationRef.current += 1
      player.pause()
      setStatus(value => value === "loading" ? "ready" : value)
    }
    document.addEventListener("visibilitychange", pauseWhenHidden)
    document.addEventListener("fullscreenchange", pauseWhenHidden)
    player.addEventListener("webkitendfullscreen", pauseWhenHidden)
    if (playOnAttachRef.current) { playOnAttachRef.current = false; play(player) }
    return () => {
      generationRef.current += 1
      playerRef.current = null
      document.removeEventListener("visibilitychange", pauseWhenHidden)
      document.removeEventListener("fullscreenchange", pauseWhenHidden)
      player.removeEventListener("webkitendfullscreen", pauseWhenHidden)
      releaseVideo(player)
    }
  }, [attachment.url, play, setStatus])

  return <div className="relative flex min-h-0 flex-1 items-center justify-center">
    <video key={attempt} ref={attach} src={attachment.url} controls playsInline preload="metadata"
      data-testid={tid.mediaPlayer(attachment.name)}
      className="size-full min-h-0 object-contain"
      onPlay={() => setStatus("ready")}
      onError={event => { generationRef.current += 1; event.currentTarget.pause(); setStatus("error") }}
    />
    {status === "loading" && <span role="status" data-testid={tid.mediaStatus(attachment.name)}
      className="pointer-events-none absolute top-2 left-2 rounded-md bg-background/90 p-2 text-xs text-foreground">Loading video…</span>}
    {(status === "blocked" || status === "error") && <div role="alert" data-testid={tid.mediaStatus(attachment.name)}
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-lg bg-background/95 p-4 text-center text-sm">
      <p>{status === "blocked" ? "Playback was blocked. Try playing again." : "Couldn’t play this file. Retry or download the original."}</p>
      <Button variant="secondary" data-testid={tid.mediaRetry(attachment.name)} onClick={() => {
        if (status === "blocked" && playerRef.current) play(playerRef.current)
        else { playOnAttachRef.current = true; setStatus("loading"); setAttempt(value => value + 1) }
      }}><RefreshCw />{status === "blocked" ? "Try playing" : "Retry video"}</Button>
    </div>}
  </div>
}

export function VideoAttachment({ attachment }: { attachment: FileAttachment }) {
  const [visible, setVisible] = useAtom(useCreateAtom(false))
  const [open, setOpen] = useAtom(useCreateAtom(false))
  const [previewStatus, setPreviewStatus] = useAtom(useCreateAtom<"loading" | "ready" | "error">("loading"))
  const previewRef = useRef<HTMLDivElement>(null)
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

  const attachPreview = useCallback((video: HTMLVideoElement) => {
    if (video.getAttribute("src") !== attachment.url) video.src = attachment.url
    return () => releaseVideo(video)
  }, [attachment.url])

  return <>
    <div ref={previewRef} data-testid={tid.mediaBlock(attachment.name)} data-media-kind="video"
      data-preview-state={previewStatus}
      className="relative block max-w-full overflow-hidden rounded-lg border border-border bg-muted/30 [--attachment-image-max-height:200px] sm:[--attachment-image-max-height:240px]"
      style={attachmentImageFrameStyle(undefined, undefined)}>
      {visible && <video key={attachment.url} ref={attachPreview} src={attachment.url}
        data-testid={tid.videoPreview(attachment.name)} aria-hidden tabIndex={-1}
        muted playsInline preload="metadata" className="pointer-events-none size-full object-contain"
        onLoadedMetadata={event => prepareVideoPreviewFrame(event.currentTarget)}
        onLoadedData={() => setPreviewStatus("ready")} onSeeked={() => setPreviewStatus("ready")}
        onPlay={event => event.currentTarget.pause()} onError={() => setPreviewStatus("error")} />}
      <button type="button" data-testid={tid.mediaPlay(attachment.name)} aria-label={`Play ${attachment.name}`}
        onClick={() => flushSync(() => setOpen(true))}
        className="absolute inset-0 flex size-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="flex size-11 items-center justify-center rounded-full bg-background/90 text-foreground"><Play className="size-5 fill-current" /></span>
        {previewStatus === "error" && <span className="rounded-md bg-background/90 px-2 py-1 text-xs text-foreground">Video preview unavailable</span>}
        <span className="sr-only">{attachment.name}</span>
      </button>
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
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
          <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label="Close video preview" onClick={() => setOpen(false)}><X /></Button>
        </div>
        {downloadText && <p role={download.state.status === "error" ? "alert" : "status"} className="self-center rounded-md bg-background p-2 text-xs text-foreground">{downloadText}</p>}
        {open && <VideoPlayback key={attachment.url} attachment={attachment} />}
      </DialogContent>
    </Dialog>
  </>
}
