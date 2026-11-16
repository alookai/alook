"use client"

import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Container, Controls, Menu, MuteButton, PlayButton, PlaybackRateRadioGroup, Time, TimeSlider, VolumePopover, VolumeSlider } from "@videojs/react"
import { Video, VideoPlayer, usePlayer } from "@videojs/react/video"
import { Check, Download, Maximize, Minimize, MoreHorizontal, Pause, Play, RotateCcw, Volume1, Volume2, VolumeX } from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import type { FileAttachment } from "@/lib/community/models/message"
import { fileDownloadStatusText, useFileDownload } from "@/lib/file-download"
import { tid } from "@/lib/community/testids"
import "@videojs/react/video/neutral-skin.css"
import "./video-attachment.css"

function VideoControls({ attachment, expanded, onExpand }: {
  attachment: FileAttachment; expanded: boolean; onExpand: () => void
}) {
  const download = useFileDownload(attachment)
  const downloadText = fileDownloadStatusText(download.state)
  const requestControlsLock = usePlayer(state => state.requestControlsLock)
  const expandButton = useRef<HTMLButtonElement>(null)
  const focusFrame = useRef<number | null>(null)
  const releaseControls = useRef<(() => void) | null>(null)
  useLayoutEffect(() => () => {
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current)
    releaseControls.current?.()
  }, [])
  function toggleMask() {
    releaseControls.current?.()
    releaseControls.current = requestControlsLock()
    onExpand()
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => {
      expandButton.current?.focus({ preventScroll: true })
      releaseControls.current?.()
      releaseControls.current = null
      focusFrame.current = null
    })
  }
  return <>
    <Controls.Root>
      <Controls.Backdrop className="video-controls-backdrop" />
      <Controls.Content className="video-controls video-controls-content video-controls-wrap">
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
              <TimeSlider.Value className="media-time-slider-value" type="pointer" />
            </TimeSlider.Preview>
          </TimeSlider.Root>
        </Controls.Group>
        <Controls.Group className="video-controls-end">
          <Menu.Root side="top" align="end">
            <Menu.Trigger className="media-button" aria-label="More"><MoreHorizontal className="media-button-icon" /></Menu.Trigger>
            <Menu.Popup className="media-popup media-menu-popup media-popup-surface">
              <Menu.Content className="media-menu-content thin-scrollbar">
                <PlaybackRateRadioGroup.Root>
                  <PlaybackRateRadioGroup.Options className="media-menu-radio-group" aria-label="Playback speed" renderItem={(props, state) => <Menu.RadioItem {...props} className="media-menu-radio-item">
                    <span>{state.label}</span>
                    <Menu.ItemIndicator forceMount className="media-menu-item-indicator"><Check className="media-menu-radio-item-icon" /></Menu.ItemIndicator>
                  </Menu.RadioItem>} />
                </PlaybackRateRadioGroup.Root>
                <Menu.Item className="media-menu-trigger-item" data-testid={tid.mediaDownload(attachment.name)} onSelect={() => {
                  if (download.state.status === "downloading") download.cancel()
                  else void download.start()
                }}>
                  <Download className="media-menu-trigger-item-icon" />
                  <span>{download.state.status === "downloading" ? "Cancel download" : download.state.status === "error" ? "Retry download" : "Download"}</span>
                </Menu.Item>
              </Menu.Content>
            </Menu.Popup>
          </Menu.Root>
          <button ref={expandButton} type="button" className="media-button" aria-label={expanded ? "Shrink video" : "Expand video"} onClick={toggleMask}>
            {expanded ? <Minimize className="media-button-icon" /> : <Maximize className="media-button-icon" />}
          </button>
        </Controls.Group>
      </Controls.Content>
    </Controls.Root>
    {downloadText && <p className="alook-video-notice" role={download.state.status === "error" ? "alert" : "status"}>{downloadText}</p>}
  </>
}

function VideoAttachmentSession({ attachment }: { attachment: FileAttachment }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [inlineSlot, setInlineSlot] = useState<HTMLDivElement | null>(null)
  const [maskSlot, setMaskSlot] = useState<HTMLDivElement | null>(null)
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [activated, setActivated] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const activatedRef = useRef(false)
  const previewSeeked = useRef(false)
  const currentVideo = useRef<HTMLVideoElement | null>(null)
  const bindVideo = useCallback((node: HTMLVideoElement | null) => { currentVideo.current = node; setVideo(node) }, [])

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
    activatedRef.current = false
    previewSeeked.current = false
    setActivated(false)
    setReady(false)
    setError(null)
    setAttempt(value => value + 1)
  }

  const player = <VideoPlayer>
    <Container className="media-skin media-container video-skin alook-video-player" data-theme="neutral" data-preset="video" data-active={activated || undefined}>
      <Video key={attempt} ref={bindVideo} src={attachment.url} preload="metadata" playsInline controls={false}
        data-testid={tid.mediaPlayer(attachment.name)} className="alook-video-element"
        onLoadedMetadata={event => {
          const media = event.currentTarget
          if (activatedRef.current || previewSeeked.current) return
          previewSeeked.current = true
          media.currentTime = Number.isFinite(media.duration) && media.duration > 0 ? Math.min(0.1, media.duration / 2) : 0.1
        }}
        onSeeked={() => setReady(true)}
        onLoadedData={() => { if (activatedRef.current) setReady(true) }}
        onPlay={() => { activatedRef.current = true; setActivated(true); setError(null) }}
        onError={() => setError("Couldn’t play this file")}
      />
      {!activated && !error && <button type="button" className="alook-video-start" aria-label={`Play video ${attachment.name}`} onClick={play}><Play /></button>}
      {!ready && !error && <span className="alook-video-notice" role="status">Loading media…</span>}
      {activated && <VideoControls attachment={attachment} expanded={expanded} onExpand={() => setExpanded(value => !value)} />}
      {error && <div className="alook-video-error"><p role="alert">{error}</p><button type="button" onClick={error.startsWith("Playback was blocked") ? play : retry} data-testid={tid.mediaRetry(attachment.name)}>{error.startsWith("Playback was blocked") ? "Try playing" : "Retry"} {attachment.name}</button></div>}
    </Container>
  </VideoPlayer>

  return <>
    <article data-testid={tid.mediaBlock(attachment.name)} data-media-kind="video" className="alook-video-attachment" style={{ aspectRatio: "16 / 9" }}>
      <div ref={setInlineSlot} className="alook-video-slot" />
    </article>
    {host && createPortal(player, host)}
    <Dialog open={expanded} onOpenChange={setExpanded}>
      <DialogContent className="alook-video-mask" aria-label={attachment.name} showCloseButton={false}
        initialFocus={() => host?.querySelector<HTMLButtonElement>('[aria-label="Shrink video"]') ?? false}
        finalFocus={() => host?.querySelector<HTMLButtonElement>('[aria-label="Expand video"]') ?? false}>
        <div ref={setMaskSlot} className="alook-video-slot" data-base-ui-swipe-ignore="" />
      </DialogContent>
    </Dialog>
  </>
}

export function VideoAttachmentBlock({ attachment }: { attachment: FileAttachment }) {
  return <VideoAttachmentSession key={`${attachment.url}\u0000${attachment.name}`} attachment={attachment} />
}
