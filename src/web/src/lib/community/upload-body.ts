import { MAX_ATTACHMENT_SIZE_BYTES, MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES } from "@alook/shared"

export class UploadTooLargeError extends Error {}

export async function readUploadFormData(request: Request): Promise<FormData> {
  const maxBytes = MAX_ATTACHMENT_SIZE_BYTES + MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES + 64 * 1024
  if (Number(request.headers.get("content-length")) > maxBytes) throw new UploadTooLargeError()
  let bytes = 0
  let exceeded = false
  const body = request.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength
      if (bytes > maxBytes) {
        exceeded = true
        throw new UploadTooLargeError()
      }
      controller.enqueue(chunk)
    },
  }))
  try {
    return await new Response(body, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData()
  } catch (error) {
    if (exceeded) throw new UploadTooLargeError()
    throw error
  }
}
