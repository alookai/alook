"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";

import { useEffect, useMemo } from "react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { MinusIcon, PlusIcon, RotateCcwIcon, XIcon } from "lucide-react"
import type { ImagePreview } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import {
  previewFrameStyle,
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
  const [revealedAttempt, setRevealedAttempt] = useAtom(useCreateAtom<number | null>(null))
  const [
    thumbnailStatus,
    thumbnailAttempt,
    ,
    thumbnailRef,
    onThumbnailLoad,
    onThumbnailError,
  ] = useRemoteImageAttempt()
  const [
    originalStatus,
    originalAttempt,
    originalImage,
    originalRef,
    onOriginalLoad,
    onOriginalError,
    retryOriginal,
  ] = useRemoteImageAttempt()

  const frameStyle = previewFrameStyle(dimensions)
  const thumbnailReady = !!image.thumbnailUrl && thumbnailStatus === "ready"
  const originalReady = originalStatus === "ready" && revealedAttempt === originalAttempt
  const { frameRef, view, reset, zoomIn, zoomOut, handlers } = useImageLightboxZoom(originalReady)
  const imageTransform = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }

  useEffect(() => {
    if (originalStatus !== "ready" || !originalImage) return
    const requestKey = originalAttempt
    const naturalDimensions = validImageDimensions(originalImage.naturalWidth, originalImage.naturalHeight)
    const reveal = () => {
      setDimensions(knownDimensions ?? naturalDimensions)
      setRevealedAttempt(requestKey)
    }
    if (typeof requestAnimationFrame !== "function") {
      reveal()
      return
    }
    const frameId = requestAnimationFrame(reveal)
    return () => cancelAnimationFrame(frameId)
  }, [knownDimensions, originalAttempt, originalImage, originalStatus, setDimensions, setRevealedAttempt])

  return (
    <div className="relative w-fit">
      <div
        ref={frameRef}
        data-testid={tid.imageLightbox}
        data-zoom-scale={view.scale}
        data-native-context-menu="true"
        role="region"
        aria-label="Image preview. Use plus and minus to zoom, arrow keys to pan, and zero to fit."
        tabIndex={originalReady ? 0 : -1}
        className={`relative select-none overflow-hidden rounded-lg bg-background ${view.scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-default"}`}
        style={{ ...frameStyle, touchAction: originalReady ? "none" : undefined }}
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
            style={imageTransform}
            onLoad={onThumbnailLoad}
            onError={onThumbnailError}
            className={`absolute inset-0 size-full rounded-lg object-contain transition-opacity duration-150 ease-out motion-reduce:transition-none ${thumbnailReady && !originalReady ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
          />
        )}
        {!thumbnailReady && !originalReady && originalStatus === "pending" && (
          <div
            data-testid={tid.imageLightboxLoading}
            role="status"
            className="absolute inset-0 flex animate-pulse items-center justify-center bg-muted/70 px-4 text-sm text-muted-foreground motion-reduce:animate-none"
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
            style={imageTransform}
            onLoad={onOriginalLoad}
            onError={onOriginalError}
            className={`absolute inset-0 size-full rounded-lg object-contain transition-opacity duration-150 ease-out motion-reduce:transition-none ${originalReady ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
          />
        )}
      </div>
      <div
        role="toolbar"
        aria-label="Image controls"
        className="absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-background p-1"
        style={{ top: "calc(50% - 50vh + 12px)" }}
      >
        <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label="Zoom out" title="Zoom out" disabled={!originalReady || view.scale <= 1} onClick={zoomOut}><MinusIcon /></Button>
        <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label="Fit image" title="Fit image" disabled={!originalReady || view.scale === 1} onClick={reset}><RotateCcwIcon /></Button>
        <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label="Zoom in" title="Zoom in" disabled={!originalReady || view.scale >= 8} onClick={zoomIn}><PlusIcon /></Button>
        <Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label="Close image preview" title="Close" onClick={onClose}><XIcon /></Button>
      </div>
      {originalStatus === "error" && (
        <div
          data-testid={tid.imageLightboxError}
          role="status"
          className="absolute bottom-3 left-1/2 z-10 flex min-h-11 w-max max-w-[min(90vw,24rem)] -translate-x-1/2 items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm"
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
        className="flex max-h-[90vh] w-auto items-center justify-center border-none bg-transparent p-0 shadow-none sm:max-w-none"
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
