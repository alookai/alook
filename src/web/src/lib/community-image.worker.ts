import { MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES } from "@alook/shared/constants/community"
import { renderCommunityThumbnail, requiresCommunityThumbnail, type CommunityImageWorkerResult } from "./community-image-thumbnail"

self.addEventListener("message", async (event: MessageEvent<File>) => {
  const respond = (message: CommunityImageWorkerResult) => self.postMessage(message)
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function" || typeof OffscreenCanvas.prototype.convertToBlob !== "function") {
    respond({ unsupported: true })
    return
  }
  const file = event.data
  let bitmap: ImageBitmap | undefined
  let required = file.size > MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES
  try {
    bitmap = await createImageBitmap(file)
    const { width, height } = bitmap
    required = requiresCommunityThumbnail(file.size, width, height)
    const source = bitmap
    const blob = required ? await renderCommunityThumbnail(width, height, (w, h) => {
      const canvas = new OffscreenCanvas(w, h)
      const context = canvas.getContext("2d")
      if (!context) return null
      context.drawImage(source, 0, 0, w, h)
      return quality => canvas.convertToBlob({ type: "image/jpeg", quality })
    }) : null
    if (required && !blob) throw new Error("could not generate a required image preview")
    respond({ result: { blob, width, height } })
  } catch {
    respond(required ? { error: "could not generate a required image preview" } : { result: null })
  } finally {
    bitmap?.close()
  }
})
