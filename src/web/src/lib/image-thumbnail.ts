import {
  MAX_ATTACHMENT_THUMBNAIL_EDGE_PX,
  MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES,
} from "@alook/shared"
import { observeImage } from "./observability/images"
import { telemetryGeneration } from "./observability/telemetry"

const LEGACY_MAX_SIZE = 200
const COMMUNITY_QUALITIES = [0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]
const COMMUNITY_DIMENSION_ATTEMPTS = 10
const COMMUNITY_DIMENSION_SCALE = 0.85
const COMMUNITY_RASTER_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
])

class RequiredThumbnailError extends Error {}

export type ThumbnailResult = { blob: Blob; width: number; height: number }
export type CommunityImagePreparation = { blob: Blob | null; width: number; height: number }

export async function generateThumbnail(file: File, signal?: AbortSignal): Promise<ThumbnailResult | null> {
  const generation = telemetryGeneration()
  if (!isRasterImage(file)) return null

  let objectUrl: string | undefined
  try {
    objectUrl = URL.createObjectURL(file)
    const img = await loadImage(objectUrl, signal, generation)
    const { w, h } = fitWithin(img.naturalWidth, img.naturalHeight, LEGACY_MAX_SIZE)

    const blob = await renderJpeg(img, w, h, 0.7, signal, generation)
    if (!blob) return null
    return { blob, width: img.naturalWidth, height: img.naturalHeight }
  } catch (error) {
    if (signal?.aborted) throw error
    return null
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

export async function prepareCommunityImage(
  file: File,
  signal?: AbortSignal,
): Promise<CommunityImagePreparation | null> {
  const generation = telemetryGeneration()
  if (!COMMUNITY_RASTER_MIME_TYPES.has(file.type.toLowerCase())) return null

  let objectUrl: string | undefined
  let requiredThumbnail = file.size > MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES
  try {
    objectUrl = URL.createObjectURL(file)
    const img = await loadImage(objectUrl, signal, generation)
    const width = img.naturalWidth
    const height = img.naturalHeight
    requiredThumbnail = Math.max(width, height) > MAX_ATTACHMENT_THUMBNAIL_EDGE_PX
      || requiredThumbnail
    if (!requiredThumbnail) return { blob: null, width, height }

    const blob = await renderCommunityJpeg(img, signal, generation)
    if (!blob) throw new RequiredThumbnailError()
    return { blob, width, height }
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof RequiredThumbnailError) {
      throw new Error("could not generate a required image preview")
    }
    if (requiredThumbnail) {
      throw new Error("could not generate a required image preview")
    }
    return null
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

function loadImage(src: string, signal: AbortSignal | undefined, generation: number): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const record = (phase: Parameters<typeof observeImage>[2]) => { if (generation === telemetryGeneration()) observeImage(img, "thumbnail_prepare", phase, img) }
    const cleanup = () => { img.onload = null; img.onerror = null; signal?.removeEventListener("abort", abort) }
    const abort = () => { record("abort"); cleanup(); img.src = ""; reject(signal?.reason ?? new DOMException("Image preparation cancelled", "AbortError")) }
    img.onload = () => { record("load"); cleanup(); resolve(img) }
    img.onerror = (error) => { record("error"); cleanup(); reject(error) }
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) { abort(); return }
    img.src = src
    record("source_change")
  })
}

function fitWithin(srcW: number, srcH: number, max: number) {
  if (srcW <= max && srcH <= max) return { w: srcW, h: srcH }
  const scale = Math.min(max / srcW, max / srcH)
  return { w: Math.round(srcW * scale), h: Math.round(srcH * scale) }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number, signal: AbortSignal | undefined, generation: number, image: HTMLImageElement): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    const record = (phase: Parameters<typeof observeImage>[2]) => { if (generation === telemetryGeneration()) observeImage(image, "thumbnail_prepare", phase, image) }
    record("encode_start")
    const cleanup = () => signal?.removeEventListener("abort", abort)
    const abort = () => { record("abort"); cleanup(); reject(signal?.reason ?? new DOMException("Image preparation cancelled", "AbortError")) }
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) { abort(); return }
    canvas.toBlob((blob) => { cleanup(); if (!signal?.aborted) { record(blob ? "encode_ready" : "encode_error"); resolve(blob) } }, type, quality)
  })
}

function isRasterImage(file: File): boolean {
  return file.type.startsWith("image/") && file.type !== "image/svg+xml"
}

async function renderJpeg(
  img: HTMLImageElement,
  width: number,
  height: number,
  quality: number,
  signal: AbortSignal | undefined,
  generation: number,
): Promise<Blob | null> {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, width, height)
  return canvasToBlob(canvas, "image/jpeg", quality, signal, generation, img)
}

async function renderCommunityJpeg(img: HTMLImageElement, signal: AbortSignal | undefined, generation: number): Promise<Blob | null> {
  const fitted = fitWithin(
    img.naturalWidth,
    img.naturalHeight,
    MAX_ATTACHMENT_THUMBNAIL_EDGE_PX,
  )
  for (let attempt = 0; attempt < COMMUNITY_DIMENSION_ATTEMPTS; attempt++) {
    const scale = COMMUNITY_DIMENSION_SCALE ** attempt
    const width = Math.max(1, Math.round(fitted.w * scale))
    const height = Math.max(1, Math.round(fitted.h * scale))
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, width, height)
    for (const quality of COMMUNITY_QUALITIES) {
      const blob = await canvasToBlob(canvas, "image/jpeg", quality, signal, generation, img)
      if (!blob) return null
      if (blob.size <= MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES) return blob
    }
  }
  return null
}
