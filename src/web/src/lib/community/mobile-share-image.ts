import { tauriInvoke } from "@alook/shared"

export const MOBILE_SHARE_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const MOBILE_SHARE_IMAGE_CHUNK_BYTES = 49_152

export type MobileShareImageErrorCode =
  | "untrusted_caller"
  | "invalid_png"
  | "image_too_large"
  | "busy"
  | "permission_denied"
  | "cancelled"
  | "write_failed"
  | "unavailable"

export class MobileShareImageError extends Error {
  constructor(readonly code: MobileShareImageErrorCode, message: string) {
    super(message)
    this.name = "MobileShareImageError"
  }
}

export type MobileShareImageCopyResult = {
  attemptId: string
  status: "copied"
  destination: "clipboard"
}

export type MobileShareImageSaveResult = {
  attemptId: string
  status: "saved"
  destination: "photos" | "pictures" | "document"
}

function attemptId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const value = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

export function encodeMobileShareImageBytes(bytes: Uint8Array): string {
  const encoded: string[] = []
  for (let offset = 0; offset < bytes.length; offset += MOBILE_SHARE_IMAGE_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + MOBILE_SHARE_IMAGE_CHUNK_BYTES)
    let binary = ""
    for (let index = 0; index < chunk.length; index += 1) {
      binary += String.fromCharCode(chunk[index]!)
    }
    encoded.push(btoa(binary))
  }
  return encoded.join("")
}

function normalizeError(error: unknown): MobileShareImageError {
  if (error instanceof MobileShareImageError) return error
  if (typeof error === "object" && error !== null) {
    const value = error as { code?: unknown; message?: unknown }
    const allowed = new Set<MobileShareImageErrorCode>([
      "untrusted_caller",
      "invalid_png",
      "image_too_large",
      "busy",
      "permission_denied",
      "cancelled",
      "write_failed",
      "unavailable",
    ])
    if (typeof value.code === "string" && allowed.has(value.code as MobileShareImageErrorCode)) {
      return new MobileShareImageError(
        value.code as MobileShareImageErrorCode,
        typeof value.message === "string" ? value.message : "Native image operation failed",
      )
    }
  }
  return new MobileShareImageError("unavailable", "Native image operation is unavailable")
}

export async function saveMobileShareImage(
  blob: Blob,
  filename: string,
): Promise<MobileShareImageSaveResult> {
  return invokeMobileShareImage("mobile_share_image_save", blob, { filename }, (result, id) => (
    result?.attemptId === id
    && result.status === "saved"
    && ["photos", "pictures", "document"].includes(result.destination)
  ))
}

export async function copyMobileShareImage(blob: Blob): Promise<MobileShareImageCopyResult> {
  return invokeMobileShareImage("mobile_share_image_copy", blob, {}, (result, id) => (
    result?.attemptId === id
    && result.status === "copied"
    && result.destination === "clipboard"
  ))
}

async function invokeMobileShareImage<T extends MobileShareImageCopyResult | MobileShareImageSaveResult>(
  command: "mobile_share_image_copy" | "mobile_share_image_save",
  blob: Blob,
  extra: { filename?: string },
  accepts: (result: T, attemptId: string) => boolean,
): Promise<T> {
  if (blob.type !== "image/png") {
    throw new MobileShareImageError("invalid_png", "Image must be a PNG")
  }
  if (blob.size === 0) {
    throw new MobileShareImageError("invalid_png", "Image is empty")
  }
  if (blob.size > MOBILE_SHARE_IMAGE_MAX_BYTES) {
    throw new MobileShareImageError("image_too_large", "Image exceeds the mobile limit")
  }
  const id = attemptId()
  const start = performance.now()
  if (process.env.NODE_ENV !== "production") {
    console.debug(`mobile-share-image web dispatch attempt=${id} t=${start}`)
  }
  try {
    const result = await tauriInvoke<T>(command, {
      payload: {
        attemptId: id,
        pngBase64: encodeMobileShareImageBytes(new Uint8Array(await blob.arrayBuffer())),
        ...extra,
      },
    })
    if (!accepts(result, id)) {
      throw new MobileShareImageError("write_failed", "Native image result did not match the request")
    }
    return result
  } catch (error) {
    throw normalizeError(error)
  } finally {
    if (process.env.NODE_ENV !== "production") {
      console.debug(`mobile-share-image web settle attempt=${id} t=${performance.now()}`)
    }
  }
}
