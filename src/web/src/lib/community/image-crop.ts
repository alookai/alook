import {
  MAX_ICON_SOURCE_FILE_SIZE_BYTES,
  ALLOWED_ICON_SOURCE_MIME_TYPES,
} from "@alook/shared"

export type CropPixels = { x: number; y: number; width: number; height: number }

/**
 * Client-side pre-cropper gate — shared by the server-icon, user-avatar, and
 * bot-avatar pickers. The server-side upload handlers re-validate with their
 * own (looser) size/MIME constants; this is just fast UX feedback before the
 * crop dialog even opens.
 */
export function validateIconSourceFile(file: File): { ok: true } | { ok: false; error: string } {
  if (file.size > MAX_ICON_SOURCE_FILE_SIZE_BYTES) {
    return { ok: false, error: `Image too large (max ${Math.floor(MAX_ICON_SOURCE_FILE_SIZE_BYTES / 1024 / 1024)}MB)` }
  }
  if (!(ALLOWED_ICON_SOURCE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, error: "Image must be PNG, JPEG, or WebP" }
  }
  return { ok: true }
}

/** Strips the original extension and appends `.webp` — the crop export is always WebP. */
export function deriveCroppedFileName(originalName: string): string {
  const dot = originalName.lastIndexOf(".")
  const base = dot > 0 ? originalName.slice(0, dot) : originalName
  return `${base}.webp`
}

/**
 * Browser-only canvas export: draws the cropped source rect into a fresh
 * `outputSize × outputSize` canvas and encodes as WebP. Mirrors the pattern
 * in `lib/image-thumbnail.ts`. Not unit-tested — no jsdom/canvas in this
 * repo's vitest env (same precedent as `image-thumbnail.ts`).
 */
export async function getCroppedIconBlob(
  imageSrc: string,
  cropPixels: CropPixels,
  outputSize: number,
): Promise<Blob | null> {
  const img = await loadImage(imageSrc)
  const canvas = document.createElement("canvas")
  canvas.width = outputSize
  canvas.height = outputSize
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  ctx.drawImage(
    img,
    cropPixels.x,
    cropPixels.y,
    cropPixels.width,
    cropPixels.height,
    0,
    0,
    outputSize,
    outputSize,
  )
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.9))
}

export function buildCroppedIconFile(blob: Blob, originalName: string): File {
  return new File([blob], deriveCroppedFileName(originalName), { type: "image/webp" })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}
