import {
  MAX_ATTACHMENT_THUMBNAIL_EDGE_PX,
  MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES,
} from "@alook/shared"

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

export async function generateThumbnail(file: File): Promise<ThumbnailResult | null> {
  if (!isRasterImage(file)) return null

  let objectUrl: string | undefined
  try {
    objectUrl = URL.createObjectURL(file)
    const img = await loadImage(objectUrl)
    const { w, h } = fitWithin(img.naturalWidth, img.naturalHeight, LEGACY_MAX_SIZE)

    const blob = await renderJpeg(img, w, h, 0.7)
    if (!blob) return null
    return { blob, width: img.naturalWidth, height: img.naturalHeight }
  } catch {
    return null
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

export async function prepareCommunityImage(
  file: File,
): Promise<CommunityImagePreparation | null> {
  if (!COMMUNITY_RASTER_MIME_TYPES.has(file.type.toLowerCase())) return null

  let objectUrl: string | undefined
  let requiredThumbnail = file.size > MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES
  try {
    objectUrl = URL.createObjectURL(file)
    const img = await loadImage(objectUrl)
    const width = img.naturalWidth
    const height = img.naturalHeight
    requiredThumbnail = Math.max(width, height) > MAX_ATTACHMENT_THUMBNAIL_EDGE_PX
      || requiredThumbnail
    if (!requiredThumbnail) return { blob: null, width, height }

    const blob = await renderCommunityJpeg(img)
    if (!blob) throw new RequiredThumbnailError()
    return { blob, width, height }
  } catch (error) {
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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

function fitWithin(srcW: number, srcH: number, max: number) {
  if (srcW <= max && srcH <= max) return { w: srcW, h: srcH }
  const scale = Math.min(max / srcW, max / srcH)
  return { w: Math.round(srcW * scale), h: Math.round(srcH * scale) }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

function isRasterImage(file: File): boolean {
  return file.type.startsWith("image/") && file.type !== "image/svg+xml"
}

async function renderJpeg(
  img: HTMLImageElement,
  width: number,
  height: number,
  quality: number,
): Promise<Blob | null> {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, width, height)
  return canvasToBlob(canvas, "image/jpeg", quality)
}

async function renderCommunityJpeg(img: HTMLImageElement): Promise<Blob | null> {
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
      const blob = await canvasToBlob(canvas, "image/jpeg", quality)
      if (!blob) return null
      if (blob.size <= MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES) return blob
    }
  }
  return null
}
