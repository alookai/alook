import { isInlineAttachmentContentType } from "./community/attachment-content-type"

export async function readCommunityImageDimensions(file: File, signal?: AbortSignal): Promise<{ width: number; height: number } | null> {
  if (!isInlineAttachmentContentType(file.type)) return null
  signal?.throwIfAborted()
  const objectUrl = URL.createObjectURL(file)
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image()
      const cleanup = () => { image.onload = null; image.onerror = null; signal?.removeEventListener("abort", abort) }
      const abort = () => { cleanup(); image.src = ""; reject(signal?.reason ?? new DOMException("Image metadata cancelled", "AbortError")) }
      image.onload = () => { cleanup(); resolve({ width: image.naturalWidth, height: image.naturalHeight }) }
      image.onerror = () => { cleanup(); resolve(null) }
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) { abort(); return }
      image.src = objectUrl
    })
  } finally { URL.revokeObjectURL(objectUrl) }
}
