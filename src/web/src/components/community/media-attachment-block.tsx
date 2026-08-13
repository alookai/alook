"use client"

import { useState, type MouseEvent } from "react"
import { Download, FileAudio, FileVideo, Pause, Play, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { tid } from "@/lib/community/testids"
import type { FileAttachment } from "./_types"

type MediaKind = "audio" | "video"

export function MediaAttachmentBlock({
  attachment,
  mediaKind,
  onDownload,
}: {
  attachment: FileAttachment
  mediaKind: MediaKind
  onDownload?: (url: string, name: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle")
  const [playerKey, setPlayerKey] = useState(0)
  const MediaIcon = mediaKind === "video" ? FileVideo : FileAudio

  function openPlayer(): void {
    setStatus("loading")
    setExpanded(true)
  }

  function closePlayer(): void {
    setExpanded(false)
    setStatus("idle")
  }

  function retryPlayer(): void {
    setPlayerKey((value) => value + 1)
    setStatus("loading")
    setExpanded(true)
  }

  function download(event: MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation()
    onDownload?.(attachment.url, attachment.name)
  }

  const playerProps = {
    "data-testid": tid.mediaPlayer(attachment.name),
    src: attachment.url,
    controls: true,
    preload: "metadata" as const,
    autoPlay: false,
    onLoadedMetadata: () => setStatus("ready"),
    onError: () => setStatus("error"),
  }

  return (
    <article
      data-testid={tid.mediaBlock(attachment.name)}
      data-media-kind={mediaKind}
      className="w-full max-w-100 overflow-hidden rounded-lg border border-border bg-card"
    >
      {mediaKind === "video" && (
        <div className="relative aspect-video bg-muted/40">
          {expanded && status !== "error" ? (
            <video key={playerKey} {...playerProps} playsInline className="size-full object-contain" />
          ) : (
            <button
              data-testid={status === "error" ? tid.mediaRetry(attachment.name) : tid.mediaPlay(attachment.name)}
              type="button"
              onClick={status === "error" ? retryPlayer : openPlayer}
              className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
              aria-label={`${status === "error" ? "Retry" : "Play"} ${attachment.name}`}
            >
              {status === "error" ? <RefreshCw className="size-7" /> : <Play className="size-8" />}
              <span className="text-xs font-medium">{status === "error" ? "Retry playback" : "Play video"}</span>
            </button>
          )}
          {expanded && status !== "error" && (
            <Button
              data-testid={tid.mediaCollapse(attachment.name)}
              type="button"
              variant="secondary"
              size="icon-sm"
              className="absolute top-2 right-2 size-11 sm:size-8"
              onClick={closePlayer}
              aria-label={`Collapse ${attachment.name}`}
            >
              <Pause className="size-4" />
            </Button>
          )}
          {expanded && status === "loading" && (
            <span
              data-testid={tid.mediaStatus(attachment.name)}
              role="status"
              className="absolute bottom-2 left-2 rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground"
            >
              Loading media…
            </span>
          )}
        </div>
      )}

      <div className="flex min-h-14 items-center gap-3 px-3 py-2">
        <MediaIcon className="size-6 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-primary">{attachment.name}</div>
          <div className="text-xs text-muted-foreground">
            {[mediaKind === "video" ? "Video" : "Audio", attachment.size].filter(Boolean).join(" · ")}
          </div>
          {status === "error" && (
            <p data-testid={tid.mediaStatus(attachment.name)} role="alert" className="text-xs text-muted-foreground">
              Couldn’t play this file
            </p>
          )}
        </div>
        {mediaKind === "audio" && (!expanded || status === "error") && (
          <Button
            data-testid={status === "error" ? tid.mediaRetry(attachment.name) : tid.mediaPlay(attachment.name)}
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-11 sm:size-8"
            onClick={status === "error" ? retryPlayer : openPlayer}
            aria-label={`${status === "error" ? "Retry" : "Play"} ${attachment.name}`}
          >
            {status === "error" ? <RefreshCw className="size-4" /> : <Play className="size-4" />}
          </Button>
        )}
        {mediaKind === "audio" && expanded && status !== "error" && (
          <Button
            data-testid={tid.mediaCollapse(attachment.name)}
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-11 sm:size-8"
            onClick={closePlayer}
            aria-label={`Collapse ${attachment.name}`}
          >
            <Pause className="size-4" />
          </Button>
        )}
        <Button
          data-testid={tid.mediaDownload(attachment.name)}
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-11 sm:size-8"
          onClick={download}
          aria-label={`Download ${attachment.name}`}
        >
          <Download className="size-4" />
        </Button>
      </div>

      {mediaKind === "audio" && expanded && status !== "error" && (
        <div className="relative border-t border-border px-3 py-2">
          <audio key={playerKey} {...playerProps} className="h-11 w-full" />
          {status === "loading" && (
            <span data-testid={tid.mediaStatus(attachment.name)} role="status" className="mt-1 block text-xs text-muted-foreground">
              Loading media…
            </span>
          )}
        </div>
      )}
    </article>
  )
}
