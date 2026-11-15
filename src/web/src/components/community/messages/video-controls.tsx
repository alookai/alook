"use client"

import { useId, type RefObject } from "react"
import { CircleCheck, Download, LoaderCircle, Maximize2, Minimize2, Pause, Play, RefreshCw, Settings2, Volume2, VolumeX } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Slider, SliderControl, SliderRange, SliderThumb, SliderTrack } from "@/components/ui/slider"
import { fileDownloadStatusText, type useFileDownload } from "@/lib/file-download"
import { tid } from "@/lib/community/testids"

export type VideoControlState = {
  time: number
  duration: number
  paused: boolean
  muted: boolean
  volume: number
  rate: number
  volumeAdjustable: boolean
}

function mediaTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "--:--"
  const time = Math.max(0, Math.floor(seconds))
  return `${Math.floor(time / 60)}:${String(time % 60).padStart(2, "0")}`
}

export function VideoControls({ name, expanded, expandRef, onExpand, download, playback }: {
  name: string
  expanded: boolean
  expandRef: RefObject<HTMLButtonElement | null>
  onExpand: () => void
  download: ReturnType<typeof useFileDownload>
  playback?: {
    state: VideoControlState
    onToggle: () => void
    onSeek: (time: number) => void
    onMute: () => void
    onVolume: (volume: number) => void
    onRate: (rate: number) => void
  }
}) {
  const rateId = useId()
  const statusText = fileDownloadStatusText(download.state)
  const DownloadIcon = download.state.status === "downloading" ? LoaderCircle
    : download.state.status === "saved" || download.state.status === "started" ? CircleCheck
    : download.state.status === "error" ? RefreshCw : Download
  const state = playback?.state
  const seekable = state && Number.isFinite(state.duration) && state.duration > 0

  return <div role="toolbar" aria-label={`Video controls: ${name}`} data-base-ui-swipe-ignore=""
    className={`${playback ? "relative shrink-0" : "absolute inset-x-0 bottom-0"} z-10 bg-background/95 p-1 text-foreground`}>
    {playback && state && <div className="flex min-h-8 items-center gap-2 px-2">
      <Slider aria-label={`Seek ${name}`} className="min-w-0 flex-1" min={0} max={seekable ? state.duration : 1}
        step={0.1} value={seekable ? Math.min(state.time, state.duration) : 0} disabled={!seekable}
        onValueChange={value => playback.onSeek(value as number)}>
        <SliderControl className="min-h-11" data-testid={tid.videoSeek(name)}><SliderTrack><SliderRange /><SliderThumb
          getAriaLabel={() => `Seek ${name}`} getAriaValueText={(_, value) => mediaTime(value)} /></SliderTrack></SliderControl>
      </Slider>
      <span className="shrink-0 text-xs tabular-nums">{mediaTime(state.time)} / {seekable ? mediaTime(state.duration) : "--:--"}</span>
    </div>}
    <div className="flex items-center">
      {playback && state && <>
        <Button variant="ghost" size="icon" className="size-11 shrink-0" aria-label={`${state.paused ? "Play" : "Pause"} ${name}`}
          onClick={playback.onToggle}>{state.paused ? <Play /> : <Pause />}</Button>
        <Button variant="ghost" size="icon" className="size-11 shrink-0" aria-label={`${state.muted || state.volume === 0 ? "Unmute" : "Mute"} ${name}`}
          onClick={playback.onMute}>{state.muted || state.volume === 0 ? <VolumeX /> : <Volume2 />}</Button>
      </>}
      <div className="flex-1" />
      {playback && state && <Popover>
        <PopoverTrigger render={<Button variant="ghost" size="icon" className="size-11 shrink-0" aria-label={`Video settings: ${name}`} />}><Settings2 /></PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-60 space-y-3 p-3">
          {state.volumeAdjustable ? <><div className="text-sm">Volume</div>
          <Slider aria-label={`Volume ${name}`} min={0} max={1} step={0.05} value={state.muted ? 0 : state.volume}
            onValueChange={value => playback.onVolume(value as number)}>
            <SliderControl className="min-h-11"><SliderTrack><SliderRange /><SliderThumb getAriaLabel={() => `Volume ${name}`} /></SliderTrack></SliderControl>
          </Slider></> : <p className="text-sm text-muted-foreground">Use your device’s volume buttons.</p>}
          <label htmlFor={rateId} className="block text-sm">Playback speed</label>
          <select id={rateId} className="min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={state.rate} onChange={event => playback.onRate(Number(event.target.value))}>
            {[0.5, 1, 1.25, 1.5, 2].map(rate => <option key={rate} value={rate}>{rate}×</option>)}
          </select>
        </PopoverContent>
      </Popover>}
      <Button variant="ghost" size="icon" className="size-11 shrink-0" data-testid={tid.mediaDownload(name)}
        aria-label={`${download.state.status === "downloading" ? "Cancel download" : download.state.status === "error" ? "Retry download" : "Download"} ${name}`}
        aria-busy={download.state.status === "downloading"}
        onClick={() => download.state.status === "downloading" ? download.cancel() : void download.start()}>
        <DownloadIcon className={download.state.status === "downloading" ? "animate-spin motion-reduce:animate-none" : undefined} />
      </Button>
      <Button ref={expandRef} variant="ghost" size="icon" className="size-11 shrink-0" data-testid={tid.videoFullscreen(name)}
        aria-label={`${expanded ? "Shrink" : "Expand"} ${name}`} onClick={onExpand}>{expanded ? <Minimize2 /> : <Maximize2 />}</Button>
    </div>
    {statusText && <p role={download.state.status === "error" ? "alert" : "status"} className="px-2 pb-1 text-xs">{statusText}</p>}
  </div>
}
