"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react"
import { flushSync } from "react-dom"
import {
  BufferingIndicator, Container, Controls, Gesture, Hotkey, Menu, MuteButton, PlaybackRateRadioGroup,
  PlayButton, StatusAnnouncer, Time, TimeSlider, VolumePopover, VolumeSlider,
  createPlayer, useDoubleTapGesture, useHotkey,
} from "@videojs/react"
import { videoFeatures } from "@videojs/react/video"
import {
  CheckIcon, FullscreenEnterIcon, FullscreenExitIcon, GearIcon, PauseIcon, PlayIcon, RestartIcon,
  SpinnerIcon, VolumeHighIcon, VolumeLowIcon, VolumeOffIcon,
} from "@videojs/react/icons/neutral"
import { CircleCheck, Download, LoaderCircle, RefreshCw } from "lucide-react"
import { fileDownloadStatusText, type useFileDownload } from "@/lib/file-download"
import { tid } from "@/lib/community/testids"
import "./videojs/neutral.css"
import "./videojs/attachment.css"

const { Player, usePlayer } = createPlayer({
  features: videoFeatures.filter(feature => feature.name !== undefined && ["playback", "playbackRate", "volume", "time", "source", "buffer", "controls", "error", "metadata"].includes(feature.name)),
  displayName: "AttachmentVideoPlayer",
})

export const AttachmentVideoPlayer = Player

function PlaybackButton({ name }: { name: string }) {
  return <PlayButton className="media-button media-play-button video-controls-play-button"
    label={state => `${state.ended ? "Replay" : state.paused ? "Play" : "Pause"} ${name}`}>
    <PlayIcon className="media-button-icon media-play-button-play-icon" />
    <PauseIcon className="media-button-icon media-play-button-pause-icon" />
    <RestartIcon className="media-button-icon media-play-button-restart-icon" />
  </PlayButton>
}

function subscribeHover(notify: () => void) {
  const query = window.matchMedia("(hover: hover)")
  query.addEventListener("change", notify)
  return () => query.removeEventListener("change", notify)
}

function readHover() { return window.matchMedia("(hover: hover)").matches }

function SoundControls({ name }: { name: string }) {
  const canHover = useSyncExternalStore(subscribeHover, readHover, () => false)
  return <VolumePopover.Root openOnHover={canHover} delay={200} closeDelay={100} side="right">
    <VolumePopover.Trigger render={<MuteButton className="media-button media-mute-button video-controls-volume-button"
      label={state => `${state.volumeLevel === "off" ? "Unmute" : "Mute"} ${name}`}>
      <VolumeHighIcon className="media-button-icon media-mute-button-high-icon" />
      <VolumeLowIcon className="media-button-icon media-mute-button-low-icon" />
      <VolumeOffIcon className="media-button-icon media-mute-button-off-icon" />
    </MuteButton>} />
    <VolumePopover.Popup className="media-popup media-popup-safe-area media-popup-transition media-popup-surface media-volume-popover">
      <VolumeSlider.Root className="media-slider media-volume-slider" orientation="horizontal" label={`Volume ${name}`}>
        <VolumeSlider.Track className="media-slider-track">
          <VolumeSlider.Fill className="media-slider-fill" />
        </VolumeSlider.Track>
        <VolumeSlider.Thumb className="media-slider-thumb" />
      </VolumeSlider.Root>
    </VolumePopover.Popup>
  </VolumePopover.Root>
}

function PlaybackSettings({ name }: { name: string }) {
  const volumeAvailability = usePlayer(state => state.volumeAvailability)
  return <Menu.Root side="top" align="end">
    <Menu.Trigger className="media-button media-settings-menu-trigger video-controls-settings-button" aria-label={`Video settings: ${name}`}>
      <GearIcon className="media-button-icon-base media-settings-menu-trigger-icon" />
    </Menu.Trigger>
    <Menu.Popup className="media-popup media-popup-surface media-menu-popup media-menu-resizable-popup">
      <Menu.Content className="media-menu-content">
        {volumeAvailability === "unsupported" && <p className="media-menu-group-label">Use your device’s volume buttons.</p>}
        <Menu.Group>
          <Menu.GroupLabel className="media-menu-group-label">Playback speed</Menu.GroupLabel>
          <PlaybackRateRadioGroup.Root>
            <PlaybackRateRadioGroup.Options renderItem={(props, state) => <Menu.RadioItem {...props} className="media-menu-radio-item">
              <span className="media-menu-item-label">{state.label}</span>
              <Menu.ItemIndicator className="media-menu-item-indicator"><CheckIcon className="media-menu-item-indicator-icon" /></Menu.ItemIndicator>
            </Menu.RadioItem>} />
          </PlaybackRateRadioGroup.Root>
        </Menu.Group>
      </Menu.Content>
    </Menu.Popup>
  </Menu.Root>
}

function PlayerInputs({ onExpand }: { onExpand: () => void }) {
  useHotkey({ keys: "f", repeatable: false, onActivate: onExpand })
  useDoubleTapGesture(onExpand, { region: "center" })
  return <>
    <Gesture type="tap" action="togglePaused" pointer="mouse" region="center" />
    <Gesture type="tap" action="toggleControls" pointer="touch" />
    <Gesture type="doubletap" action="seekStep" region="left" />
    <Gesture type="doubletap" action="seekStep" region="right" />
    <Hotkey keys="Space" action="togglePaused" />
    <Hotkey keys="k" action="togglePaused" />
    <Hotkey keys="m" action="toggleMuted" />
    <Hotkey keys="ArrowRight" action="seekStep" />
    <Hotkey keys="ArrowLeft" action="seekStep" />
    <Hotkey keys="ArrowUp" action="volumeStep" />
    <Hotkey keys="ArrowDown" action="volumeStep" />
  </>
}

export function VideoControls({ name, expanded, expandRef, playerRef, onExpand, download, forceVisible, children }: {
  name: string
  expanded: boolean
  expandRef: RefObject<HTMLButtonElement | null>
  playerRef: RefObject<HTMLVideoElement | null>
  onExpand: () => void
  download: ReturnType<typeof useFileDownload>
  forceVisible: boolean
  children: ReactNode
}) {
  const store = usePlayer()
  const controlsVisible = usePlayer(state => state.controlsVisible)
  const controlsRef = useRef<HTMLDivElement>(null)
  const keyboardRef = useRef(false)
  const movingFocusRef = useRef(false)
  const [keyboardFocus, setKeyboardFocus] = useAtom(useCreateAtom(false))
  const holdControls = forceVisible || keyboardFocus || download.state.status === "downloading" || download.state.status === "error"
  useEffect(() => holdControls ? store.requestControlsLock() : undefined, [holdControls, store])
  const visible = holdControls || controlsVisible
  useEffect(() => {
    if (visible || !controlsRef.current?.contains(document.activeElement)) return
    movingFocusRef.current = true
    playerRef.current?.focus({ preventScroll: true })
    movingFocusRef.current = false
  }, [visible, playerRef])
  const statusText = fileDownloadStatusText(download.state)
  const DownloadIcon = download.state.status === "downloading" ? LoaderCircle
    : download.state.status === "saved" || download.state.status === "started" ? CircleCheck
    : download.state.status === "error" ? RefreshCw : Download

  return <Container className="media-skin media-container video-skin alook-video-player"
    data-theme="neutral" data-preset="video" data-expanded={expanded ? "" : undefined} data-base-ui-swipe-ignore="" tabIndex={0}
    onPointerDownCapture={() => { keyboardRef.current = false; setKeyboardFocus(false) }}
    onKeyDownCapture={event => {
      keyboardRef.current = true
      setKeyboardFocus(controlsRef.current?.contains(event.target as Node) ?? false)
      if (event.key === "Tab") flushSync(() => { setKeyboardFocus(true); store.toggleControls(true) })
    }}
    onFocusCapture={event => {
      if (movingFocusRef.current) { event.stopPropagation(); return }
      setKeyboardFocus(keyboardRef.current && Boolean(controlsRef.current?.contains(event.target)))
    }}
    onBlurCapture={event => { if (!controlsRef.current?.contains(event.relatedTarget)) setKeyboardFocus(false) }}>
    {children}
    <BufferingIndicator className="media-buffering-indicator"><SpinnerIcon className="media-buffering-indicator-icon" /></BufferingIndicator>
    <Controls.Root visibility={holdControls ? "always" : "auto"}>
      <Controls.Backdrop className="video-controls-backdrop video-controls-compact-backdrop" />
      <Controls.Content ref={controlsRef} role="toolbar" aria-label={`Video controls: ${name}`} inert={!visible} aria-hidden={!visible}
        className="video-controls video-controls-content video-controls-wrap">
        <Controls.Group className="video-controls-start">
          <PlaybackButton name={name} />
          <SoundControls name={name} />
        </Controls.Group>
        <Controls.Group className="video-time-slider-group">
          <TimeSlider.Root className="media-slider media-time-slider" label={`Seek ${name}`} data-testid={tid.videoSeek(name)}>
            <TimeSlider.Track className="media-slider-track">
              <TimeSlider.Buffer className="media-slider-buffer" />
              <TimeSlider.Fill className="media-slider-fill" />
            </TimeSlider.Track>
            <TimeSlider.Thumb className="media-slider-thumb media-time-slider-thumb" />
          </TimeSlider.Root>
          <Time.Group className="media-time-group attachment-video-time">
            <Time.Value className="media-time-toggle" type="current" toggle />
            <Time.Separator className="media-time-separator" />
            <Time.Value className="media-time-duration-value" type="duration" />
          </Time.Group>
        </Controls.Group>
        <Controls.Group className="video-controls-end">
          <PlaybackSettings name={name} />
          <Controls.Group className="video-controls-trailing">
            <button type="button" className="media-button" data-testid={tid.mediaDownload(name)}
              aria-label={`${download.state.status === "downloading" ? "Cancel download" : download.state.status === "error" ? "Retry download" : "Download"} ${name}`}
              aria-busy={download.state.status === "downloading"}
              onClick={() => download.state.status === "downloading" ? download.cancel() : void download.start()}>
              <DownloadIcon className={`media-button-icon${download.state.status === "downloading" ? " animate-spin motion-reduce:animate-none" : ""}`} />
            </button>
            <button type="button" ref={expandRef} className="media-button video-controls-fullscreen-button"
              data-testid={tid.videoFullscreen(name)} aria-label={`${expanded ? "Shrink" : "Expand"} ${name}`} onClick={onExpand}>
              {expanded ? <FullscreenExitIcon className="media-button-icon" /> : <FullscreenEnterIcon className="media-button-icon" />}
            </button>
          </Controls.Group>
        </Controls.Group>
        {statusText && <p role={download.state.status === "error" ? "alert" : "status"} className="attachment-video-download-status">{statusText}</p>}
      </Controls.Content>
    </Controls.Root>
    <PlayerInputs onExpand={onExpand} />
    <StatusAnnouncer className="media-status-announcer" />
  </Container>
}
