"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";

import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ChevronLeftIcon, ChevronRightIcon, Download, MinusIcon, PlusIcon, RotateCcwIcon, XIcon } from "lucide-react"
import type { ImagePreview } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import {
  type ImageDimensions,
  isPointInsidePaintedImage,
  validImageDimensions,
} from "./image-lightbox-layout"
import { useRemoteImageAttempt } from "@/components/remote-image/remote-image-attempt"
import { useImageLightboxZoom } from "./image-lightbox-zoom"
import { attachmentImagePreviewUrl } from "@/lib/community/storage"
import { fileDownloadStatusText, useFileDownload } from "@/lib/file-download"

function PreviewFrame({ image, onClose, onNavigate, focusOnMount }: {
  image: ImagePreview; onClose: () => void; onNavigate?: (step: number, keyboard?: boolean) => void; focusOnMount?: boolean
}) {
  const displayUrl = attachmentImagePreviewUrl(image.originalUrl)
  const download = useFileDownload({ name: image.name, url: image.originalUrl })
  const downloadText = fileDownloadStatusText(download.state)
  const knownDimensions = useMemo(
    () => validImageDimensions(image.width, image.height),
    [image.height, image.width],
  )
  const [dimensions, setDimensions] = useAtom(useCreateAtom<ImageDimensions | undefined>(knownDimensions))
  const [
    thumbnailStatus,
    thumbnailAttempt,
    thumbnailImage,
    thumbnailRef,
    onThumbnailLoad,
    onThumbnailError,
  ] = useRemoteImageAttempt({ source: image.thumbnailUrl })
  const [
    originalStatus,
    originalAttempt,
    originalImage,
    originalRef,
    onOriginalLoad,
    onOriginalError,
    retryOriginal,
  ] = useRemoteImageAttempt({ source: displayUrl })

  const thumbnailReady = !!image.thumbnailUrl && thumbnailStatus === "ready"
  const originalReady = originalStatus === "ready"
  const { frameRef, view, reset, zoomIn, zoomOut, handlers } = useImageLightboxZoom(originalReady)
  const gestureRef = useRef<{ pointerId: number; x: number; y: number; suppressClose: boolean; swipe: boolean } | null>(null)
  const activePointersRef = useRef(new Set<number>())
  const imageStyle = {
    maxWidth: dimensions?.width,
    maxHeight: dimensions?.height,
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
  }

  useLayoutEffect(() => {
    if (focusOnMount) frameRef.current?.focus({ preventScroll: true })
  }, [focusOnMount, frameRef])

  useLayoutEffect(() => {
    if (originalStatus !== "ready" || !originalImage) return
    const naturalDimensions = validImageDimensions(originalImage.naturalWidth, originalImage.naturalHeight)
    setDimensions(knownDimensions ?? naturalDimensions)
  }, [knownDimensions, originalImage, originalStatus, setDimensions])

  function handleRootPointerDown(event: PointerEvent<HTMLDivElement>) {
    activePointersRef.current.add(event.pointerId)
    if (event.button !== 0 || activePointersRef.current.size > 1) {
      if (gestureRef.current) { gestureRef.current.suppressClose = true; gestureRef.current.swipe = false }
      return
    }
    gestureRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      suppressClose: false,
      swipe: event.pointerType === "touch" && view.scale === 1 && !!onNavigate && !(event.target as Element).closest('[role="toolbar"]'),
    }
  }

  function handleRootPointerMove(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 6) {
      gesture.suppressClose = true
    }
  }

  function handleRootPointerEnd(event: PointerEvent<HTMLDivElement>) {
    activePointersRef.current.delete(event.pointerId)
    const gesture = gestureRef.current
    if (event.type !== "pointerup" || !gesture?.swipe || gesture.pointerId !== event.pointerId) return
    const dx = event.clientX - gesture.x
    const dy = event.clientY - gesture.y
    if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      gesture.swipe = false
      reset()
      onNavigate?.(dx < 0 ? 1 : -1)
    }
  }

  function handleBackdropClick(event: MouseEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    gestureRef.current = null
    if (gesture?.suppressClose) return
    const target = event.target instanceof Element ? event.target : null
    if (
      target?.closest(
        `[role="toolbar"], [data-testid="${tid.imageLightboxLoading}"], [data-testid="${tid.imageLightboxError}"]`,
      )
    ) {
      return
    }
    const activeImage = originalReady
      ? originalImage
      : thumbnailReady
      ? thumbnailImage
      : null
    const bounds = frameRef.current?.getBoundingClientRect()
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      const natural =
        dimensions ?? validImageDimensions(activeImage?.naturalWidth, activeImage?.naturalHeight)
      if (
        activeImage
        && natural
        && isPointInsidePaintedImage({
          point: { x: event.clientX, y: event.clientY },
          frame: bounds,
          natural,
          maxDimensions: dimensions,
          view,
        })
      ) {
        return
      }
      onClose()
      return
    }
    if (activeImage && (target === activeImage || activeImage.contains(target))) return
    onClose()
  }

  return (
    <div
      className="relative flex size-full min-h-0 flex-col gap-2"
      onPointerDownCapture={handleRootPointerDown}
      onPointerMoveCapture={handleRootPointerMove}
      onPointerUpCapture={handleRootPointerEnd}
      onPointerCancelCapture={handleRootPointerEnd}
      onClick={handleBackdropClick}
    >
      <div
        role="toolbar"
        aria-label="Image controls"
        className="relative z-20 flex shrink-0 items-center gap-1 self-center rounded-lg border border-border bg-background p-1"
      >
        <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label="Zoom out" title="Zoom out" disabled={!originalReady} onClick={zoomOut}><MinusIcon /></Button>
        <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label="Fit image" title="Fit image" disabled={!originalReady || (view.scale === 1 && view.x === 0 && view.y === 0)} onClick={reset}><RotateCcwIcon /></Button>
        <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label="Zoom in" title="Zoom in" disabled={!originalReady} onClick={zoomIn}><PlusIcon /></Button>
        <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label={download.state.status === "downloading" ? "Cancel image download" : "Download original image"}
          onClick={() => download.state.status === "downloading" ? download.cancel() : void download.start()}><Download /></Button>
        <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label="Close image preview" title="Close" onClick={onClose}><XIcon /></Button>
      </div>
      <div
        ref={frameRef}
        data-testid={tid.imageLightbox}
        data-base-ui-swipe-ignore=""
        data-zoom-scale={view.scale}
        data-native-context-menu="true"
        role="region"
        aria-label={onNavigate ? "Image preview. Use left and right arrows to change image when fitted, plus and minus to zoom, arrow keys to pan when zoomed, and zero to fit." : "Image preview. Use plus and minus to zoom, arrow keys to pan, and zero to fit."}
        tabIndex={originalReady || onNavigate ? 0 : -1}
        className={`relative z-0 min-h-0 w-full flex-1 select-none overflow-visible ${originalReady ? "cursor-grab active:cursor-grabbing" : "cursor-default"}`}
        style={{ touchAction: originalReady ? "none" : undefined }}
        {...handlers}
        onKeyDown={event => {
          if (onNavigate && view.scale === 1 && !event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
            event.preventDefault()
            onNavigate(event.key === "ArrowRight" ? 1 : -1, true)
          } else handlers.onKeyDown(event)
        }}
      >
        {image.thumbnailUrl && (
          <img
            key={`thumbnail-${thumbnailAttempt}`}
            ref={thumbnailRef}
            data-testid={tid.imageLightboxThumbnail}
            data-remote-image-kind="content"
            data-remote-image-state={thumbnailStatus}
            src={image.thumbnailUrl}
            alt={image.name}
            draggable={false}
            style={imageStyle}
            onLoad={onThumbnailLoad}
            onError={onThumbnailError}
            className={`absolute inset-0 m-auto size-full rounded-lg object-contain ${thumbnailReady && !originalReady ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
          />
        )}
        {!thumbnailReady && !originalReady && originalStatus === "pending" && (
          <div
            data-testid={tid.imageLightboxLoading}
            role="status"
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-md bg-background px-3 py-2 text-sm text-muted-foreground motion-reduce:animate-none"
          >
            Loading image preview
          </div>
        )}
        {originalStatus !== "error" && (
          <img
            key={`original-${originalAttempt}`}
            ref={originalRef}
            data-testid={tid.imageLightboxOriginal}
            data-remote-image-kind="content"
            data-remote-image-state={originalStatus}
            src={displayUrl}
            alt={image.name}
            draggable={false}
            style={imageStyle}
            onLoad={onOriginalLoad}
            onError={onOriginalError}
            className={`absolute inset-0 m-auto size-full rounded-lg object-contain ${originalReady ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
          />
        )}
      </div>
      {originalStatus === "error" && (
        <div
          data-testid={tid.imageLightboxError}
          role="status"
          className="absolute bottom-3 left-1/2 z-10 flex min-h-11 w-max max-w-full -translate-x-1/2 items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm"
        >
          <span>Image cannot be processed. Retry or download the original.</span>
          <Button variant="ghost" size="sm"
            type="button"
            data-testid={tid.imageLightboxRetry}
            onClick={retryOriginal}
            className="h-12 min-w-12 rounded-md px-3 font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:min-w-0"
          >
            Retry
          </Button>
        </div>
      )}
      {downloadText && <p role={download.state.status === "error" ? "alert" : "status"} className="relative z-20 self-center rounded-md bg-background p-2 text-xs text-foreground">{downloadText}</p>}
    </div>
  )
}

function PreviewGallery({ image, onClose }: { image: ImagePreview; onClose: () => void }) {
  const images = image.images?.length ? image.images : [image]
  const initial = Math.max(0, images.findIndex(item => image.key ? item.key === image.key : item.originalUrl === image.originalUrl))
  const [index, setIndex] = useState(initial)
  const [focusOnMount, setFocusOnMount] = useState(false)
  const selected = images[index] ?? image
  const navigate = (step: number, keyboard = false) => {
    setFocusOnMount(keyboard)
    setIndex(current => Math.max(0, Math.min(images.length - 1, current + step)))
  }
  return <>
    <div className="min-h-0 flex-1">
      <PreviewFrame key={`${index}\u0000${selected.originalUrl}`} image={selected} onClose={onClose}
        onNavigate={images.length > 1 ? navigate : undefined} focusOnMount={focusOnMount} />
    </div>
    {images.length > 1 && <div role="toolbar" aria-label="Image navigation" className="relative z-20 flex shrink-0 items-center gap-2 self-center rounded-lg border border-border bg-background p-1">
      <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label="Previous image" title="Previous image" disabled={index === 0} onClick={() => navigate(-1)}><ChevronLeftIcon /></Button>
      <span role="status" aria-live="polite" aria-atomic="true" className="min-w-12 text-center text-sm tabular-nums" aria-label={`Image ${index + 1} of ${images.length}`}>{index + 1} / {images.length}</span>
      <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label="Next image" title="Next image" disabled={index === images.length - 1} onClick={() => navigate(1)}><ChevronRightIcon /></Button>
    </div>}
  </>
}

export function ImageLightbox({ image, onClose }: { image: ImagePreview | null; onClose: () => void }) {
  const popupRef = useRef<HTMLDivElement>(null)
  const [retained, setRetained] = useState(image)
  useLayoutEffect(() => { if (image) setRetained(image) }, [image])
  const displayed = image ?? retained
  if (!displayed) return null
  return (
    <Dialog open={image !== null} onOpenChange={(open) => { if (!open) onClose() }}
      onOpenChangeComplete={(open) => { if (!open) setRetained(null) }}>
      <DialogContent
        ref={popupRef}
        initialFocus={displayed.images && displayed.images.length > 1 ? () => popupRef.current?.querySelector<HTMLElement>(`[data-testid="${tid.imageLightbox}"]`) ?? false : undefined}
        aria-label={displayed.images && displayed.images.length > 1 ? "Image preview" : displayed.name}
        className="top-4 right-4 left-4 flex flex-col gap-2 h-[calc(100%-2rem)] w-auto max-w-none translate-x-0 translate-y-0 overflow-visible border-none bg-transparent p-0 shadow-none ring-0 sm:max-w-none"
        showCloseButton={false}
      >
        <PreviewGallery
          key={`${displayed.key ?? ""}\u0000${displayed.originalUrl}\u0000${displayed.thumbnailUrl ?? ""}\u0000${displayed.width ?? ""}\u0000${displayed.height ?? ""}`}
          image={displayed}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  )
}
