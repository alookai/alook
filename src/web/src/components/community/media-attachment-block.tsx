"use client"

import { useRef, useState, type MouseEvent } from "react"
import { flushSync } from "react-dom"
import { Download, FileAudio, FileVideo, LoaderCircle, Pause, Play, RefreshCw, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { tid } from "@/lib/community/testids"
import type { FileAttachment } from "./_types"

type MediaKind = "audio" | "video"
type MediaStatus = "idle" | "loading" | "ready" | "blocked" | "error"

export function MediaAttachmentBlock({
  attachment,
  mediaKind,
  onDownload,
}: {
  attachment: FileAttachment
  mediaKind: MediaKind
  onDownload?: (url: string, name: string) => void
}) {
  const [mounted, setMounted] = useState(false)
  const [status, setStatus] = useState<MediaStatus>("idle")
  const [isPlaying, setIsPlaying] = useState(false)
  const [playerKey, setPlayerKey] = useState(0)
  const playerRef = useRef<HTMLMediaElement>(null)
  const playOnMountRef = useRef(false)
  const playbackAttemptRef = useRef(0)
  const playbackActiveRef = useRef(false)
  const MediaIcon = mediaKind === "video" ? FileVideo : FileAudio

  function playPlayer(player: HTMLMediaElement): void {
    const attempt = playbackAttemptRef.current + 1
    playbackAttemptRef.current = attempt
    playbackActiveRef.current = true
    setIsPlaying(true)
    setStatus((value) => value === "ready" ? value : "loading")
    void player.play().then(() => {
      if (playerRef.current === player && playbackAttemptRef.current === attempt) setStatus("ready")
    }).catch((error: unknown) => {
      if (playerRef.current !== player || playbackAttemptRef.current !== attempt) return
      playbackActiveRef.current = false
      setIsPlaying(false)
      setStatus(
        typeof error === "object" && error !== null && "name" in error && error.name === "NotAllowedError"
          ? "blocked"
          : "error",
      )
    })
  }

  function togglePlayback(): void {
    const player = playerRef.current
    if (!player) {
      playOnMountRef.current = true
      flushSync(() => {
        setStatus("loading")
        setMounted(true)
      })
      return
    }
    if (isPlaying) {
      player.pause()
      setIsPlaying(false)
      return
    }
    playPlayer(player)
  }

  function stopPlayer(): void {
    playOnMountRef.current = false
    playbackAttemptRef.current += 1
    playbackActiveRef.current = false
    const player = playerRef.current
    if (player) {
      player.pause()
      if (player.readyState > 0) player.currentTime = 0
    }
    setStatus("idle")
    setIsPlaying(false)
  }

  function finishPlayer(): void {
    playbackAttemptRef.current += 1
    playbackActiveRef.current = false
    const player = playerRef.current
    if (player && player.readyState > 0) player.currentTime = 0
    setStatus("idle")
    setIsPlaying(false)
  }

  function retryPlayer(): void {
    playOnMountRef.current = true
    flushSync(() => {
      setPlayerKey((value) => value + 1)
      setStatus("loading")
      setMounted(true)
    })
  }

  function download(event: MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation()
    onDownload?.(attachment.url, attachment.name)
  }

  const playerProps = {
    "data-testid": tid.mediaPlayer(attachment.name),
    src: attachment.url,
    controls: false,
    preload: "metadata" as const,
    autoPlay: false,
    ref: (player: HTMLMediaElement | null) => {
      playerRef.current = player
      if (!player || !playOnMountRef.current) return
      playOnMountRef.current = false
      playPlayer(player)
    },
    onPlay: () => setIsPlaying(true),
    onPause: () => setIsPlaying(false),
    onEnded: finishPlayer,
    onError: () => {
      if (!playbackActiveRef.current) return
      playbackActiveRef.current = false
      setIsPlaying(false)
      setStatus("error")
    },
  }

  const playbackLabel = `${isPlaying ? "Pause" : status === "blocked" ? "Try playing" : "Play"} ${attachment.name}`

  return (
    <article
      data-testid={tid.mediaBlock(attachment.name)}
      data-media-kind={mediaKind}
      className="w-full max-w-100 overflow-hidden rounded-lg border border-border bg-card text-card-foreground"
    >
      {mediaKind === "video" && (
        <div className="relative aspect-video bg-muted/40">
          {mounted && status !== "error" ? (
            <video key={playerKey} {...playerProps} playsInline className="size-full object-contain" />
          ) : (
            <button
              data-testid={status === "error" ? tid.mediaRetry(attachment.name) : tid.mediaPlay(attachment.name)}
              type="button"
              onClick={status === "error" ? retryPlayer : togglePlayback}
              className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
              aria-label={`${status === "error" ? "Retry" : "Play"} ${attachment.name}`}
            >
              {status === "error" ? <RefreshCw className="size-7" /> : <Play className="size-8" />}
              <span className="text-xs font-medium">{status === "error" ? "Retry playback" : "Play video"}</span>
            </button>
          )}
          {mounted && status !== "error" && (
            <div className="absolute bottom-2 left-2 flex gap-2">
              <Button
                data-testid={tid.mediaPlay(attachment.name)}
                type="button"
                variant="secondary"
                size="icon-sm"
                className="size-11 sm:size-8"
                onClick={togglePlayback}
                aria-label={playbackLabel}
              >
                {isPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
              </Button>
              {status !== "idle" && (
                <Button
                  data-testid={tid.mediaCollapse(attachment.name)}
                  type="button"
                  variant="secondary"
                  size="icon-sm"
                  className="size-11 sm:size-8"
                  onClick={stopPlayer}
                  aria-label={`Stop playback ${attachment.name}`}
                >
                  <Square className="size-4" />
                </Button>
              )}
            </div>
          )}
          {mounted && status === "loading" && (
            <span
              data-testid={tid.mediaStatus(attachment.name)}
              role="status"
              className="absolute top-2 left-2 rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground"
            >
              Loading media…
            </span>
          )}
        </div>
      )}

      <div className="flex min-h-14 items-center gap-3 px-3 py-2">
        <MediaIcon className="size-6 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{attachment.name}</div>
          <div className="text-xs text-muted-foreground">
            {[mediaKind === "video" ? "Video" : "Audio", attachment.size].filter(Boolean).join(" · ")}
          </div>
          {status === "error" && (
            <p data-testid={tid.mediaStatus(attachment.name)} role="alert" className="text-xs text-muted-foreground">
              Couldn’t play this file
            </p>
          )}
          {status === "blocked" && (
            <p data-testid={tid.mediaStatus(attachment.name)} role="alert" className="text-xs text-muted-foreground">
              Playback was blocked — try again
            </p>
          )}
        </div>
        {mediaKind === "audio" && status !== "error" && (
          <Button
            data-testid={tid.mediaPlay(attachment.name)}
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-11 text-muted-foreground hover:text-foreground focus-visible:text-foreground sm:size-8"
            onClick={togglePlayback}
            aria-label={status === "loading" ? `Loading ${attachment.name}` : playbackLabel}
            aria-busy={status === "loading"}
            disabled={status === "loading"}
          >
            {status === "loading" ? (
              <>
                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                <span data-testid={tid.mediaStatus(attachment.name)} role="status" className="sr-only">
                  Loading media…
                </span>
              </>
            ) : isPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
          </Button>
        )}
        {mediaKind === "audio" && status === "error" && (
          <Button
            data-testid={tid.mediaRetry(attachment.name)}
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-11 text-muted-foreground hover:text-foreground focus-visible:text-foreground sm:size-8"
            onClick={retryPlayer}
            aria-label={`Retry ${attachment.name}`}
          >
            <RefreshCw className="size-4" />
          </Button>
        )}
        {mediaKind === "audio" && status === "idle" && (
          <span
            data-media-stop-slot
            aria-hidden="true"
            className="size-11 shrink-0 sm:size-8"
          />
        )}
        {mediaKind === "audio" && mounted && status !== "idle" && status !== "error" && (
          <Button
            data-testid={tid.mediaCollapse(attachment.name)}
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-11 text-muted-foreground hover:text-foreground focus-visible:text-foreground sm:size-8"
            onClick={stopPlayer}
            aria-label={`Stop playback ${attachment.name}`}
          >
            <Square className="size-4" />
          </Button>
        )}
        <Button
          data-testid={tid.mediaDownload(attachment.name)}
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-11 text-muted-foreground hover:text-foreground focus-visible:text-foreground sm:size-8"
          onClick={download}
          aria-label={`Download ${attachment.name}`}
        >
          <Download className="size-4" />
        </Button>
      </div>

      {mediaKind === "audio" && mounted && status !== "error" && (
        <audio key={playerKey} {...playerProps} className="hidden" />
      )}
    </article>
  )
}
