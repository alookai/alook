"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";

import { useLayoutEffect, useMemo } from "react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { MinusIcon, PlusIcon, RotateCcwIcon, XIcon } from "lucide-react"
import type { ImagePreview } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import {
  type ImageDimensions,
  validImageDimensions,
} from "./image-lightbox-layout"
import { useRemoteImageAttempt } from "@/components/remote-image/remote-image-attempt"
import { useImageLightboxZoom } from "./image-lightbox-zoom"

function PreviewFrame({ image, onClose }: { image: ImagePreview; onClose: () => void }) {
  const knownDimensions = useMemo(
    () => validImageDimensions(image.width, image.height),
    [image.height, image.width],
  )
  const [dimensions, setDimensions] = useAtom(useCreateAtom<ImageDimensions | undefined>(knownDimensions))
  const [
    thumbnailStatus,
    thumbnailAttempt,
    ,
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
  ] = useRemoteImageAttempt({ source: image.originalUrl })

  const thumbnailReady = !!image.thumbnailUrl && thumbnailStatus === "ready"
  const originalReady = originalStatus === "ready"
  const { frameRef, view, reset, zoomIn, zoomOut, handlers } = useImageLightboxZoom(originalReady)
  const imageStyle = {
    maxWidth: dimensions?.width,
    maxHeight: dimensions?.height,
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
  }

  useLayoutEffect(() => {
    if (originalStatus !== "ready" || !originalImage) return
    const naturalDimensions = validImageDimensions(originalImage.naturalWidth, originalImage.naturalHeight)
    setDimensions(knownDimensions ?? naturalDimensions)
  }, [knownDimensions, originalImage, originalStatus, setDimensions])

  return (
    <div className="relative flex size-full min-h-0 flex-col gap-2">
      <div
        role="toolbar"
        aria-label="Image controls"
        className="relative z-20 flex shrink-0 items-center gap-1 self-center rounded-lg border border-border bg-background p-1"
      >
        <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label="Zoom out" title="Zoom out" disabled={!originalReady} onClick={zoomOut}><MinusIcon /></Button>
        <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label="Fit image" title="Fit image" disabled={!originalReady || (view.scale === 1 && view.x === 0 && view.y === 0)} onClick={reset}><RotateCcwIcon /></Button>
        <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label="Zoom in" title="Zoom in" disabled={!originalReady} onClick={zoomIn}><PlusIcon /></Button>
        <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label="Close image preview" title="Close" onClick={onClose}><XIcon /></Button>
      </div>
      <div
        ref={frameRef}
        data-testid={tid.imageLightbox}
        data-zoom-scale={view.scale}
        data-native-context-menu="true"
        role="region"
        aria-label="Image preview. Use plus and minus to zoom, arrow keys to pan, and zero to fit."
        tabIndex={originalReady ? 0 : -1}
        className={`relative z-0 min-h-0 w-full flex-1 select-none overflow-visible ${originalReady ? "cursor-grab active:cursor-grabbing" : "cursor-default"}`}
        style={{ touchAction: originalReady ? "none" : undefined }}
        {...handlers}
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
            Loading original image
          </div>
        )}
        {originalStatus !== "error" && (
          <img
            key={`original-${originalAttempt}`}
            ref={originalRef}
            data-testid={tid.imageLightboxOriginal}
            data-remote-image-kind="content"
            data-remote-image-state={originalStatus}
            src={image.originalUrl}
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
          <span>Failed to load original image</span>
          <button
            type="button"
            data-testid={tid.imageLightboxRetry}
            onClick={retryOriginal}
            className="h-12 min-w-12 rounded-md px-3 font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:min-w-0"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  )
}

export function ImageLightbox({ image, onClose }: { image: ImagePreview; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        aria-label={image.name}
        className="top-[max(1rem,env(safe-area-inset-top))] right-[max(1rem,env(safe-area-inset-right))] left-[max(1rem,env(safe-area-inset-left))] flex h-[calc(100dvh_-_max(1rem,env(safe-area-inset-top))_-_max(1rem,env(safe-area-inset-bottom)))] w-auto max-w-none translate-x-0 translate-y-0 overflow-visible border-none bg-transparent p-0 shadow-none ring-0 sm:max-w-none"
        showCloseButton={false}
      >
        <PreviewFrame
          key={`${image.originalUrl}\u0000${image.thumbnailUrl ?? ""}\u0000${image.width ?? ""}\u0000${image.height ?? ""}`}
          image={image}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  )
}
