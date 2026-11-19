"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { createPortal } from "react-dom"
import { Container, Controls, Menu, MuteButton, PlayButton, PlaybackRateRadioGroup, Time, TimeSlider, VolumePopover, VolumeSlider } from "@videojs/react"
import { Video, VideoPlayer, usePlayer } from "@videojs/react/video"
import { Check, ChevronLeft, ChevronRight, Download, Gauge, Maximize, Minimize, MoreHorizontal, Pause, Play, RotateCcw, Volume1, Volume2, VolumeX } from "@/components/icons/lucide";
import { Dialog, DialogContent } from "@/components/ui/dialog"
import type { FileAttachment } from "@/lib/community/models/message"
import { fileDownloadStatusText, useFileDownload } from "@/lib/file-download"
import { tid } from "@/lib/community/testids"
import { getCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { renderCommunityThumbnail } from "@/lib/community-image-thumbnail"
import { captureVideoPreviewOwner, readVideoPreview, saveVideoPreview, type VideoPreviewOwner } from "@/lib/community/video-preview-cache"
import { attachmentImageFrameStyle } from "./attachment-layout"
import "@videojs/react/video/neutral-skin.css"
import "./video-attachment.css"

function VideoControls({ attachment, download, expanded, onExpand }: {
  attachment: FileAttachment; download: ReturnType<typeof useFileDownload>; expanded: boolean; onExpand: () => void
}) {
  const requestControlsLock = usePlayer(state => state.requestControlsLock)
  const expandButton = useRef<HTMLButtonElement>(null)
  const focusFrame = useRef<number | null>(null)
  const releaseControls = useRef<(() => void) | null>(null)
  useLayoutEffect(() => expanded ? requestControlsLock() : undefined, [expanded, requestControlsLock])
  useLayoutEffect(() => () => {
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current)
    releaseControls.current?.()
  }, [])
  function toggleMask() {
    const previousFocus = document.activeElement
    releaseControls.current?.()
    releaseControls.current = requestControlsLock()
    onExpand()
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => {
      if (document.activeElement === previousFocus || document.activeElement === document.body) {
        expandButton.current?.focus({ preventScroll: true })
      }
      releaseControls.current?.()
      releaseControls.current = null
      focusFrame.current = null
    })
  }
  return <>
    <Controls.Root visibility={expanded ? "always" : "auto"}>
      {!expanded && <Controls.Backdrop className="video-controls-backdrop" />}
      <Controls.Content className="video-controls video-controls-content video-controls-wrap" role="toolbar" aria-label="Video controls">
        <Controls.Group className="video-controls-start">
          <PlayButton className="media-button media-play-button" data-testid={tid.mediaPlay(attachment.name)}>
            <Play className="media-button-icon media-play-button-play-icon" />
            <Pause className="media-button-icon media-play-button-pause-icon" />
            <RotateCcw className="media-button-icon media-play-button-restart-icon" />
          </PlayButton>
          <VolumePopover.Root side="right" openOnHover delay={200} closeDelay={100}>
            <VolumePopover.Trigger render={<MuteButton className="media-button media-mute-button" />}>
              <Volume2 className="media-button-icon media-mute-button-high-icon" />
              <Volume1 className="media-button-icon media-mute-button-low-icon" />
              <VolumeX className="media-button-icon media-mute-button-off-icon" />
            </VolumePopover.Trigger>
            <VolumePopover.Popup className="media-popup media-popup-surface media-volume-popover">
              <VolumeSlider.Root className="media-slider media-volume-slider" orientation="horizontal">
                <VolumeSlider.Track className="media-slider-track"><VolumeSlider.Fill className="media-slider-fill" /></VolumeSlider.Track>
                <VolumeSlider.Thumb className="media-slider-thumb" />
              </VolumeSlider.Root>
            </VolumePopover.Popup>
          </VolumePopover.Root>
          <Time.Group className="media-time-group video-controls-time">
            <Time.Value type="current" /><Time.Separator /><Time.Value type="duration" />
          </Time.Group>
        </Controls.Group>
        <Controls.Group className="video-time-slider-group">
          <TimeSlider.Root className="media-slider media-time-slider">
            <TimeSlider.Track className="media-slider-track">
              <TimeSlider.Buffer className="media-slider-buffer" /><TimeSlider.Fill className="media-slider-fill" />
            </TimeSlider.Track>
            <TimeSlider.Thumb className="media-slider-thumb" />
            <TimeSlider.Preview className="media-slider-preview" overflow="clamp">
              <div className="media-slider-preview-content media-time-slider-preview-content">
                <TimeSlider.Value className="media-time-slider-value" type="pointer" />
              </div>
            </TimeSlider.Preview>
          </TimeSlider.Root>
        </Controls.Group>
        <Controls.Group className="video-controls-end">
          <Menu.Root side="top" align="end">
            <Menu.Trigger className="media-button" aria-label="More"><MoreHorizontal className="media-button-icon" /></Menu.Trigger>
            <Menu.Popup className="media-popup media-menu-popup media-popup-surface media-menu-resizable-popup"
              onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
              <Menu.Content className="media-menu-content thin-scrollbar" aria-label="More">
                <Menu.Item className="media-menu-trigger-item" data-testid={tid.mediaDownload(attachment.name)} onSelect={() => {
                  if (download.state.status === "downloading") download.cancel()
                  else void download.start()
                }}>
                  <Download className="media-menu-trigger-item-icon" />
                  <span>{download.state.status === "downloading" ? "Cancel download" : download.state.status === "error" ? "Retry download" : "Download"}</span>
                </Menu.Item>
                <Menu.Root>
                  <PlaybackRateRadioGroup.Root>
                    <Menu.Trigger className="media-menu-trigger-item">
                      <Gauge className="media-menu-trigger-item-icon" /><span>Speed</span>
                      <span className="media-menu-hint"><PlaybackRateRadioGroup.Value className="media-menu-hint-label" /><ChevronRight className="media-menu-forward-chevron" /></span>
                    </Menu.Trigger>
                    <Menu.Content className="media-menu-content thin-scrollbar" aria-label="Playback speed">
                      <Menu.Item className="media-menu-back-item" aria-label="Back to More"><ChevronLeft className="media-menu-back-chevron" /><span>Speed</span></Menu.Item>
                      <Menu.Separator className="media-menu-separator" />
                      <PlaybackRateRadioGroup.Options className="media-menu-radio-group" aria-label="Playback speed" renderItem={(props, state) => <Menu.RadioItem {...props} className="media-menu-radio-item">
                        <span>{state.label}</span>
                        <Menu.ItemIndicator forceMount className="media-menu-item-indicator"><Check className="media-menu-radio-item-icon" /></Menu.ItemIndicator>
                      </Menu.RadioItem>} />
                    </Menu.Content>
                  </PlaybackRateRadioGroup.Root>
                </Menu.Root>
              </Menu.Content>
            </Menu.Popup>
          </Menu.Root>
          <button ref={expandButton} type="button" className="media-button" aria-label={expanded ? "Shrink video" : "Expand video"} onClick={toggleMask}>
            {expanded ? <Minimize className="media-button-icon" /> : <Maximize className="media-button-icon" />}
          </button>
        </Controls.Group>
      </Controls.Content>
    </Controls.Root>
  </>
}

function VideoAttachmentSession({ attachment, registry }: { attachment: FileAttachment; registry: CommunityDbRegistry | null }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [inlineSlot, setInlineSlot] = useState<HTMLDivElement | null>(null)
  const [maskSlot, setMaskSlot] = useState<HTMLDivElement | null>(null)
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [activated, setActivated] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  const [poster, setPoster] = useState<string | undefined>()
  const [previewSettled, setPreviewSettled] = useState(false)
  const download = useFileDownload(attachment)
  const activatedRef = useRef(false)
  const previewSeeked = useRef(false)
  const currentVideo = useRef<HTMLVideoElement | null>(null)
  const metadataSeen = useRef(false)
  const retryVersion = useRef(0)
  const capturedFrame = useRef(false)
  const frameController = useRef<AbortController | null>(null)
  const previewLease = useRef<{ active: boolean; current: () => boolean; ready: Promise<VideoPreviewOwner | null> } | null>(null)
  const bindVideo = useCallback((node: HTMLVideoElement | null) => { currentVideo.current = node; setVideo(node) }, [])

  useEffect(() => {
    const generation = registry?.runtime.lifecycle.get().generation
    const version = retryVersion.current
    let objectUrl: string | undefined
    const lease = {
      active: true,
      current: () => lease.active && (!registry || registry.runtime.lifecycle.get().active && registry.runtime.lifecycle.get().generation === generation),
      ready: Promise.resolve<VideoPreviewOwner | null>(null),
    }
    previewLease.current = lease
    setPoster(undefined)
    setPreviewSettled(false)
    lease.ready = (async () => {
      try {
        if (!registry?.accountId) return null
        await registry.ready
        if (!lease.current()) return null
        const owner = await captureVideoPreviewOwner(registry.accountId, attachment.url)
        const saved = owner ? await readVideoPreview(owner, attachment.url) : null
        if (!lease.current()) return null
        if (saved && retryVersion.current === version) {
          if (!metadataSeen.current) setDimensions({ width: saved.width, height: saved.height })
          if (saved.poster && !activatedRef.current) {
            try {
              objectUrl = URL.createObjectURL(saved.poster)
              setPoster(objectUrl)
              setReady(true)
            } catch {}
          }
        }
        return owner
      } finally { if (lease.current()) setPreviewSettled(true) }
    })().catch(() => null)
    return () => {
      lease.active = false
      frameController.current?.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      if (previewLease.current === lease) previewLease.current = null
    }
  }, [attachment.url, registry])

  async function rememberPreview(media: HTMLVideoElement, frame = false) {
    const lease = previewLease.current
    if (!lease || !lease.current() || currentVideo.current !== media || media.videoWidth <= 0 || media.videoHeight <= 0) return
    const width = media.videoWidth, height = media.videoHeight
    const owner = await lease.ready
    if (!owner || !lease.current() || currentVideo.current !== media) return
    let image: Blob | undefined
    if (frame) {
      if (activatedRef.current || capturedFrame.current || !previewSeeked.current) return
      capturedFrame.current = true
      const controller = new AbortController()
      frameController.current?.abort()
      frameController.current = controller
      try {
        image = await renderCommunityThumbnail(width, height, (w, h) => {
          if (!lease.current() || currentVideo.current !== media || activatedRef.current) return null
          const canvas = document.createElement("canvas")
          canvas.width = w; canvas.height = h
          const context = canvas.getContext("2d")
          if (!context) return null
          context.drawImage(media, 0, 0, w, h)
          return quality => new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality))
        }, controller.signal) ?? undefined
      } catch { return }
      if (controller.signal.aborted || activatedRef.current) return
    }
    if (lease.current() && currentVideo.current === media) await saveVideoPreview(owner, attachment.url, { width, height, poster: image })
  }

  useLayoutEffect(() => {
    const element = document.createElement("div")
    element.className = "alook-video-host"
    setHost(element)
    return () => { element.parentNode?.removeChild(element) }
  }, [])

  useLayoutEffect(() => {
    const target = expanded ? maskSlot : inlineSlot
    if (host && target && host.parentNode !== target) target.appendChild(host)
  }, [expanded, host, inlineSlot, maskSlot])

  useLayoutEffect(() => {
    if (!video) return
    if (!video.getAttribute("src")) video.setAttribute("src", attachment.url)
    return () => { video.pause(); video.removeAttribute("src"); video.load() }
  }, [attachment.url, video])

  function play() {
    if (!video) return
    activatedRef.current = true
    setActivated(true)
    setError(null)
    const playing = video
    void playing.play().catch((reason: unknown) => {
      if (currentVideo.current !== playing) return
      setError(reason instanceof DOMException && reason.name === "NotAllowedError" ? "Playback was blocked — try again" : "Couldn’t play this file")
    })
  }

  function retry() {
    frameController.current?.abort()
    capturedFrame.current = false
    retryVersion.current += 1
    activatedRef.current = false
    previewSeeked.current = false
    setActivated(false)
    setReady(false)
    setError(null)
    setAttempt(value => value + 1)
  }

  const downloadError = download.state.status === "error" && <div className="alook-video-download-error" role="alert">
    <span>{fileDownloadStatusText(download.state)}</span>
    <button type="button" onClick={() => { void download.start() }}>Retry download</button>
  </div>

  const player = <VideoPlayer>
    <Container className="media-skin media-container video-skin alook-video-player" data-theme="neutral" data-preset="video" data-active={activated || undefined} data-expanded={expanded || undefined}>
      <div className="alook-video-picture">
      <Video key={attempt} ref={bindVideo} src={attachment.url} poster={poster}
        preload={previewSettled && (!poster || attempt > 0) ? "metadata" : "none"} playsInline controls={false}
        data-testid={tid.mediaPlayer(attachment.name)} className="alook-video-element"
        onLoadedMetadata={event => {
          const media = event.currentTarget
          metadataSeen.current = true
          if (media.videoWidth > 0 && media.videoHeight > 0) setDimensions({ width: media.videoWidth, height: media.videoHeight })
          void rememberPreview(media)
          if (poster && attempt === 0) return
          if (activatedRef.current || previewSeeked.current) return
          previewSeeked.current = true
          media.currentTime = Number.isFinite(media.duration) && media.duration > 0 ? Math.min(0.1, media.duration / 2) : 0.1
        }}
        onSeeked={event => { setReady(true); void rememberPreview(event.currentTarget, true) }}
        onLoadedData={() => { if (activatedRef.current) setReady(true) }}
        onPlay={() => { activatedRef.current = true; setActivated(true); setError(null) }}
        onError={() => setError("Couldn’t play this file")}
      />
      {!activated && !error && <button type="button" className="alook-video-start" aria-label={`Play video ${attachment.name}`} onClick={play}><Play /></button>}
      {!ready && !error && <span className="sr-only" role="status">Loading media…</span>}
      {error && <div className="alook-video-error"><p role="alert">{error}</p><button type="button" onClick={error.startsWith("Playback was blocked") ? play : retry} data-testid={tid.mediaRetry(attachment.name)}>{error.startsWith("Playback was blocked") ? "Try playing" : "Retry"} {attachment.name}</button></div>}
      </div>
      {(activated || expanded) && <VideoControls attachment={attachment} download={download} expanded={expanded} onExpand={() => setExpanded(value => !value)} />}
      {expanded && downloadError}
    </Container>
  </VideoPlayer>

  return <>
    <article data-testid={tid.mediaBlock(attachment.name)} data-media-kind="video"
      className="alook-video-attachment block max-w-full overflow-hidden rounded-lg border border-border [--attachment-image-max-height:200px] transition-colors hover:border-primary/40 sm:[--attachment-image-max-height:240px]"
      style={attachmentImageFrameStyle(dimensions?.width, dimensions?.height)}>
      <div ref={setInlineSlot} className="alook-video-slot" />
    </article>
    {!expanded && downloadError}
    {host && createPortal(player, host)}
    <Dialog open={expanded} onOpenChange={(next, details) => {
      if (!next && details.reason === "escape-key" && (details.event.defaultPrevented
        || host?.querySelector('.media-menu-popup[data-open], .media-menu-popup[data-ending-style]'))) {
        details.cancel()
        details.allowPropagation()
        return
      }
      setExpanded(next)
    }}>
      <DialogContent className="alook-video-mask top-4 right-4 left-4 flex h-[calc(100%-2rem)] w-auto max-w-none translate-x-0 translate-y-0 flex-col gap-2 overflow-visible border-none bg-transparent p-0 shadow-none ring-0 sm:max-w-none" aria-label={attachment.name} showCloseButton={false}
        initialFocus={() => host?.querySelector<HTMLButtonElement>('[aria-label="Shrink video"]') ?? false}
        finalFocus={() => {
          const focused = document.activeElement
          const mask = maskSlot?.closest('[role="dialog"]')
          if (focused && focused !== document.body && focused !== document.documentElement && !mask?.contains(focused)) return false
          return host?.querySelector<HTMLButtonElement>('[aria-label="Expand video"]') ?? false
        }}>
        <div ref={setMaskSlot} className="alook-video-slot" data-base-ui-swipe-ignore="" />
      </DialogContent>
    </Dialog>
  </>
}

export function VideoAttachmentBlock({ attachment }: { attachment: FileAttachment }) {
  const registry = getCommunityDbRegistry(useQueryClient())
  return <VideoAttachmentSession key={`${registry?.accountId ?? ""}\u0000${attachment.url}\u0000${attachment.name}`} attachment={attachment} registry={registry} />
}
