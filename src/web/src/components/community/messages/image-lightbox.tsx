"use client"

import { useEffect, useMemo, useState } from "react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import type { ImagePreview } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import {
  previewFrameStyle,
  type ImageDimensions,
  validImageDimensions,
} from "./image-lightbox-layout"
import { useRemoteImageAttempt } from "@/components/remote-image/remote-image-attempt"

function PreviewFrame({ image }: { image: ImagePreview }) {
  const knownDimensions = useMemo(
    () => validImageDimensions(image.width, image.height),
    [image.height, image.width],
  )
  const [dimensions, setDimensions] = useState<ImageDimensions | undefined>(knownDimensions)
  const [revealedAttempt, setRevealedAttempt] = useState<number | null>(null)
  const [
    thumbnailStatus,
    thumbnailAttempt,
    ,
    thumbnailRef,
    onThumbnailLoad,
    onThumbnailError,
  ] = useRemoteImageAttempt({ eligible: !!image.thumbnailUrl })
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
  const thumbnailSettled = !image.thumbnailUrl || thumbnailStatus !== "pending"
  const originalReady = originalStatus === "ready" && revealedAttempt === originalAttempt

  useEffect(() => {
    if (originalStatus !== "ready" || !originalImage || !thumbnailSettled) return
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
  }, [knownDimensions, originalAttempt, originalImage, originalStatus, thumbnailSettled])

  return (
    <div className="relative w-fit">
      <div
        data-testid={tid.imageLightbox}
        className="relative overflow-hidden rounded-lg bg-background"
        style={frameStyle}
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
            onLoad={onThumbnailLoad}
            onError={onThumbnailError}
            className={`absolute inset-0 size-full rounded-lg object-contain transition-opacity duration-150 ease-out motion-reduce:transition-none ${thumbnailReady && !originalReady ? "opacity-100" : "opacity-0"}`}
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
            onLoad={onOriginalLoad}
            onError={onOriginalError}
            className={`pointer-events-none absolute inset-0 size-full rounded-lg object-contain transition-opacity duration-150 ease-out motion-reduce:transition-none ${originalReady ? "opacity-100" : "opacity-0"}`}
          />
        )}
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
        className="flex max-h-[90vh] w-auto items-center justify-center border-none bg-transparent p-0 shadow-none sm:max-w-none"
        showCloseButton={false}
      >
        <PreviewFrame
          key={`${image.originalUrl}\u0000${image.thumbnailUrl ?? ""}\u0000${image.width ?? ""}\u0000${image.height ?? ""}`}
          image={image}
        />
      </DialogContent>
    </Dialog>
  )
}
