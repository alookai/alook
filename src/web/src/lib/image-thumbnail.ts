import {
  MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES,
} from "@alook/shared"
import { renderCommunityThumbnail, requiresCommunityThumbnail, type CommunityImagePreparation, type CommunityImageWorkerResult } from "./community-image-thumbnail"

export type { CommunityImagePreparation } from "./community-image-thumbnail"

const COMMUNITY_RASTER_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
])

class RequiredThumbnailError extends Error {}

export async function prepareCommunityImage(
  file: File,
  signal?: AbortSignal,
): Promise<CommunityImagePreparation | null> {
  if (!COMMUNITY_RASTER_MIME_TYPES.has(file.type.toLowerCase())) return null

  if (typeof Worker === "function" && typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function") {
    const response = await prepareInWorker(file, signal)
    if ("error" in response) throw new Error(response.error)
    if ("result" in response) return response.result
  }

  let objectUrl: string | undefined
  let requiredThumbnail = file.size > MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES
  try {
    objectUrl = URL.createObjectURL(file)
    const img = await loadImage(objectUrl, signal)
    const width = img.naturalWidth
    const height = img.naturalHeight
    requiredThumbnail = requiresCommunityThumbnail(file.size, width, height)
    if (!requiredThumbnail) return { blob: null, width, height }

    const blob = await renderCommunityThumbnail(width, height, (w, h) => {
      const canvas = document.createElement("canvas")
      canvas.width = w
      canvas.height = h
      const context = canvas.getContext("2d")
      if (!context) return null
      context.drawImage(img, 0, 0, w, h)
      return quality => canvasToBlob(canvas, "image/jpeg", quality, signal)
    }, signal)
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

function prepareInWorker(file: File, signal?: AbortSignal): Promise<CommunityImageWorkerResult> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    let worker: Worker
    try { worker = new Worker(new URL("./community-image.worker.ts", import.meta.url), { type: "module" }) }
    catch { resolve({ unsupported: true }); return }
    const cleanup = () => { signal?.removeEventListener("abort", abort); worker.terminate() }
    const abort = () => { cleanup(); reject(signal?.reason ?? new DOMException("Image preparation cancelled", "AbortError")) }
    signal?.addEventListener("abort", abort, { once: true })
    worker.onmessage = (event: MessageEvent<CommunityImageWorkerResult>) => { cleanup(); resolve(event.data) }
    worker.onerror = (event) => { event.preventDefault(); cleanup(); resolve({ unsupported: true }) }
    try { worker.postMessage(file) } catch { cleanup(); resolve({ unsupported: true }) }
  })
}

function loadImage(src: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const cleanup = () => { img.onload = null; img.onerror = null; signal?.removeEventListener("abort", abort) }
    const abort = () => { cleanup(); img.src = ""; reject(signal?.reason ?? new DOMException("Image preparation cancelled", "AbortError")) }
    img.onload = () => { cleanup(); resolve(img) }
    img.onerror = (error) => { cleanup(); reject(error) }
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) { abort(); return }
    img.src = src
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number, signal?: AbortSignal): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort)
    const abort = () => { cleanup(); reject(signal?.reason ?? new DOMException("Image preparation cancelled", "AbortError")) }
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) { abort(); return }
    canvas.toBlob((blob) => { cleanup(); if (!signal?.aborted) resolve(blob) }, type, quality)
  })
}
