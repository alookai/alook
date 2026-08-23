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

type OriginalStatus = "loading" | "decoded" | "ready" | "failed"
type ThumbnailStatus = "loading" | "ready" | "failed" | "absent"

type PreviewState = {
  dimensions?: ImageDimensions
  originalStatus: OriginalStatus
  thumbnailStatus: ThumbnailStatus
  requestKey: number
}

function PreviewFrame({ image }: { image: ImagePreview }) {
  const knownDimensions = useMemo(
    () => validImageDimensions(image.width, image.height),
    [image.height, image.width],
  )
  const [state, setState] = useState<PreviewState>({
    dimensions: knownDimensions,
    originalStatus: "loading",
    thumbnailStatus: image.thumbnailUrl ? "loading" : "absent",
    requestKey: 0,
  })

  const frameStyle = previewFrameStyle(state.dimensions)
  const originalReady = state.originalStatus === "ready"
  const thumbnailReady = state.thumbnailStatus === "ready"
  const previewVisible = state.thumbnailStatus !== "loading"

  useEffect(() => {
    if (state.originalStatus !== "decoded" || !previewVisible) return
    const requestKey = state.requestKey
    const frameId = requestAnimationFrame(() => {
      setState((current) => (
        current.requestKey === requestKey && current.originalStatus === "decoded"
          ? { ...current, originalStatus: "ready" }
          : current
      ))
    })
    return () => cancelAnimationFrame(frameId)
  }, [previewVisible, state.originalStatus, state.requestKey])

  const settleThumbnail = async (element: HTMLImageElement) => {
    try {
      await element.decode()
    } catch {
      setState((current) => ({ ...current, thumbnailStatus: "failed" }))
      return
    }

    const dimensions = validImageDimensions(element.naturalWidth, element.naturalHeight)
    setState((current) => ({
      ...current,
      dimensions: knownDimensions ?? dimensions ?? current.dimensions,
      thumbnailStatus: dimensions ? "ready" : "failed",
    }))
  }

  const failThumbnail = () => {
    setState((current) => ({ ...current, thumbnailStatus: "failed" }))
  }

  const revealDecodedOriginal = async (element: HTMLImageElement, requestKey: number) => {
    try {
      await element.decode()
    } catch {
      setState((current) => current.requestKey === requestKey
        ? { ...current, originalStatus: "failed" }
        : current)
      return
    }

    const naturalDimensions = validImageDimensions(element.naturalWidth, element.naturalHeight)
    setState((current) => {
      if (current.requestKey !== requestKey) return current
      return {
        ...current,
        dimensions: knownDimensions ?? naturalDimensions ?? current.dimensions,
        originalStatus: current.thumbnailStatus === "loading" ? "decoded" : "ready",
      }
    })
  }

  const failOriginal = (requestKey: number) => {
    setState((current) => current.requestKey === requestKey
      ? { ...current, originalStatus: "failed" }
      : current)
  }

  const retryOriginal = () => {
    setState((current) => ({
      ...current,
      originalStatus: "loading",
      requestKey: current.requestKey + 1,
    }))
  }

  return (
    <div className={`relative w-fit ${previewVisible ? "visible" : "invisible"}`}>
      <div
        data-testid={tid.imageLightbox}
        className="relative overflow-hidden rounded-lg bg-background"
        style={frameStyle}
      >
        {image.thumbnailUrl && (
          <img
            data-testid={tid.imageLightboxThumbnail}
            src={image.thumbnailUrl}
            alt={image.name}
            onLoad={(event) => { void settleThumbnail(event.currentTarget) }}
            onError={failThumbnail}
            className={`absolute inset-0 size-full rounded-lg object-contain transition-opacity duration-150 ease-out motion-reduce:transition-none ${thumbnailReady && !originalReady ? "opacity-100" : "opacity-0"}`}
          />
        )}
        {!thumbnailReady && previewVisible && !originalReady && (
          <div
            data-testid={tid.imageLightboxLoading}
            role="status"
            className="absolute inset-0 flex items-center justify-center px-4 text-sm text-muted-foreground"
          >
            Loading original image
          </div>
        )}
        {state.originalStatus !== "failed" && (
          <img
            key={state.requestKey}
            data-testid={tid.imageLightboxOriginal}
            src={image.originalUrl}
            alt={image.name}
            onLoad={(event) => { void revealDecodedOriginal(event.currentTarget, state.requestKey) }}
            onError={() => failOriginal(state.requestKey)}
            className={`pointer-events-none absolute inset-0 size-full rounded-lg object-contain transition-opacity duration-150 ease-out motion-reduce:transition-none ${originalReady ? "opacity-100" : "opacity-0"}`}
          />
        )}
      </div>
      {state.originalStatus === "failed" && (
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
